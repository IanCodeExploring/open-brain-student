// open-brain-mcp: An MCP (Model Context Protocol) server for your Open Brain.
// This lets any MCP-compatible AI (like Claude Desktop) search, list, and add
// to your thoughts database through a standard protocol.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS headers so browsers/clients can call this function
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// These come from Deno's environment automatically (SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected by Supabase for every edge function —
// you never set them yourself).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Describes the tools this MCP server offers. Claude reads this list to know
// what it's allowed to ask for and what parameters each tool takes.
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search the user's brain (thoughts database) for entries matching a query string. Searches across all captured content: video transcripts, PDF extracts, voice notes, Telegram messages, and manual notes.",
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

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify(rpcError(null, -32600, "Only POST is supported")),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Note: this server intentionally does not require a password/header to
  // connect. Claude's custom connector screen doesn't yet support sending a
  // static secret key, so this server relies on its web address itself being
  // private. Don't share this URL publicly.

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
        const { data, error } = await supabase
          .from("thoughts")
          .select("id, content, created_at")
          .ilike("content", `%${query}%`)
          .order("created_at", { ascending: false })
          .limit(10);

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

      if (toolName === "list_recent") {
        const limit = Number(args.limit ?? 10);
        const { data, error } = await supabase
          .from("thoughts")
          .select("id, content, created_at")
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
          .insert({ content })
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