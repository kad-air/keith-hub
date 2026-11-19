// check:christmas — the shared Christmas list's gate (in prebuild).
//
//  1. THE REAL MIDDLEWARE, driven with NextRequest: with no cookie the page
//     redirects to its passcode form and every /api/christmas route is 401;
//     the passcode cookie opens /christmas + /api/christmas/* and NOTHING else
//     on the hub; the hub cookie also opens it; a forged cookie, an encoded
//     path, and an unset CHRISTMAS_PASSCODE (fail closed — even with
//     FEED_PASSWORD unset, which opens the rest of the hub) all refuse.
//  2. The store, in a throwaway database through the real schema: the seed
//     (once, and never again after the list is emptied), validation (status,
//     money, ids, names), the revision counter, the helper's daily cap.
//  3. The helper's six tools, run for real (no model call): each writes
//     through the store, records a line and an undo step, and undoing a batch
//     restores the list exactly; errors reach the model as tool errors; the
//     schemas stay inside Anthropic's strict-tool budget.
//  4. The rate limiter's windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const PASSCODE = "check-snowman";
const PASSWORD = "check-password";

const { NextRequest } = await import("next/server");
const { middleware } = await import("../middleware.ts");
const { deriveAuthToken } = await import("../lib/auth.ts");
const { deriveChristmasToken } = await import("../lib/christmas/auth.ts");

function setEnv(env: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
async function mw(url: string, cookie?: string, method = "GET"): Promise<Response> {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return middleware(new NextRequest(`http://localhost${url}`, { method, headers }));
}
const through = (r: Response) => r.headers.get("x-middleware-next") === "1";
const toPasscode = (r: Response) => !through(r) && /\/christmas\/login$/.test(r.headers.get("location") ?? "");
const api401 = (r: Response) => !through(r) && r.status === 401;

console.log("1. middleware");
setEnv({ FEED_PASSWORD: PASSWORD, CHRISTMAS_PASSCODE: PASSCODE });
const xmas = `xmas-auth=${await deriveChristmasToken(PASSCODE)}`;
const hub = `hub-auth=${await deriveAuthToken(PASSWORD)}`;
const API = ["/api/christmas", "/api/christmas/helper", "/api/christmas/gifts/abc", "/api/christmas/people/kim", "/api/christmas/config"];

assert(toPasscode(await mw("/christmas")), "no cookie: /christmas → passcode form");
for (const u of API) assert(api401(await mw(u, undefined, "POST")), `no cookie: ${u} → 401`);
assert(through(await mw("/christmas/login")), "the passcode form itself is reachable");
assert(through(await mw("/api/christmas/auth", undefined, "POST")), "the passcode POST is reachable");
assert(through(await mw("/christmas", xmas)), "passcode cookie opens /christmas");
for (const u of API) assert(through(await mw(u, xmas, "POST")), `passcode cookie opens ${u}`);
for (const u of ["/", "/saved", "/books", "/tune"]) {
  const r = await mw(u, xmas);
  assert(!through(r) && /\/login$/.test(r.headers.get("location") ?? ""), `passcode cookie does NOT open ${u}`);
}
for (const u of ["/api/items", "/api/books", "/api/tune/config", "/api/christmasx", "/api/christmas/..%2f..%2fapi%2fitems"]) {
  assert(api401(await mw(u, xmas)), `passcode cookie does NOT open ${u}`);
}
assert(through(await mw("/christmas", hub)) && through(await mw("/api/christmas/helper", hub, "POST")), "hub cookie opens the list too");
assert(api401(await mw("/api/christmas", "xmas-auth=deadbeef")), "forged passcode cookie refused");
assert(api401(await mw("/api/christmas", `xmas-auth=${await deriveChristmasToken("old-passcode")}`)), "cookie from a changed passcode refused");
setEnv({ CHRISTMAS_PASSCODE: undefined });
assert(api401(await mw("/api/christmas", xmas)), "CHRISTMAS_PASSCODE unset: passcode cookie refused (fail closed)");
setEnv({ FEED_PASSWORD: undefined });
assert(through(await mw("/saved")), "(FEED_PASSWORD unset still opens the rest of the hub, as before)");
assert(api401(await mw("/api/christmas")) && toPasscode(await mw("/christmas")), "…but never the Christmas list");

console.log("2. store");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "christmas-check-")));
const store = await import("../lib/christmas/store.ts");
const s0 = store.getListState();
assert(s0.totalBudget === 2520, "seed: total 2520");
assert(
  s0.people.map((p) => `${p.name}/${p.role}/${p.budget}`).join(",") ===
    "Keith/Dad/370,Kim/Mom/370,Addie/Age 14/370,Lydia/Age 11/370,Scarlett/Age 9/370,Hudson/Age 4/370",
  "seed: six people, in order, 370 each",
);
assert(
  s0.gifts.map((g) => `${g.idea}/${g.recipient}/${g.from}/${g.est}/${g.status}`).join(",") ===
    "Get Out Pass/Family/Parents/720/Idea,Game table/Family/Parents/200/Idea",
  "seed: the two Family gifts",
);
for (const p of s0.people) store.deletePerson(p.id);
for (const g of s0.gifts) store.deleteGift(g.id);
const s1 = store.getListState();
assert(s1.people.length === 0 && s1.gifts.length === 0, "an emptied list stays empty (never re-seeded)");
assert(s1.rev > s0.rev, "every write bumps the revision");
const bad = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof store.ChristmasInputError;
  }
};
assert(bad(() => store.setGift("g1", { status: "Lost" })), "unknown status refused");
assert(bad(() => store.setGift("g1", { est: "lots" })), "non-numeric money refused");
assert(bad(() => store.setGift("../x", {})), "bad id refused");
assert(bad(() => store.setPerson("p1", { name: "  " })), "person without a name refused");
assert(bad(() => store.setGift("g1", ["x"])), "non-object body refused");
store.setGift("g1", { idea: "  Lego  ", est: "$40.505", recipient: "Hudson", idea2: "ignored" });
const g1 = store.getListState().gifts[0];
assert(g1.idea === "Lego" && g1.est === 40.51 && g1.status === "Idea", "strings trimmed, money to cents, status defaults");
assert(store.updateGift("missing", { idea: "x" }) === null, "update of a missing gift is a 404");
store.updateGift("g1", { status: "Purchased", actual: 38 });
assert(store.getListState().gifts[0].actual === 38, "update changes only what it names");
store.setGift("g1", { idea: "x".repeat(5000) });
assert(store.getListState().gifts[0].idea.length === 400, "long text capped");
store.setTotalBudget({ totalBudget: null });
assert(store.getListState().totalBudget === null, "total can be cleared");
assert(store.takeHelperAllowance(2) && store.takeHelperAllowance(2) && !store.takeHelperAllowance(2), "helper daily cap holds");
assert(store.takeHelperAllowance(2, new Date(Date.now() + 86_400_000)), "…and resets the next day");

console.log("3. helper tools");
// The six tools run for real against the throwaway database (no model call):
// each writes through the validating store, records a line and an undo step,
// and one answer's steps put the list back exactly.
const { helperTools, historyMessages } = await import("../lib/christmas/helper.ts");
const { applyUndo } = store;
store.setPerson("hudson", { name: "Hudson", role: "Age 4", budget: 370, order: 1 });
store.setTotalBudget({ totalBudget: 2520 });
const before = JSON.stringify((({ rev: _r, ...x }) => x)(store.getListState()));
const batch = { changes: [] as string[], undo: [] as { t: "del"; path: string }[] as never[] };
const lines: string[] = [];
const tools = helperTools(batch as never, (l: string) => lines.push(l));
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
assert(
  Object.keys(byName).sort().join(",") === "add_gift,delete_gift,remove_person,set_budget,set_total_budget,update_gift",
  "exactly the six tools",
);
const run = async (name: string, input: Record<string, unknown>) => String(await byName[name].run(input as never));
const added = JSON.parse(await run("add_gift", { recipient: "hudson", idea: "Lego set", from: "Parents", est: 40 }));
assert(added.added.recipient === "Hudson", "add_gift reuses the recipient's name as written on the list");
await run("update_gift", { id: added.added.id, status: "Purchased", actual: 38 });
await run("set_budget", { person: "Hudson", budget: 420 });
await run("set_budget", { person: "Grandma", budget: 100, role: "Grandma" });
await run("set_total_budget", { amount: 3000 });
const mid = store.getListState();
assert(mid.gifts.some((g) => g.idea === "Lego set" && g.actual === 38 && g.status === "Purchased"), "tools change the list");
assert(mid.people.find((p) => p.name === "Hudson")?.budget === 420 && mid.people.some((p) => p.name === "Grandma"), "set_budget updates and creates");
let threw = "";
try {
  await run("update_gift", { id: "nope", idea: "x" });
} catch (e) {
  threw = e instanceof Error ? e.constructor.name : "";
}
assert(threw === "ToolError", "a bad id comes back to the model as a tool error, not a crash");
try {
  await run("add_gift", { recipient: "Hudson", idea: "x", status: "Lost" });
  threw = "";
} catch (e) {
  threw = e instanceof Error ? e.constructor.name : "";
}
assert(threw === "ToolError", "the store's validation reaches the model as a tool error");
assert(lines.length === 5 && batch.changes.length === 5 && batch.undo.length === 5, "every change records a line and an undo step");
applyUndo(batch.undo as never);
assert(JSON.stringify((({ rev: _r, ...x }) => x)(store.getListState())) === before, "undoing the batch puts the list back exactly");
const hist = historyMessages([
  { id: 1, role: "user", content: "q", changes: [], undoable: false, undone: false, createdAt: 0 },
  { id: 2, role: "assistant", content: "a", changes: ["Added x"], undoable: true, undone: false, createdAt: 0 },
]);
assert(String(hist[1].content).includes("[Changes made: Added x]"), "earlier answers carry what they changed");
// Anthropic's strict-schema budget, per request: 20 strict tools, 24 optional
// parameters, 16 nullable/union parameters. Over it, every request is a 400.
let optional = 0, unions = 0;
for (const t of tools) {
  const sch = (t as unknown as { input_schema: unknown }).input_schema as { properties: Record<string, { type?: unknown; anyOf?: unknown }>; required?: string[] };
  for (const [k, v] of Object.entries(sch.properties)) {
    if (!(sch.required ?? []).includes(k)) optional++;
    if (Array.isArray(v.type) || v.anyOf) unions++;
  }
}
assert(tools.every((t) => (t as { strict?: boolean }).strict === true) && tools.length <= 20, "all tools strict, within 20");
assert(optional <= 24 && unions <= 16, `strict budget: ${optional}/24 optional, ${unions}/16 union`);

console.log("4. rate limiter");
const { allow } = await import("../lib/christmas/rateLimit.ts");
const t = 1_000_000;
let n = 0;
for (let i = 0; i < 10; i++) if (allow("k", [[3, 60_000]], t + i).ok) n++;
assert(n === 3, "3 per minute allows exactly 3");
assert(allow("k", [[3, 60_000]], t + 61_000).ok, "the window slides");

if (failures) {
  console.error(`\ncheck:christmas — ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncheck:christmas — all good");
