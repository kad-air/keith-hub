import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { runHelper } from "@/lib/christmas/helper";
import {
  beginQuestion,
  clearTurns,
  completeAnswer,
  dropQuestion,
  isPending,
  listTurns,
  type UndoStep,
} from "@/lib/christmas/helperStore";
import { takeHelperAllowance } from "@/lib/christmas/store";
import { XMAS_COOKIE } from "@/lib/christmas/auth";
import { allow, clientAddress } from "@/lib/christmas/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The list helper's thread — adapted from the books "Ask" route
// (app/api/books/[id]/ask/route.ts).
//
// GET    → the shared conversation, and whether asking is possible.
// POST   → { question } → NDJSON stream: {t:"text",v}… and {t:"change",v} as
//          each tool lands, then {t:"done"} or {t:"error",v}. Earlier turns
//          come from the database, never from the request; so does the list.
// DELETE → clear the conversation.
//
// 🔴 The answer is finished and saved even if the browser goes away (a phone
// put away mid-answer), so the model call is not tied to the request — and the
// changes the tools made are on the list either way. ANTHROPIC_API_KEY unset
// = refused with a reason. Gated by middleware.ts like every Christmas route.

const MAX_QUESTION_CHARS = 1000;
const MAX_TURNS_SENT = 20;
/** Per device: a burst, then an hour. Plus a durable daily cap for everyone. */
const WINDOWS: [number, number][] = [[6, 60_000], [40, 3600_000]];
const DAILY_CAP = Number(process.env.CHRISTMAS_HELPER_DAILY_CAP) || 150;

const inFlight = new Set<number>();

/** The thread, with a question orphaned by a restart mid-answer removed. */
function liveTurns() {
  const turns = listTurns();
  const last = turns[turns.length - 1];
  if (last && last.role === "user" && !inFlight.has(last.id)) {
    dropQuestion(last.id);
    turns.pop();
  }
  return turns;
}

export function GET() {
  const turns = liveTurns();
  return NextResponse.json(
    { turns, pending: isPending(turns), configured: Boolean(process.env.ANTHROPIC_API_KEY) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function DELETE() {
  return NextResponse.json({ cleared: clearTurns() });
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic is busy right now. Try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic.";
  if (err instanceof Anthropic.APIError) return `Anthropic error ${err.status ?? ""}: ${err.message}`;
  return "Something went wrong reaching the helper. Try again.";
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Ask something first." }, { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) return NextResponse.json({ error: "That's a bit long — try a shorter request." }, { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "The helper is switched off: no Anthropic API key on the server." }, { status: 503 });
  }

  const who = request.headers.get("cookie")?.match(new RegExp(`${XMAS_COOKIE}=([^;]+)`))?.[1]?.slice(0, 16);
  const limit = allow(`helper:${who ?? clientAddress(request.headers)}`, WINDOWS);
  if (!limit.ok) {
    return NextResponse.json({ error: `Too many requests. Try again in ${limit.retryAfterSec} seconds.` }, { status: 429 });
  }

  const earlier = liveTurns().slice(-MAX_TURNS_SENT);
  while (earlier.length && earlier[0].role !== "user") earlier.shift();
  const questionId = beginQuestion(question);
  if (questionId == null) {
    return NextResponse.json({ error: "The last question is still being answered." }, { status: 409 });
  }
  if (!takeHelperAllowance(DAILY_CAP)) {
    dropQuestion(questionId);
    return NextResponse.json({ error: "The helper has done all it can for today. Try again tomorrow." }, { status: 429 });
  }
  inFlight.add(questionId);

  const encoder = new TextEncoder();
  let out: ReadableStreamDefaultController<Uint8Array> | null = null;
  const send = (event: Record<string, unknown>) => {
    try {
      out?.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
    } catch {
      out = null;
    }
  };

  const work = async () => {
    const batch = { changes: [] as string[], undo: [] as UndoStep[] };
    try {
      const result = await runHelper(
        question,
        earlier,
        batch,
        (v) => send({ t: "text", v }),
        (v) => send({ t: "change", v }),
      );
      let answer = result.answer;
      if (!answer) answer = batch.changes.length ? "Done." : result.refused ? "I can't help with that one." : "";
      if (!answer) {
        dropQuestion(questionId);
        send({ t: "error", v: "The helper didn't answer. Try rephrasing." });
      } else {
        completeAnswer(questionId, answer, batch.changes, batch.undo);
        send(result.truncated ? { t: "error", v: "The answer was cut off at the length limit." } : { t: "done" });
      }
    } catch (err) {
      console.error("[api/christmas helper] Error:", err);
      // Changes already made stay on the list; keep them in the thread so they can be undone.
      if (batch.changes.length) completeAnswer(questionId, "Something went wrong partway through.", batch.changes, batch.undo);
      else dropQuestion(questionId);
      send({ t: "error", v: describe(err) });
    } finally {
      inFlight.delete(questionId);
      try {
        out?.close();
      } catch {
        // already closed by a disconnect
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller;
      void work();
    },
    cancel() {
      out = null;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
