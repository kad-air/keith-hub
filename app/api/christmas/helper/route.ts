import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { RULES, parseHelperReply, stateForHelper } from "@/lib/christmas/shared";
import { getListState, takeHelperAllowance } from "@/lib/christmas/store";
import { XMAS_COOKIE } from "@/lib/christmas/auth";
import { allow, clientAddress } from "@/lib/christmas/rateLimit";

export const dynamic = "force-dynamic";

// The list helper. Replaces the artifact's `sample.json`: the rules, the
// current list as JSON and the request go in; one {reply, ops} object comes
// out. 🔴 This route never changes the list. It returns ops, filtered to the
// six allowed names; the page validates each one's fields (cleanGift) and
// applies it through the same routes a hand edit uses, then offers Undo.
//
// The list JSON is read from the database HERE, never taken from the request,
// so a caller can't inflate the prompt. The key stays on the server.

const MODEL = "claude-opus-5-5";
const MAX_TEXT = 1000;
const MAX_TURNS = 10;
const MAX_TURN_CHARS = 2000;
/** Per device/address: a burst, then an hour. */
const WINDOWS: [number, number][] = [[6, 60_000], [40, 3600_000]];
/** Everyone together, per UTC day, kept in the database across restarts. */
const DAILY_CAP = Number(process.env.CHRISTMAS_HELPER_DAILY_CAP) || 150;

function fail(code: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, ...extra } }, { status });
}

type Turn = { role: "user" | "assistant"; content: string };

function cleanTurns(v: unknown): Turn[] {
  if (!Array.isArray(v)) return [];
  const turns = v
    .filter(
      (t): t is Turn =>
        !!t && typeof t === "object" &&
        ((t as Turn).role === "user" || (t as Turn).role === "assistant") &&
        typeof (t as Turn).content === "string",
    )
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) }))
    .slice(-MAX_TURNS);
  // Must alternate, starting with a question and ending with an answer.
  while (turns.length && turns[0].role !== "user") turns.shift();
  const out: Turn[] = [];
  for (const t of turns) if (!out.length || out[out.length - 1].role !== t.role) out.push(t);
  while (out.length && out[out.length - 1].role !== "assistant") out.pop();
  return out;
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return fail("sampling_disabled", 503);

  const who = request.headers.get("cookie")?.match(new RegExp(`${XMAS_COOKIE}=([^;]+)`))?.[1]?.slice(0, 16);
  const limit = allow(`helper:${who ?? clientAddress(request.headers)}`, WINDOWS);
  if (!limit.ok) return fail("rate_limited", 429, { retryAfterSec: limit.retryAfterSec });

  let body: { text?: unknown; turns?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail("bad_request", 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return fail("bad_request", 400);
  if (text.length > MAX_TEXT) return fail("prompt_too_large", 400);

  if (!takeHelperAllowance(DAILY_CAP)) return fail("rate_limited", 429, { daily: true });

  const list = stateForHelper(getListState());
  if (list.length > 200_000) return fail("prompt_too_large", 400);

  const client = new Anthropic();
  try {
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "medium" },
      // A safety-classifier decline re-runs on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: RULES,
      messages: [
        ...cleanTurns(body.turns),
        {
          role: "user",
          content: `CURRENT LIST JSON:\n${list}\n\nREQUEST:\n${text}\n\nReply with only the JSON object {"reply","ops"}.`,
        },
      ],
    });
    if (message.stop_reason === "refusal") return fail("refused", 200);
    const out = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const parsed = parseHelperReply(out);
    if (!parsed) {
      console.error("[api/christmas helper] unparseable reply:", message.stop_reason, out.slice(0, 300));
      return fail("invalid_json", 200);
    }
    return NextResponse.json(parsed);
  } catch (err) {
    console.error("[api/christmas helper] Error:", err);
    if (err instanceof Anthropic.RateLimitError) return fail("rate_limited", 429);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return fail("sampling_disabled", 503);
    }
    if (err instanceof Anthropic.BadRequestError && /too long|too large|context/i.test(err.message)) {
      return fail("prompt_too_large", 400);
    }
    return fail("upstream", 502);
  }
}
