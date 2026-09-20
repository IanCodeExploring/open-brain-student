// backfill-links: one-time (re-runnable) sweep that creates graph links for
// thoughts that already have an embedding but haven't been checked for
// neighbors yet - saved before thought_links existed, or added by a backfill
// that ran before this one.

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceKey)

    const body = await req.json().catch(() => ({}))
    const batchSize = Number(body.batch_size ?? 3)
    const offset = Number(body.offset ?? 0)

    // Thoughts with an embedding, oldest first, paged with a real offset.
    // Unlike backfill-embeddings, this is safe to page with offset: a
    // thought having links (or not) doesn't change whether it matches
    // "embedding is not null", so the underlying result set doesn't shrink
    // out from under us as we process it.
    const { data: thoughts, error: fetchError } = await supabase
      .from('thoughts')
      .select('id, user_id, embedding')
      .not('embedding', 'is', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + batchSize - 1)

    if (fetchError) {
      return json({ error: fetchError.message }, 500)
    }

    let linked = 0
    let alreadyDone = 0

    for (const thought of thoughts ?? []) {
      // Skip if this thought already has links in either direction.
      const { count: existingLinks } = await supabase
        .from('thought_links')
        .select('id', { count: 'exact', head: true })
        .or(`source_thought_id.eq.${thought.id},target_thought_id.eq.${thought.id}`)

      if (existingLinks && existingLinks > 0) {
        alreadyDone++
        continue
      }

      const { data: neighbors, error: rpcError } = await supabase.rpc('find_links_for_thought', {
        source_id: thought.id,
        source_embedding: thought.embedding,
        p_user_id: thought.user_id,
        match_threshold: 0.5,
        match_count: 5,
      })

      if (rpcError) {
        console.error('find_links_for_thought failed for', thought.id, rpcError)
        continue
      }

      if (neighbors && neighbors.length > 0) {
        const links = neighbors.map((n: { target_id: string; similarity: number }) => ({
          source_thought_id: thought.id,
          target_thought_id: n.target_id,
          user_id: thought.user_id,
          similarity_score: n.similarity,
          link_type: 'semantic',
        }))

        const { error: insertError } = await supabase
          .from('thought_links')
          .upsert(links, { onConflict: 'source_thought_id,target_thought_id', ignoreDuplicates: true })

        if (insertError) {
          console.error('thought_links upsert failed for', thought.id, insertError)
        } else {
          linked++
        }
      }
    }

    const processed = thoughts?.length ?? 0

    const { count: totalWithEmbedding } = await supabase
      .from('thoughts')
      .select('id', { count: 'exact', head: true })
      .not('embedding', 'is', null)

    const remaining = Math.max((totalWithEmbedding ?? 0) - (offset + processed), 0)

    return json({
      processed,
      linked,
      already_done: alreadyDone,
      offset_next: offset + batchSize,
      remaining,
    })
  } catch (e) {
    console.error('backfill-links error', e)
    return json({ error: String(e) }, 500)
  }
})
