// weekly-digest: called once a week by pg_cron.
// Reads the last 7 days of thoughts, asks the LLM gateway for a summary,
// and saves the result as a new thought with category 'digest'.

import { createClient } from 'npm:@supabase/supabase-js@2'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fmt = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, serviceKey)

    const end = new Date()
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000)

    // Last 7 days, excluding earlier digests. Thoughts that have not been
    // enriched yet have a null category, so they must be included explicitly.
    const { data: thoughts, error } = await supabase
      .from('thoughts')
      .select('content, category, user_id, created_at')
      .gte('created_at', start.toISOString())
      .or('category.is.null,category.neq.digest')
      .order('created_at', { ascending: true })
      .limit(200)

    if (error) {
      console.error('query failed', error)
      return json({ ok: false, note: 'query failed' })
    }
    if (!thoughts || thoughts.length < 5) {
      console.log(`Only ${thoughts?.length ?? 0} thoughts this week, not enough for a digest.`)
      return json({ ok: true, note: 'not enough content' })
    }

    // All thoughts belong to the one signed-up user.
    const userId = thoughts[0].user_id

    // Group by category.
    const groups: Record<string, string[]> = {}
    for (const t of thoughts) {
      const cat = t.category ?? 'uncategorized'
      const day = fmt(new Date(t.created_at))
      const body = String(t.content).slice(0, 500)
      ;(groups[cat] ??= []).push(`- [${day}] ${body}`)
    }
    const grouped = Object.entries(groups)
      .map(([cat, items]) => `## ${cat} (${items.length})\n${items.join('\n')}`)
      .join('\n\n')

    const prompt = `Below are the notes I captured over the last 7 days, grouped by category.

${grouped}

Write my weekly digest in plain, readable text with these three short sections:
1. What I was learning this week
2. Key themes across my notes
3. One question I seem to be exploring

Speak to me directly ("you"). Be concrete and refer to specific notes. Keep it under 350 words.`

    // Call the gateway. The Authorization header is REQUIRED, or you get a 401.
    const res = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        prompt,
        systemPrompt: 'You are a thoughtful assistant who writes personal weekly reflections from the user\'s own notes.',
        maxTokens: 1200,
        userId,
        source: 'weekly-digest',
      }),
    })

    if (!res.ok) {
      console.error('call-llm failed', res.status, await res.text())
      return json({ ok: false, note: 'call-llm failed' })
    }

    const { text } = await res.json()
    const digestText = `Weekly digest, ${fmt(start)} to ${fmt(end)}\n\n${String(text).trim()}`

    // Save the digest as a new thought. It already has a category, so the
    // enrichment agent skips it.
    const { error: insertError } = await supabase.from('thoughts').upsert({
      content: digestText,
      user_id: userId,
      category: 'digest',
      tags: ['digest', 'weekly'],
      summary: `Weekly digest of ${thoughts.length} thoughts`,
      enriched_at: new Date().toISOString(),
    }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
    if (insertError) console.error('insert failed', insertError)

    // Optional email via Resend. Does nothing unless both secrets are set.
    try {
      const resendKey = Deno.env.get('RESEND_API_KEY')
      const to = Deno.env.get('DIGEST_EMAIL_TO')
      if (resendKey && to) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Open Brain <onboarding@resend.dev>',
            to: [to],
            subject: 'Your weekly brain digest',
            text: digestText,
          }),
        })
      }
    } catch (e) {
      console.error('email failed', e)
    }

    return json({ ok: true, note: 'digest saved', thoughts: thoughts.length })
  } catch (err) {
    console.error('weekly-digest error', err)
    return json({ ok: false, note: 'error, see logs' })
  }
})