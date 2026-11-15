import { readFileSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getBook, bookFilePath } from "@/lib/books/store";
import { listProgress } from "@/lib/books/kosync";
import { parseBookCached, resolvePosition } from "@/lib/books/pageText";
import { ASK_INSTRUCTIONS, MAX_QUESTION_CHARS, readSoFar } from "@/lib/books/ask";
import { beginQuestion, clearTurns, completeAnswer, dropQuestion, isPending, listTurns } from "@/lib/books/askStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL = "claude-opus-5-5";
/** Earlier turns sent along with a new question. The page shows them all. */
const MAX_TURNS_SENT = 60;

// Ask a question about a book in progress. The model is sent the book's text
// up to the latest synced position and nothing after it — see lib/books/ask.ts,
// which owns the cut (🔴 the text reaches the request ONLY through readSoFar;
// check:books:ask pins that this file never touches the parsed book's blocks).
//
// GET    → the saved conversation, whether asking is possible right now, and
//          how much of the book would be sent.
// POST   → { question } → NDJSON stream: {t:"meta"}, {t:"text",v}…, then
//          {t:"done"} or {t:"error",v}. The conversation so far comes from the
//          database (lib/books/askStore.ts), never from the request.
// DELETE → clear the conversation.
//
// 🔴 The answer is finished and saved even if the browser goes away: a phone
// put in a pocket mid-answer kills the request, and the answer should be
// there on return. So the model call is NOT tied to the request's signal.
//
// ANTHROPIC_API_KEY unset = refused with a reason (fail closed, like the other
// Books credentials). Cookie-gated with the rest of /api/books, or the Books
// app token.

// Questions this process is answering right now. A question in the database
// with no answer that is NOT in here was orphaned by a restart or a deploy
// mid-answer; left alone it would show "Reading" and refuse new questions for
// PENDING_SECONDS with nothing actually running.
const inFlight = new Set<number>();

/** The thread, with a question orphaned by a restart removed. */
function liveTurns(bookId: string) {
  const turns = listTurns(bookId);
  const last = turns[turns.length - 1];
  if (last && last.role === "user" && !inFlight.has(last.id)) {
    dropQuestion(bookId, last.id);
    turns.pop();
  }
  return turns;
}

type Ready = {
  chunks: string[];
  words: number;
  totalWords: number;
  percentage: number;
  precision: string;
};

function prepare(id: string): { error: string; status: number } | Ready {
  const book = getBook(id);
  if (!book) return { error: "not found", status: 404 };

  // Newest first: the first row for this file is the latest position from any device.
  const sync = listProgress().find((p) => p.document === book.partialMd5) ?? null;
  if (!sync) {
    return {
      error: "No synced position for this book yet. Sync it from a device first, so there is a place to stop reading at.",
      status: 409,
    };
  }

  let parsed;
  try {
    parsed = parseBookCached(book.sha256, () => readFileSync(bookFilePath(book)));
  } catch {
    return { error: "stored file unreadable", status: 500 };
  }
  if (!parsed) return { error: "could not read this epub's text", status: 422 };

  const position = resolvePosition(parsed, sync.progress, sync.percentage);
  const sofar = readSoFar(parsed, position.word);
  if (sofar.words === 0) {
    return { error: "The synced position is the very start of the book, so there is nothing read yet to ask about.", status: 409 };
  }
  return { ...sofar, percentage: sync.percentage, precision: position.precision };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!getBook(params.id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const turns = liveTurns(params.id);
  const ready = prepare(params.id);
  return NextResponse.json(
    {
      turns,
      pending: isPending(turns),
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      ...("error" in ready
        ? { unavailable: ready.error }
        : {
            words: ready.words,
            totalWords: ready.totalWords,
            percentage: ready.percentage,
            precision: ready.precision,
          }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!getBook(params.id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ cleared: clearTurns(params.id) });
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key (ANTHROPIC_API_KEY).";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use the model.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return `Anthropic refused the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic.";
  if (err instanceof Anthropic.APIError) return `Anthropic error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const body = await request.json().catch(() => null);
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "ask a question" }, { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json({ error: "that question is too long" }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the server, so questions are switched off." },
      { status: 503 },
    );
  }

  const ready = prepare(params.id);
  if ("error" in ready) return NextResponse.json({ error: ready.error }, { status: ready.status });

  // Instructions, then the text read so far. Chunk boundaries never move with
  // the position, so the breakpoint on the last FULL chunk still hits after a
  // day's reading; the one on the tail covers follow-up questions.
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: ASK_INSTRUCTIONS }];
  const last = ready.chunks.length - 1;
  ready.chunks.forEach((text, i) => {
    system.push({
      type: "text",
      text: i === 0 ? `THE BOOK, AS FAR AS THEY HAVE READ:\n\n${text}` : text,
      ...(i >= last - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    });
  });
  system.push({ type: "text", text: "(Their reading stops here. Nothing after this point has been read.)" });

  // The conversation so far, oldest first. Only complete question/answer
  // pairs are stored, so this always alternates and starts with a question.
  const earlier = liveTurns(params.id).slice(-MAX_TURNS_SENT);
  while (earlier.length > 0 && earlier[0].role !== "user") earlier.shift();
  while (earlier.length > 0 && earlier[earlier.length - 1].role !== "assistant") earlier.pop();
  const questionId = beginQuestion(params.id, question, ready.words);
  if (questionId == null) {
    return NextResponse.json({ error: "The last question is still being answered." }, { status: 409 });
  }

  inFlight.add(questionId);

  const client = new Anthropic();
  const encoder = new TextEncoder();
  // The browser's end of the stream. Null once it has gone; the work carries on.
  let out: ReadableStreamDefaultController<Uint8Array> | null = null;
  const send = (event: Record<string, unknown>) => {
    try {
      out?.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
    } catch {
      out = null;
    }
  };

  const work = async () => {
    send({ t: "meta", words: ready.words, totalWords: ready.totalWords, percentage: ready.percentage });
    try {
      const run = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        // If the model declines on a safety classifier (a violent novel can
        // trip one), the API re-runs the request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        messages: [
          ...earlier.map((t) => ({ role: t.role, content: t.content })),
          { role: "user" as const, content: question },
        ],
      });
      let answer = "";
      run.on("text", (delta) => {
        answer += delta;
        send({ t: "text", v: delta });
      });
      const message = await run.finalMessage();
      if (message.stop_reason === "refusal" || !answer.trim()) {
        dropQuestion(params.id, questionId);
        send({ t: "error", v: "The model declined to answer this one." });
      } else {
        completeAnswer(params.id, questionId, answer, ready.words);
        if (message.stop_reason === "max_tokens") send({ t: "error", v: "The answer was cut off at the length limit." });
        else send({ t: "done" });
      }
    } catch (err) {
      console.error("[api/books ask] Error:", err);
      dropQuestion(params.id, questionId);
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
