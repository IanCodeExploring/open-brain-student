// backfill-chunks: one-time (re-runnable) sweep that chunks thoughts saved
// before chunking existed (Levels 2-6), so a detail buried in an old long
// capture becomes searchable too, not just captures from today onward.
//
// Chunks both origins, same as enrich-thought does for new captures:
//   'summary' - thoughts.content (may be truncated to 4000 chars by
//               capture-url/capture-youtube)
//   'source'  - thought_sources.source_text, when a source row exists
//               (the full, untruncated original)
//
// Call it repeatedly with increasing batch until `remaining` is 0.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

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
    const batchSize = Number(body.batch_size ?? 10)
    const dryRun = Boolean(body.dry_run)

    if (dryRun) {
      const { count, error } = await supabase
        .from('thoughts_needing_chunks')
        .select('id', { count: 'exact', head: true })
      if (error) return json({ error: error.message }, 500)
      return json({ needs_chunks: count ?? 0 })
    }

    // Biggest documents first - they matter most if the run gets
    // interrupted, and they're exactly the ones this level is about.
    const { data: candidates, error: fetchError } = await supabase
      .from('thoughts_needing_chunks')
      .select('id, chars')
      .order('chars', { ascending: false })
      .limit(batchSize)

    if (fetchError) return json({ error: fetchError.message }, 500)

    let chunked = 0

    for (const row of candidates ?? []) {
      const { data: thought, error: thoughtError } = await supabase
        .from('thoughts')
        .select('id, content')
        .eq('id', row.id)
        .single()

      if (thoughtError || !thought) {
        console.error('backfill-chunks: could not load thought', row.id, thoughtError)
        continue
      }

      const summaryCount = await saveThoughtChunksSafe(
        supabase, thought.id, thought.content, 'backfill-chunks', 'summary',
      )

      const { data: sourceRow } = await supabase
        .from('thought_sources')
        .select('source_text')
        .eq('thought_id', thought.id)
        .maybeSingle()

      let sourceCount = 0
      if (sourceRow?.source_text) {
        sourceCount = await saveThoughtChunksSafe(
          supabase, thought.id, sourceRow.source_text, 'backfill-chunks', 'source',
        )
      }

      if (summaryCount > 0 || sourceCount > 0) chunked++
    }

    const processed = candidates?.length ?? 0

    const { count: remaining } = await supabase
      .from('thoughts_needing_chunks')
      .select('id', { count: 'exact', head: true })

    return json({ processed, chunked, remaining: remaining ?? 0 })
  } catch (e) {
    console.error('backfill-chunks error', e)
    return json({ error: String(e) }, 500)
  }
})
