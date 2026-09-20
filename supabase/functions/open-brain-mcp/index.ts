// open-brain-mcp: An MCP (Model Context Protocol) server for your Open Brain.
// This lets any MCP-compatible AI (like Claude Desktop) search, list, and add
// to your thoughts database through a standard protocol.
//
// Access control: this server only responds if the request's web address
// ends with your secret token (MCP_URL_TOKEN). Anyone without that exact
// address cannot reach your data.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS headers so browsers/clients can call this function
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// These come from Deno's environment automatically (SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected by Supabase for every edge function —
// you never set them yourself). MCP_URL_TOKEN is the secret you just created.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_URL_TOKEN = Deno.env.get("MCP_URL_TOKEN")!;
// The service role key bypasses row-level security entirely, so every query
// this server makes has to do its own filtering to stay scoped to one
// person's data. OWNER_USER_ID (set in Level 3 for the Telegram bot) is that
// person - the only signed-up user of this brain.
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// For a list of search results, look up each one's linked thoughts
// (from thought_links, in either direction) and attach them as a
// `linked` array, sorted strongest-first. Keeps the search tool from
// needing a second manual call to "list connections" - the graph comes
// along with the search result itself.
async function attachLinkedThoughts(results: { id: string; content: string; created_at: string }[]) {
  if (!results || results.length === 0) return results;

  const ids = results.map((r) => r.id);

  const orFilter = ids
    .map((rid) => `source_thought_id.eq.${rid},target_thought_id.eq.${rid}`)
    .join(",");

  const { data: links, error: linksError } = await supabase
    .from("thought_links")
    .select("source_thought_id, target_thought_id, similarity_score")
    .or(orFilter);

  if (linksError || !links || links.length === 0) {
    return results.map((r) => ({ ...r, linked: [] }));
  }

  // Collect every thought id on the "other side" of a link so we can fetch
  // their content in one query instead of one query per result.
  const otherIds = new Set<string>();
  for (const link of links) {
    for (const rid of ids) {
      if (link.source_thought_id === rid) otherIds.add(link.target_thought_id);
      if (link.target_thought_id === rid) otherIds.add(link.source_thought_id);
    }
  }

  const { data: linkedThoughts } = await supabase
    .from("thoughts")
    .select("id, content, created_at")
    .in("id", Array.from(otherIds));

  const thoughtById = new Map((linkedThoughts ?? []).map((t) => [t.id, t]));

  return results.map((r) => {
    const linked = links
      .filter((l) => l.source_thought_id === r.id || l.target_thought_id === r.id)
      .map((l) => {
        const otherId = l.source_thought_id === r.id ? l.target_thought_id : l.source_thought_id;
        const other = thoughtById.get(otherId);
        return other ? { ...other, similarity_score: l.similarity_score } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.similarity_score - a.similarity_score);

    return { ...r, linked };
  });
}


// Describes the tools this MCP server offers. Claude reads this list to know
// what it's allowed to ask for and what parameters each tool takes.
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search the user's brain (thoughts database) for entries matching a query string, using semantic (meaning-based) search. Searches across all captured content: video transcripts, PDF extracts, voice notes, Telegram messages, and manual notes. Each result includes a `linked` array of other thoughts the brain has automatically connected to it by similarity - mention these related thoughts to the user, not just the direct matches.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search term to look for in thought content.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description:
      "List the most recently saved thoughts from the user's brain, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many recent thoughts to return. Defaults to 10.",
        },
      },
      required: [],
    },
  },
  {
    name: "add_thought",
    description:
      "Save a new thought/note into the user's brain database.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text content of the thought to save.",
        },
      },
      required: ["content"],
    },
  },
];

// Builds a properly-shaped JSON-RPC 2.0 success response
function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

// Builds a properly-shaped JSON-RPC 2.0 error response
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // --- Access control: check the secret token in the URL path ---
  const url = new URL(req.url);
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const providedToken = pathSegments[pathSegments.length - 1];

  if (!MCP_URL_TOKEN || providedToken !== MCP_URL_TOKEN) {
    // Deliberately vague error — doesn't hint that a token even exists.
    return new Response("Not found", {
      status: 404,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify(rpcError(null, -32600, "Only POST is supported")),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify(rpcError(null, -32700, "Parse error: invalid JSON")),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { id, method, params } = body ?? {};

  try {
    // --- MCP handshake methods ---

    if (method === "initialize") {
      return new Response(
        JSON.stringify(
          rpcResult(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "open-brain-mcp", version: "1.0.0" },
          }),
        ),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (method === "tools/list") {
      return new Response(
        JSON.stringify(rpcResult(id, { tools: TOOLS })),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // --- Tool execution ---

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (toolName === "search_thoughts") {
        const query = String(args.query ?? "");

        // Semantic search: convert the query text into the same kind of
        // 1536-number vector every thought has, then let Postgres find the
        // thoughts whose meaning is closest to it (search_thoughts RPC).
        const embRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ text: query }),
        });
        const { embedding } = await embRes.json();

        if (!embedding) {
          // Fall back to keyword search rather than returning nothing if
          // embedding generation is ever down. Scoped to OWNER_USER_ID for
          // the same reason as every other query in this file: the service
          // role key does not go through row-level security.
          const { data, error } = await supabase
            .from("thoughts")
            .select("id, content, created_at")
            .eq("user_id", OWNER_USER_ID)
            .ilike("content", `%${query}%`)
            .order("created_at", { ascending: false })
            .limit(10);

          if (error) throw error;

          const withLinksFallback = await attachLinkedThoughts(data ?? []);

          return new Response(
            JSON.stringify(
              rpcResult(id, {
                content: [{ type: "text", text: JSON.stringify(withLinksFallback, null, 2) }],
              }),
            ),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const { data, error } = await supabase.rpc("search_thoughts", {
          query_text: query,
          p_user_id: OWNER_USER_ID,
          query_embedding: embedding,
          match_threshold: 0.3,
          match_count: 10,
        });

        if (error) throw error;

        // matched_chunk is set when the best evidence for a result came from
        // partway through a longer capture, rather than from the thought's
        // own short content - surface that distinction rather than silently
        // showing the whole-thought content in both cases.
        const annotated = (data ?? []).map((r: any) =>
          r.matched_chunk
            ? { ...r, matched_excerpt: r.matched_chunk, note: "(from partway through a longer capture)" }
            : r
        );

        const withLinks = await attachLinkedThoughts(annotated);

        return new Response(
          JSON.stringify(
            rpcResult(id, {
              content: [{ type: "text", text: JSON.stringify(withLinks, null, 2) }],
            }),
          ),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (toolName === "list_recent") {
        const limit = Number(args.limit ?? 10);
        const { data, error } = await supabase
          .from("thoughts")
          .select("id, content, created_at")
          .eq("user_id", OWNER_USER_ID)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (error) throw error;

        return new Response(
          JSON.stringify(
            rpcResult(id, {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            }),
          ),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (toolName === "add_thought") {
        const content = String(args.content ?? "");
        const { data, error } = await supabase
          .from("thoughts")
          .upsert({ content, user_id: OWNER_USER_ID }, { onConflict: "dedup_key,user_id", ignoreDuplicates: false })
          .select("id, content, created_at")
          .single();

        if (error) throw error;

        return new Response(
          JSON.stringify(
            rpcResult(id, {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            }),
          ),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify(rpcError(id, -32601, `Unknown tool: ${toolName}`)),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Unknown method
    return new Response(
      JSON.stringify(rpcError(id, -32601, `Unknown method: ${method}`)),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify(rpcError(id, -32000, `Server error: ${String(err)}`)),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});