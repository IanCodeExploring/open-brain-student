// backfill-embeddings: one-time (well, re-runnable) sweep that generates
// embeddings for thoughts that don't have one yet - saved before the
// embedding column existed, or saved and skipped it for some other reason.
//
// Call it repeatedly with increasing `offset` until `remaining` is 0. A small
// batch_size keeps each call fast and avoids hitting the embedding
// provider's rate limits.

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
    const batchSize = Number(body.batch_size ?? 5)
    const offset = Number(body.offset ?? 0)

    // Deliberately NOT using `offset` to page through this query. Every
    // thought this loop embeds gets its `embedding` filled in, so it drops
    // out of the "is null" set on its own - the next call's first N rows are
    // already the next unprocessed ones. Paging with offset on a shrinking
    // result set would skip thoughts (offset N would skip N thoughts that
    // were never actually seen). `offset` is kept in the request/response
    // shape only so the calling loop has something to increment and log.
    const { data: thoughts, error: fetchError } = await supabase
      .from('thoughts')
      .select('id, content')
      .is('embedding', null)
      .order('created_at', { ascending: true })
      .limit(batchSize)

    if (fetchError) {
      return json({ error: fetchError.message }, 500)
    }

    let embedded = 0
    let failed = 0

    for (const thought of thoughts ?? []) {
      try {
        const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ text: thought.content }),
        })
        const { embedding } = await embRes.json()

        if (embedding) {
          const { error: updateError } = await supabase
            .from('thoughts')
            .update({ embedding })
            .eq('id', thought.id)
          if (updateError) {
            console.error('update failed for', thought.id, updateError)
            failed++
          } else {
            embedded++
          }
        } else {
          failed++
        }
      } catch (e) {
        console.error('embedding failed for', thought.id, e)
        failed++
      }
    }

    const processed = thoughts?.length ?? 0

    // Recount after processing (rather than subtracting embedded from a
    // before-count) so a thought that failed and is still null is correctly
    // still counted as remaining.
    const { count: remaining } = await supabase
      .from('thoughts')
      .select('id', { count: 'exact', head: true })
      .is('embedding', null)

    return json({
      processed,
      embedded,
      failed,
      offset_next: offset + batchSize,
      remaining: remaining ?? 0,
    })
  } catch (e) {
    console.error('backfill-embeddings error', e)
    return json({ error: String(e) }, 500)
  }
})
