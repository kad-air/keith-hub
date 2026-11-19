import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { STATUSES, key, money, slug, stateForHelper, type Gift } from "@/lib/christmas/shared";
import {
  ChristmasInputError,
  deleteGift,
  deletePerson,
  getListState,
  setGift,
  setPerson,
  setTotalBudget,
  updateGift,
  updatePerson,
} from "@/lib/christmas/store";
import type { Asker, HelperTurn, UndoStep } from "@/lib/christmas/helperStore";

// The list helper: Claude with six tools, run by the SDK's tool runner (the
// approach Anthropic's docs recommend over a hand-written loop). The tools ARE
// the whole of what it can change — add, update and delete gifts, set or
// remove a budget line, set the total — and each one writes through the same
// validating store a hand edit uses (lib/christmas/store.ts). Every change
// records a line for the page and a step to put it back, so one answer's
// changes can be undone as a batch.
//
// Tools are `strict: true`, so the arguments always match their schemas.
// Strict schemas share a budget per request (24 optional parameters, 16
// nullable/union parameters, 20 strict tools); these use 13, 3 and 6.

export const MODEL = "claude-opus-5-5";

export const INSTRUCTIONS = `You are the helper on a family's shared Christmas gift list and budget page. Keith and Kim, the parents, plan Christmas on it together. Each question says which of them is asking; speak to that person by name when it's natural, and remember the other one can read this conversation too.

You can read the whole list: it comes with every question, as JSON. You can change it only with your tools: add, update and delete gifts, set or remove a person's budget line, and set the total budget. You cannot change how the page works or looks; if asked, say that needs a change to the page itself.

How the list works:
- Each gift has a recipient, an idea, who it is from, an estimated cost (est), an actual cost (actual), a status (Idea, Planned, Ordered, Purchased or Wrapped) and notes.
- Purchased and Wrapped count as bought. Spent is the sum of actual costs; estimated is the sum of estimates. A person's "left" is their budget minus what has been spent on their gifts.
- Some recipients (like "Family") have gifts but no budget line.
- Amounts are US dollars.

When asked a question, answer it from the list and do the arithmetic carefully. When asked to change something, make the change with your tools, then say in a sentence or two what you did. Use gift ids exactly as they appear in the list, and reuse recipient names exactly as written. Only delete when clearly asked. If a request is ambiguous, ask a short question instead of guessing.

Keep replies short, warm and plain: a few sentences, or a short list when listing gifts. No headings.`;

type Batch = { changes: string[]; undo: UndoStep[] };

function fail(err: unknown): never {
  if (err instanceof ChristmasInputError) throw new ToolError(err.message);
  throw err;
}

function giftOrFail(id: string): Gift {
  const g = getListState().gifts.find((x) => x.id === id);
  if (!g) throw new ToolError(`No gift has the id "${id}". Use an id from the list.`);
  return g;
}

/** A recipient name as already written on the list, if there is one. */
function canonicalRecipient(name: string): string {
  const s = getListState();
  const k = key(name);
  return s.people.find((p) => key(p.name) === k)?.name ?? s.gifts.find((g) => key(g.recipient) === k)?.recipient ?? name.trim();
}

const snapshot = (g: Gift) => {
  const { id: _id, ...rest } = g;
  return rest as Record<string, unknown>;
};

const STATUS = { type: "string", enum: [...STATUSES] } as const;

/** The six tools, each recording into `batch` and emitting a line as it lands. */
export function helperTools(batch: Batch, onChange: (line: string) => void) {
  const note = (line: string, step: UndoStep) => {
    batch.changes.push(line);
    batch.undo.push(step);
    onChange(line);
  };

  return [
    betaTool({
      name: "add_gift",
      description: "Add a gift for a recipient. Reuse an existing recipient name when the gift is for someone already on the list.",
      strict: true,
      inputSchema: {
        type: "object",
        properties: {
          recipient: { type: "string", description: "Who the gift is for." },
          idea: { type: "string", description: "The gift." },
          from: { type: "string", description: "Who it is from, e.g. Parents or Santa." },
          est: { type: "number", description: "Estimated cost in dollars." },
          actual: { type: "number", description: "Actual cost in dollars, once bought." },
          status: STATUS,
          notes: { type: "string" },
        },
        required: ["recipient", "idea"],
        additionalProperties: false,
      },
      run: (a) => {
        const recipient = canonicalRecipient(a.recipient) || "Family";
        const id = randomUUID();
        try {
          setGift(id, { ...a, recipient, status: a.status ?? "Idea", createdAt: Date.now() });
        } catch (e) {
          fail(e);
        }
        note(`Added “${a.idea.trim()}” for ${recipient}${a.est != null ? ` (${money(a.est)})` : ""}`, { t: "del", path: `gifts/${id}` });
        return JSON.stringify({ added: giftOrFail(id) });
      },
    }),
    betaTool({
      name: "update_gift",
      description:
        "Change fields of an existing gift by id. Give only the fields that change. Set est or actual to null to clear it.",
      strict: true,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          recipient: { type: "string" },
          idea: { type: "string" },
          from: { type: "string" },
          est: { type: ["number", "null"] },
          actual: { type: ["number", "null"] },
          status: STATUS,
          notes: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      run: (a) => {
        const { id, ...fields } = a;
        const before = giftOrFail(id);
        if (typeof fields.recipient === "string") fields.recipient = canonicalRecipient(fields.recipient);
        if (!Object.keys(fields).length) throw new ToolError("Nothing to change: give at least one field.");
        try {
          updateGift(id, fields);
        } catch (e) {
          fail(e);
        }
        const what = Object.entries(fields)
          .map(([f, v]) => `${f} → ${f === "est" || f === "actual" ? (v == null ? "blank" : money(v as number)) : v}`)
          .join(", ");
        note(`Updated “${fields.idea ?? before.idea ?? "gift"}”: ${what}`, { t: "set", path: `gifts/${id}`, data: snapshot(before) });
        return JSON.stringify({ updated: giftOrFail(id) });
      },
    }),
    betaTool({
      name: "delete_gift",
      description: "Delete a gift by id. Only when clearly asked.",
      strict: true,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      run: (a) => {
        const before = giftOrFail(a.id);
        deleteGift(a.id);
        note(`Deleted “${before.idea || "gift"}” (${before.recipient})`, { t: "set", path: `gifts/${a.id}`, data: snapshot(before) });
        return JSON.stringify({ deleted: a.id });
      },
    }),
    betaTool({
      name: "set_budget",
      description:
        "Set a person's budget (null for none), creating their budget line if they don't have one. Optionally set their role, e.g. \"Age 9\" or \"Grandma\".",
      strict: true,
      inputSchema: {
        type: "object",
        properties: {
          person: { type: "string" },
          budget: { type: ["number", "null"] },
          role: { type: "string" },
        },
        required: ["person", "budget"],
        additionalProperties: false,
      },
      run: (a) => {
        const name = a.person.trim();
        if (!name) throw new ToolError("Give the person's name.");
        const s = getListState();
        const p = s.people.find((x) => key(x.name) === key(name));
        try {
          if (p) {
            const { id: _id, ...prev } = p;
            updatePerson(p.id, { budget: a.budget, ...(typeof a.role === "string" ? { role: a.role } : {}) });
            note(`${p.name} budget → ${a.budget == null ? "none" : money(a.budget)}`, { t: "set", path: `people/${p.id}`, data: prev });
          } else {
            const ids = new Set(s.people.map((x) => x.id));
            let id = slug(name), n = 2;
            while (ids.has(id)) id = `${slug(name)}-${n++}`;
            const order = s.people.reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;
            setPerson(id, { name, role: a.role ?? "", budget: a.budget, order });
            note(`Added ${name} with budget ${a.budget == null ? "none" : money(a.budget)}`, { t: "del", path: `people/${id}` });
          }
        } catch (e) {
          fail(e);
        }
        return JSON.stringify({ people: getListState().people });
      },
    }),
    betaTool({
      name: "remove_person",
      description: "Remove a person's budget line. Their gifts stay on the list.",
      strict: true,
      inputSchema: {
        type: "object",
        properties: { person: { type: "string" } },
        required: ["person"],
        additionalProperties: false,
      },
      run: (a) => {
        const p = getListState().people.find((x) => key(x.name) === key(a.person));
        if (!p) throw new ToolError(`No budget line for "${a.person}".`);
        const { id: _id, ...prev } = p;
        deletePerson(p.id);
        note(`Removed ${p.name} from the budget`, { t: "set", path: `people/${p.id}`, data: prev });
        return JSON.stringify({ removed: p.name });
      },
    }),
    betaTool({
      name: "set_total_budget",
      description: "Set the overall Christmas budget in dollars.",
      strict: true,
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        additionalProperties: false,
      },
      run: (a) => {
        const prev = getListState().totalBudget;
        try {
          setTotalBudget({ totalBudget: a.amount });
        } catch (e) {
          fail(e);
        }
        note(
          `Total budget → ${money(a.amount)}`,
          prev == null ? { t: "del", path: "config/main" } : { t: "set", path: "config/main", data: { totalBudget: prev } },
        );
        return JSON.stringify({ totalBudget: a.amount });
      },
    }),
  ];
}

/** Earlier turns as plain messages: each answer carries the changes it made. */
export function historyMessages(turns: HelperTurn[]): Anthropic.Beta.BetaMessageParam[] {
  return turns.map((t) => ({
    role: t.role,
    content:
      t.role === "user"
        ? `${t.author ?? "Someone"} asks: ${t.content}`
        : t.changes.length
          ? `${t.content}\n\n[Changes made: ${t.changes.join("; ")}${t.undone ? " — later undone" : ""}]`
          : t.content,
  }));
}

export type HelperResult = { answer: string; refused: boolean; truncated: boolean };

/**
 * One question, answered: the tool runner loops (reply → tool calls → results)
 * until Claude stops calling tools. Text streams out through onText; each
 * change lands in `batch` as its tool runs.
 */
export async function runHelper(
  question: string,
  asker: Asker,
  earlier: HelperTurn[],
  batch: Batch,
  onText: (delta: string) => void,
  onChange: (line: string) => void,
): Promise<HelperResult> {
  const client = new Anthropic();
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 8,
    stream: true,
    thread: false,
    output_config: { effort: "medium" },
    // A safety-classifier decline re-runs on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // Caches the stable prefix (tools, instructions, earlier turns) across the loop's requests.
    cache_control: { type: "ephemeral" },
    system: INSTRUCTIONS,
    tools: helperTools(batch, onChange),
    messages: [
      ...historyMessages(earlier),
      { role: "user", content: `THE LIST RIGHT NOW:\n${stateForHelper(getListState())}\n\n${asker} asks: ${question}` },
    ],
  });

  let answer = "";
  let refused = false;
  let truncated = false;
  for await (const stream of runner) {
    let turnText = "";
    stream.on("text", (delta) => {
      // A paragraph break between the text of successive turns of the loop.
      if (!turnText && answer && !answer.endsWith("\n\n")) {
        answer += "\n\n";
        onText("\n\n");
      }
      turnText += delta;
      answer += delta;
      onText(delta);
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") refused = true;
    if (message.stop_reason === "max_tokens") truncated = true;
  }
  return { answer: answer.trim(), refused, truncated };
}
