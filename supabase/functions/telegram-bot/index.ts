// supabase/functions/telegram-bot/index.ts
//
// Receives messages from Telegram (via webhook), and either:
//   - saves the message as a new thought
//   - searches existing thoughts (/search or ?query)
//   - returns the most recent thoughts (/recent)
//
// Deployed with --no-verify-jwt because Telegram cannot send a Supabase
// login token. Because of that, this function is public to anyone who
// knows its URL — so we only ever read/write rows belonging to
// OWNER_USER_ID, never anything from the request itself.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function sendTelegramMessage(chatId: number, text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}

async function handleSearch(chatId: number, query: string) {
  const { data, error } = await admin
    .from("thoughts")
    .select("id, content, created_at")
    .eq("user_id", OWNER_USER_ID)
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    await sendTelegramMessage(chatId, `Search failed: ${error.message}`);
    return;
  }

  if (!data || data.length === 0) {
    await sendTelegramMessage(chatId, `No thoughts found matching "${query}".`);
    return;
  }

  const lines = data.map((t, i) => `${i + 1}. ${t.content.slice(0, 200)}`);
  await sendTelegramMessage(
    chatId,
    `Found ${data.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`,
  );
}

async function handleRecent(chatId: number) {
  const { data, error } = await admin
    .from("thoughts")
    .select("id, content, created_at")
    .eq("user_id", OWNER_USER_ID)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    await sendTelegramMessage(chatId, `Could not fetch recent thoughts: ${error.message}`);
    return;
  }

  if (!data || data.length === 0) {
    await sendTelegramMessage(chatId, "No thoughts saved yet.");
    return;
  }

  const lines = data.map((t, i) => `${i + 1}. ${t.content.slice(0, 200)}`);
  await sendTelegramMessage(chatId, `Your ${data.length} most recent thoughts:\n\n${lines.join("\n\n")}`);
}

async function handleSave(chatId: number, text: string) {
  const { error } = await admin.from("thoughts").insert({
    user_id: OWNER_USER_ID,
    content: text,
  });

  if (error) {
    await sendTelegramMessage(chatId, `Failed to save: ${error.message}`);
    return;
  }

  await sendTelegramMessage(chatId, "Saved to your brain ✅");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const update = await req.json();
    const message = update?.message;

    // Not a message we care about (e.g. edited_message, channel_post) -
    // still return 200 so Telegram does not retry.
    if (!message || typeof message.text !== "string") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const chatId = message.chat.id as number;
    const text = message.text.trim() as string;

    if (text.startsWith("/search ")) {
      await handleSearch(chatId, text.slice("/search ".length).trim());
    } else if (text.startsWith("? ")) {
      await handleSearch(chatId, text.slice(2).trim());
    } else if (text.startsWith("?")) {
      await handleSearch(chatId, text.slice(1).trim());
    } else if (text === "/recent") {
      await handleRecent(chatId);
    } else if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "Hi! Send me anything and I'll save it to your brain. Use /search <term> or ?<term> to search, and /recent for your last 5 thoughts.",
      );
    } else {
      await handleSave(chatId, text);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("telegram-bot error:", err);
    // Always return 200 to Telegram, even on internal errors, so it does
    // not endlessly retry the same failing update.
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});