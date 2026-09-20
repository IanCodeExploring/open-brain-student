// call-llm: the LLM gateway.
// To switch providers, change LLM_PROVIDER in Supabase secrets.
// Add the new provider's API key. No other code changes needed.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Rough prices in USD per million tokens, used only to estimate cost.
// Unknown models log a cost of 0. Check your provider's pricing page for exact rates.
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
}

type LLMResult = { text: string; promptTokens: number; completionTokens: number }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function callAnthropic(
  model: string, prompt: string, system: string | undefined, maxTokens: number,
): Promise<LLMResult> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in Supabase secrets')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${JSON.stringify(data)}`)

  return {
    text: data.content?.[0]?.text ?? '',
    promptTokens: data.usage?.input_tokens ?? 0,
    completionTokens: data.usage?.output_tokens ?? 0,
  }
}

async function callOpenAI(
  model: string, prompt: string, system: string | undefined, maxTokens: number,
): Promise<LLMResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set in Supabase secrets')

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(data)}`)

  return {
    text: data.choices?.[0]?.message?.content ?? '',
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  }
}

// Writes the receipt row. This must NEVER break the real call:
// it is not awaited, and every error is swallowed.
function logUsage(row: Record<string, unknown>) {
  try {
    const url = Deno.env.get('SUPABASE_URL')
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !key || !row.user_id) return
    const supabase = createClient(url, key)
    const p = Promise.resolve(supabase.from('llm_usage').insert(row)).catch(() => {})
    // @ts-ignore: EdgeRuntime exists on Supabase's runtime; keeps the write alive after we respond
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p)
  } catch (_) {
    // A failed log is a shrug, not an error.
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    const { prompt, systemPrompt, model, maxTokens, userId, source } = await req.json()
    if (!prompt) return json({ error: 'prompt is required' }, 400)

    const provider = (Deno.env.get('LLM_PROVIDER') ?? 'anthropic').toLowerCase()
    const chosenModel = model ?? Deno.env.get('LLM_MODEL')
    if (!chosenModel) {
      return json({ error: 'No model set. Add LLM_MODEL to Supabase secrets.' }, 500)
    }
    const max = maxTokens ?? 1024

    let result: LLMResult
    if (provider === 'anthropic') {
      result = await callAnthropic(chosenModel, prompt, systemPrompt, max)
    } else if (provider === 'openai') {
      result = await callOpenAI(chosenModel, prompt, systemPrompt, max)
    } else {
      return json({ error: `Unknown LLM_PROVIDER: ${provider}` }, 500)
    }

    const price = PRICES[chosenModel]
    const cost = price
      ? (result.promptTokens * price.in + result.completionTokens * price.out) / 1_000_000
      : 0

    logUsage({
      user_id: userId,
      kind: 'agent',
      model: chosenModel,
      source: source ?? null,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      cost_usd: cost,
    })

    return json({ text: result.text })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})