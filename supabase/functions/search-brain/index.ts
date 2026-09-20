// search-brain: server-side endpoint for your own app's Search tab.
//
// The browser cannot call generate-embedding or search_thoughts directly -
// generate-embedding needs a provider API key that must never sit in a web
// page, and search_thoughts (as of Level 7) needs p_user_id, which must come
// from a verified login token, never from the request body a browser could
// put anything into. This function sits in between: it verifies who is
// asking (from their own Supabase session), embeds the query, and calls
// search_thoughts scoped to that verified caller.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

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
  if (req.method !== 'POST') {
    return json({ error: 'Use POST' }, 405)
  }

  try {
    // Identify the caller from their OWN login token - the anon-key client
    // plus the incoming Authorization header. Never trust a user id sent in
    // the request body; a browser call could put anything there.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return json({ error: 'Not signed in' }, 401)
    }

    const body = await req.json().catch(() => ({}))
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) {
      return json({ error: 'query is required' }, 400)
    }
    const limit = Math.min(Number(body.limit ?? 20) || 20, 50)

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Embed the query. If this fails for any reason, fall back to
    // keyword-only search (query_embedding: null) rather than showing the
    // user an error - the same degrade-gracefully pattern used everywhere
    // else in this project.
    let embedding: number[] | null = null
    try {
      const embRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ text: query }),
      })
      const embJson = await embRes.json()
      embedding = embJson?.embedding ?? null
    } catch (embErr) {
      console.error('[search-brain] generate-embedding call failed:', embErr)
    }

    const { data, error } = await admin.rpc('search_thoughts', {
      query_text: query,
      p_user_id: user.id,
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: limit,
    })

    if (error) {
      console.error('[search-brain] search_thoughts failed:', error)
      return json({ error: error.message }, 500)
    }

    return json({ results: data ?? [] })
  } catch (err) {
    console.error('[search-brain] error', err)
    return json({ error: String(err) }, 500)
  }
})
