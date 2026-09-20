// generate-embedding: converts text into a 1,536-number vector (an embedding)
// that represents its meaning, so thoughts can be compared and searched by
// meaning instead of exact keywords.
//
// To switch embedding providers, change the model string below. The vector
// dimension must stay 1536, or every downstream query (the "embedding
// vector(1536)" column, the HNSW index, and the search/link RPCs) needs a
// new migration to match the new size.

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
    const { text } = await req.json()

    if (!text || typeof text !== 'string') {
      return json({ embedding: null, error: 'text is required' }, 400)
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) {
      console.error('OPENAI_API_KEY is not set in Supabase secrets')
      return json({ embedding: null, error: 'OPENAI_API_KEY not configured' }, 200)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small', // 1536 dimensions
          input: text.slice(0, 30000), // guard against extremely long input
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text()
        console.error('OpenAI embeddings error:', res.status, errText)
        return json({ embedding: null, error: `OpenAI error ${res.status}` }, 200)
      }

      const data = await res.json()
      const embedding = data?.data?.[0]?.embedding ?? null

      if (!Array.isArray(embedding) || embedding.length !== 1536) {
        console.error('Unexpected embedding shape', embedding?.length)
        return json({ embedding: null, error: 'unexpected embedding shape' }, 200)
      }

      return json({ embedding })
    } finally {
      clearTimeout(timeout)
    }
  } catch (e) {
    // Any failure (timeout, network error, bad JSON) returns embedding: null
    // instead of throwing, so callers (enrich-thought, backfill-embeddings)
    // can continue without crashing.
    console.error('generate-embedding failed:', e)
    return json({ embedding: null, error: String(e) }, 200)
  }
})
