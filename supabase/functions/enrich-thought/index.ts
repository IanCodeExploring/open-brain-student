// enrich-thought: runs on every new thought (via a Database Webhook).
// Asks the LLM gateway for tags, a category and a summary, then saves them.
// It always returns 200, because a webhook function should never fail loudly.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection']

function ok(note: string) {
  return new Response(JSON.stringify({ ok: true, note }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// LLMs sometimes wrap JSON in ```json fences. Strip them before parsing.
function parseJson(text: string) {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return JSON.parse(cleaned.slice(start, end + 1))
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json()
    const record = payload.record
    if (!record) return ok('no record in payload')

    const content: string = record.content ?? ''

    // Skip very short thoughts.
    if (content.trim().length < 20) return ok('too short, skipped')

    // Skip anything that already has a category (for example the weekly
    // digest, which is saved with category 'digest'). This also stops the
    // enrichment from overwriting it.
    if (record.category) return ok('already categorized, skipped')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const prompt = `Analyze this note and reply with ONLY a JSON object, no other text.

Note:
"""
${content}
"""

Return exactly this shape:
{"tags": ["3 to 5 short lowercase tags"], "category": "one of: ${CATEGORIES.join(', ')}", "summary": "one sentence maximum"}`

    // Call the gateway. The Authorization header is REQUIRED, or you get a 401.
    const res = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        prompt,
        systemPrompt: 'You are a precise note-tagging assistant. Reply with valid JSON only.',
        maxTokens: 300,
        userId: record.user_id,
        source: 'enrich-thought',
      }),
    })

    if (!res.ok) {
      console.error('call-llm failed', res.status, await res.text())
      return ok('call-llm failed')
    }

    const { text } = await res.json()
    const parsed = parseJson(text)

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.slice(0, 5).map((t: unknown) => String(t).toLowerCase())
      : []
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'idea'
    const summary = typeof parsed.summary === 'string' ? parsed.summary : null

    const supabase = createClient(supabaseUrl, serviceKey)
    const { error } = await supabase
      .from('thoughts')
      .update({ tags, category, summary, enriched_at: new Date().toISOString() })
      .eq('id', record.id)

    if (error) console.error('update failed', error)

    // Generate embedding.
    // NOTE the Authorization header - it is not optional. One edge function
    // calling another must prove who it is, or Supabase rejects the call with
    // a 401 before generate-embedding runs. The symptom of a missing header
    // is that embeddings silently never appear and the generate-embedding
    // logs are empty, because it never ran.
    let embedding: number[] | null = null
    try {
      const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ text: content }),
      })
      const embJson = await embRes.json()
      embedding = embJson?.embedding ?? null
    } catch (embErr) {
      console.error('generate-embedding call failed', embErr)
    }

    if (embedding) {
      const { error: embError } = await supabase
        .from('thoughts')
        .update({ embedding })
        .eq('id', record.id)
      if (embError) console.error('embedding update failed', embError)
    }

    // Auto-link: find and save neighbors - scoped to the same user as the
    // thought that was just saved, using the user_id already pulled from
    // this webhook payload for the enrichment call above.
    if (embedding) {
      const { data: neighbors, error: linkRpcError } = await supabase.rpc('find_links_for_thought', {
        source_id: record.id,
        source_embedding: embedding,
        p_user_id: record.user_id,
        match_threshold: 0.5,
        match_count: 5,
      })

      if (linkRpcError) {
        console.error('find_links_for_thought failed', linkRpcError)
      } else if (neighbors && neighbors.length > 0) {
        const links = neighbors.map((n: { target_id: string; similarity: number }) => ({
          source_thought_id: record.id,
          target_thought_id: n.target_id,
          user_id: record.user_id,
          similarity_score: n.similarity,
          link_type: 'semantic',
        }))

        const { error: linkError } = await supabase
          .from('thought_links')
          .upsert(links, { onConflict: 'source_thought_id,target_thought_id', ignoreDuplicates: true })

        if (linkError) console.error('thought_links upsert failed', linkError)
      }
    }

    // Chunk it, if it's long enough to be worth it.
    // `content` here is capped at 4000 chars by capture-url/capture-youtube, so it is not
    // reliably the full document — chunk it under origin 'summary' regardless, since it is
    // what search shows and links off of, but ALSO look for a thought_sources row and chunk
    // the untruncated original under origin 'source'. Without this second pass, a detail past
    // character 4000 of a long transcript was captured but never became searchable.
    await saveThoughtChunksSafe(supabase, record.id, content, 'enrich-thought', 'summary')

    const { data: sourceRow, error: sourceFetchError } = await supabase
      .from('thought_sources')
      .select('source_text')
      .eq('thought_id', record.id)
      .maybeSingle()

    if (sourceFetchError) {
      console.error('thought_sources lookup failed', sourceFetchError)
    } else if (sourceRow?.source_text) {
      await saveThoughtChunksSafe(supabase, record.id, sourceRow.source_text, 'enrich-thought', 'source')
    }

    return ok('enriched')
  } catch (err) {
    console.error('enrich-thought error', err)
    return ok('error, see logs')
  }
})