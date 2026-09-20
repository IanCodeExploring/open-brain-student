// enrich-thought: runs on every new thought (via a Database Webhook).
// Asks the LLM gateway for tags, a category and a summary, then saves them.
// It always returns 200, because a webhook function should never fail loudly.

import { createClient } from 'npm:@supabase/supabase-js@2'

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
    return ok('enriched')
  } catch (err) {
    console.error('enrich-thought error', err)
    return ok('error, see logs')
  }
})