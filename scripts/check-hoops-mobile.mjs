#!/usr/bin/env node
/**
 * Gate: the Hoops section still fits on a phone.
 *
 *   npm run check:hoops:mobile                              # localhost:3000
 *   FEED_BASE=http://localhost:3111 npm run check:hoops:mobile
 *   FEED_BASE=https://hub.keithadair.com FEED_PASSWORD=… \
 *     npm run check:hoops:mobile                            # production
 *   npm run check:hoops:mobile -- --falsify                 # self-test (always exits 1)
 *   npm run check:hoops:mobile -- --out ./shots             # where failures are photographed
 *
 * (The `--` is npm's, not this script's: without it npm eats the flags.)
 *
 * WHY THIS EXISTS. Every phone problem the Hoops section has had was found by
 * a human taking a screenshot and squinting at it. That does not scale and it
 * does not repeat: a table that grows one column, a team name two characters
 * longer, a `<select>` with a new option — any of them can push the page wider
 * than the screen or clip a control off the right edge, and nothing in the
 * build notices. This walks the real pages in a real Chrome at two real iPhone
 * widths and fails loudly when they stop fitting.
 *
 * FOUR ASSERTIONS, per page and per width:
 *
 *   (a) NO HORIZONTAL PAGE SCROLL — `document.documentElement.scrollWidth <=
 *       window.innerWidth`. The whole-page version of "it fits". This is the
 *       one that catches a wide table, an unwrapped long word, a fixed-width
 *       element.
 *
 *   (b) NOTHING IS ACTUALLY TRUNCATED — no element carrying Tailwind's
 *       `truncate` class inside `<main>` has `scrollWidth > clientWidth + 1`.
 *       `truncate` is a promise that text COULD be clipped if it had to be;
 *       this asserts it does not have to be. A clipped player name or team
 *       name on a phone is the failure mode that reads as a bug to a reader.
 *
 *       🔴 ESCAPE HATCH: put `data-truncate-ok` on the element (any value, or
 *       none) and it is exempt. Use it only where clipping is the DESIGN — a
 *       deliberately-elided run id, say — and put the reason in a comment next
 *       to it. There are ZERO of these today; every `truncate` in the section
 *       is expected to have room. Adding one is a decision, not a fix.
 *
 *   (c) EVERY CONTROL IS ON SCREEN — every `<select>`, `<button>` and `<a>`
 *       inside `<main>` has `getBoundingClientRect().right <= innerWidth + 1`.
 *       (a) can pass while a control still sits off the right edge, because an
 *       ancestor with `overflow: hidden` clips it out of the document's own
 *       scroll width — an untappable button that looks fine in a screenshot.
 *
 *       Deliberate exception: controls inside an ancestor whose computed
 *       `overflow-x` is `auto`/`scroll` (the Hoops nav tabs are one) are a
 *       horizontal scroller BY DESIGN — reachable by swiping, and clipped out
 *       of (a) legitimately. Those are skipped and the count is printed, so
 *       the exemption stays visible rather than silent.
 *
 *   (d) THE PAGE ACTUALLY RENDERED — each page must contain its named landmark
 *       text. Without this, a dead server, a login redirect or a Next error
 *       page would sail through (a)-(c) by rendering nothing wide, and the
 *       gate would report a confident PASS on a section that is not there.
 *
 * FALSIFICATION (`--falsify`). Proves (a), (b) and (c) can actually fail. On
 * every page and width it injects a 2000px-wide div into `<main>` and requires
 * (a) to catch it, squeezes a real `.truncate` element to 20px and requires (b)
 * to catch that, and parks a button past the right edge for (c). Prints
 * FALSIFICATION OK only when every one was caught everywhere, and exits 1
 * either way — it is a self-test, never a green run. (d) is not injected
 * because it falsifies itself: stop the server and every page fails on it.
 *
 * NOT IN `prebuild`, on purpose, exactly like `check:tracking-hidden`: it needs
 * a running server, and a check that skips its own assertions when one is not
 * there is worse than no check.
 *
 * Uses `playwright-core` (never downloads a browser) driving the Google Chrome
 * already installed on the machine, via `chromium.launch({ channel: "chrome" })`.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "playwright-core";

// ── args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const FALSIFY = argv.includes("--falsify");
const OUT_DIR = flagValue("--out", "/tmp/hoops-mobile");
const FEED_BASE = (process.env.FEED_BASE || "http://localhost:3000").replace(/\/$/, "");
const PASSWORD = flagValue("--password", process.env.FEED_PASSWORD || "");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

// ── the widths ─────────────────────────────────────────────────────────────
//
// Playwright's plain `devices["iPhone SE"]` is the 2016 320-wide original; the
// phone we care about is the 375-wide one it ships as "iPhone SE (3rd gen)".
// Both names are tried and the resolved width is ASSERTED, so an upstream
// device-table change fails here rather than silently testing a width nobody
// owns.
function resolveDevice(names, expectedWidth) {
  for (const name of names) {
    const d = devices[name];
    if (d && d.viewport && d.viewport.width === expectedWidth) return { name, device: d };
  }
  const tried = names.map((n) => `${n}=${devices[n]?.viewport?.width ?? "missing"}`).join(", ");
  throw new Error(
    `no playwright device is ${expectedWidth}px wide (tried ${tried}) — the device table moved; ` +
      `pick a new name rather than testing a width the gate does not claim to test`,
  );
}

const WIDTHS = [
  resolveDevice(["iPhone SE (3rd gen)", "iPhone SE", "iPhone 8"], 375),
  resolveDevice(["iPhone 14 Pro Max", "iPhone 15 Pro Max"], 430),
];

// ── the pages ──────────────────────────────────────────────────────────────
//
// `landmark` is assertion (d): text that only exists when the page really
// rendered. `prepare` drives the interactions that produce the parts of a page
// that are not there on first paint (the matchup only draws a box score after
// a sim, and a series only after a second one).

const PAGES = [
  {
    id: "matchup",
    path: "/hoops",
    landmark: "Head to head this season",
    async prepare(page) {
      // The button counts its own games ("Sim 1,000 games"), so match the
      // shape, not the number — N_SIMS_EXPECTED_DEFAULT is allowed to move.
      // Case-insensitively, because the button is styled `uppercase` and an
      // accessible name may or may not carry the transform.
      await clickUntilText(
        page,
        page.getByRole("button", { name: /^sim [\d,]+ games$/i }),
        "Expected box score",
      );
      // Capital B on purpose: the BUTTON reads "What about a best of seven?",
      // the rendered series header reads "Best of seven · DEN holds home
      // court". Matching case distinguishes the answer from the invitation.
      await clickUntilText(
        page,
        page.getByRole("button", { name: /best of seven/i }),
        "Best of seven",
      );
    },
  },
  // Team and player names are the landmarks wherever there is one: they are
  // real-NBA facts the page can only show if the bundle actually reached the
  // read model, where a line of copy is something an editing pass can move.
  { id: "teams", path: "/hoops/teams", landmark: "Denver Nuggets" },
  { id: "team-DEN", path: "/hoops/teams/DEN", landmark: "Denver Nuggets" },
  { id: "players", path: "/hoops/players", landmark: "Nikola Jokic" },
  { id: "player-3112335", path: "/hoops/players/3112335", landmark: "How we got there" },
  // Jokić vs Wembanyama: one man with a plus-minus history half and one
  // without, the two ledger shapes the comparison has to lay out side by side.
  {
    id: "compare",
    path: "/hoops/players/compare?a=3112335&b=5104157",
    landmark: "How each rating was built",
  },
  {
    // Redirects to /hoops/game/<runId>; playwright follows it.
    id: "game",
    path: "/hoops/game/new?home=DEN&away=OKC",
    landmark: "one simulated game",
  },
];

// ── login (the check:tracking-hidden pattern) ──────────────────────────────
//
// Locally the dev server runs with no FEED_PASSWORD and the middleware
// fail-opens, so no login is needed and none is attempted.

async function login() {
  if (!PASSWORD) return null;
  const res = await fetch(`${FEED_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(PASSWORD)}`,
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`login failed (HTTP ${res.status})`);
  const [pair] = setCookie.split(";");
  const idx = pair.indexOf("=");
  return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
}

// ── the in-page assertions ─────────────────────────────────────────────────
//
// One evaluate per page/width. Returns plain data (never element handles) so
// the reporting below can print tag + classes + text without a second round
// trip.

// 🔴 `innerText` is NOT usable for assertion (d): it applies CSS
// `text-transform`, and much of this section is styled `uppercase`, so
// "How this rating is built" comes back as "HOW THIS RATING IS BUILT" and every
// landmark silently misses. `textContent` is the opposite trap — it includes
// Next's RSC flight payload inside `<script>`, so a page that rendered NOTHING
// would still "contain" its own landmark and the check would pass on a blank
// screen. So: walk the text nodes, skip the ones that are not rendered, and
// keep the author's own casing.
const VISIBLE_TEXT = `(() => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || SKIP.has(el.tagName)) continue;
    const shown =
      typeof el.checkVisibility === "function" ? el.checkVisibility() : el.offsetParent !== null;
    if (!shown) continue;
    if (n.nodeValue && n.nodeValue.trim()) parts.push(n.nodeValue);
  }
  return parts.join(" ").replace(/\\s+/g, " ").trim();
})()`;

const COLLECT = `(() => {
  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim(),
    text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
  });
  const rendered = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const inHorizontalScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    return false;
  };

  const main = document.querySelector("main");
  const out = {
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    hasMain: !!main,
    truncated: [],
    offscreen: [],
    scrollerSkipped: 0,
    text: ${VISIBLE_TEXT},
  };
  if (!main) return out;

  for (const el of main.querySelectorAll(".truncate")) {
    if (el.hasAttribute("data-truncate-ok")) continue;
    if (!rendered(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      out.truncated.push({ ...desc(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
  }

  for (const el of main.querySelectorAll("select, button, a")) {
    if (!rendered(el)) continue;
    if (inHorizontalScroller(el)) { out.scrollerSkipped++; continue; }
    const right = el.getBoundingClientRect().right;
    if (right > window.innerWidth + 1) {
      out.offscreen.push({ ...desc(el), right: Math.round(right * 10) / 10 });
    }
  }
  return out;
})()`;

async function collect(page) {
  return page.evaluate(COLLECT);
}

// Polls the SAME visible-text extraction the assertion uses, rather than
// re-implementing it inside a `waitForFunction` predicate — one definition, so
// a page can never be waited for by one rule and judged by another.
async function waitForText(page, text, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let seen = "";
  for (;;) {
    seen = await page.evaluate(VISIBLE_TEXT);
    if (seen.includes(text)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${Math.round(timeout / 1000)}s waiting for "${text}". ` +
          `On screen: "${seen.slice(0, 200)}"`,
      );
    }
    await page.waitForTimeout(250);
  }
}

// Best-effort: React marks the nodes it owns once hydration has run, so this
// is a real "the page is now interactive" signal rather than a sleep. Never
// fatal — `clickUntilText` is the belt to this braces.
async function waitForHydration(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hydrated = await page.evaluate(() => {
      const keys = (o) => (o ? Object.keys(o) : []);
      if (keys(document.body).some((k) => k.startsWith("__reactContainer$"))) return true;
      const el = document.querySelector("main button, main a, main select");
      return !!el && keys(el).some((k) => k.startsWith("__reactFiber$"));
    });
    if (hydrated || Date.now() > deadline) return;
    await page.waitForTimeout(200);
  }
}

// 🔴 The landmark can be on screen a full second before the page can be
// TAPPED: these pages are server-rendered, so the Sim button exists in the
// HTML while React is still hydrating, and a click that lands in that window
// is swallowed silently — the first version of this gate sat through a 180s
// timeout waiting for a box score it had never actually asked for. So: click,
// watch for the answer, click again if it did not come. Re-simming is
// harmless, and once the answer renders the button is gone (the click below
// then fails and is ignored, which is the success path).
async function clickUntilText(page, locator, text, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await locator.click({ timeout: 10_000 });
    } catch {
      /* gone, covered, or not yet hydrated — the text poll below decides */
    }
    const until = Math.min(Date.now() + 20_000, deadline);
    for (;;) {
      const seen = await page.evaluate(VISIBLE_TEXT);
      if (seen.includes(text)) return;
      if (Date.now() > until) break;
      await page.waitForTimeout(250);
    }
    if (Date.now() > deadline) {
      const seen = await page.evaluate(VISIBLE_TEXT);
      throw new Error(
        `clicked ${attempts}x over ${Math.round(timeout / 1000)}s and "${text}" never appeared. ` +
          `On screen: "${seen.slice(0, 200)}"`,
      );
    }
  }
}

// ── reporting ──────────────────────────────────────────────────────────────

const failures = [];
function fail(msg) {
  failures.push(msg);
}

function describeElement(e) {
  return `<${e.tag}${e.cls ? ` class="${e.cls}"` : ""}> "${e.text}"`;
}

async function shot(page, name) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${name}.png`);
  try {
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch (err) {
    return `(screenshot failed: ${err.message})`;
  }
}

// Assertions (a)-(d) applied to one collected snapshot. Returns a list of
// human-readable problems; empty means the page/width passed.
function judge(snap, spec) {
  const problems = [];
  if (!snap.hasMain) {
    problems.push("no <main> element in the document — the layout did not render");
    return problems;
  }
  // (d) first: everything else is meaningless on a page that did not render.
  if (!snap.text.includes(spec.landmark)) {
    problems.push(
      `(d) landmark text "${spec.landmark}" is missing — the page did not render (dead server, ` +
        `login redirect, or an error page). First 160 chars on screen: "${snap.text.slice(0, 160)}"`,
    );
  }
  // (a)
  if (snap.docScrollWidth > snap.innerWidth) {
    problems.push(
      `(a) the page scrolls sideways: documentElement.scrollWidth ${snap.docScrollWidth} > ` +
        `innerWidth ${snap.innerWidth} (${snap.docScrollWidth - snap.innerWidth}px too wide)`,
    );
  }
  // (b)
  for (const e of snap.truncated) {
    problems.push(
      `(b) text is clipped: ${describeElement(e)} — needs ${e.scrollWidth}px, has ${e.clientWidth}px`,
    );
  }
  // (c)
  for (const e of snap.offscreen) {
    problems.push(
      `(c) control is off the right edge: ${describeElement(e)} — its right edge is at ` +
        `${e.right}px, screen is ${snap.innerWidth}px`,
    );
  }
  return problems;
}

// ── falsification ──────────────────────────────────────────────────────────

async function falsifyOnPage(page, spec, label) {
  const found = [];

  // (a): a 2000px block inside <main> must make the document scroll sideways.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.id = "__falsify_wide__";
    d.setAttribute("style", "width:2000px;height:1px");
    document.querySelector("main").appendChild(d);
  });
  const withWide = await collect(page);
  const wideCaught = withWide.docScrollWidth > withWide.innerWidth;
  found.push({
    assertion: "(a) no horizontal page scroll",
    caught: wideCaught,
    detail: wideCaught
      ? `scrollWidth ${withWide.docScrollWidth} > innerWidth ${withWide.innerWidth} after injecting a 2000px div`
      : `scrollWidth ${withWide.docScrollWidth} vs innerWidth ${withWide.innerWidth} — a 2000px div did NOT trip it`,
  });
  await page.evaluate(() => document.getElementById("__falsify_wide__")?.remove());

  // (b): squeezing a real .truncate element to 20px must clip its text.
  const squeezed = await page.evaluate(() => {
    const main = document.querySelector("main");
    for (const el of main.querySelectorAll(".truncate")) {
      const r = el.getBoundingClientRect();
      const t = (el.innerText || el.textContent || "").trim();
      if (r.width > 40 && t.length > 6) {
        el.setAttribute("data-falsify-prev-style", el.getAttribute("style") || "");
        el.id = el.id || "__falsify_trunc__";
        el.setAttribute(
          "style",
          `${el.getAttribute("data-falsify-prev-style")};display:block;width:20px;max-width:20px`,
        );
        return { id: el.id, text: t.slice(0, 60) };
      }
    }
    return null;
  });
  if (!squeezed) {
    found.push({
      assertion: "(b) nothing is actually truncated",
      caught: false,
      detail: "no rendered .truncate element with text was found inside <main> to squeeze",
    });
  } else {
    const withNarrow = await collect(page);
    const hit = withNarrow.truncated.find((e) => e.clientWidth <= 21);
    found.push({
      assertion: "(b) nothing is actually truncated",
      caught: !!hit,
      detail: hit
        ? `caught "${squeezed.text}" needing ${hit.scrollWidth}px in ${hit.clientWidth}px`
        : `squeezed "${squeezed.text}" to 20px and the check did NOT report it`,
    });
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (el) el.setAttribute("style", el.getAttribute("data-falsify-prev-style") || "");
    }, squeezed.id);
  }

  // (c): a button parked past the right edge must be reported as off screen.
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "__falsify_offscreen__";
    b.textContent = "off the edge";
    b.setAttribute(
      "style",
      `position:absolute;top:0;left:${window.innerWidth + 50}px;width:40px;height:20px`,
    );
    document.querySelector("main").appendChild(b);
  });
  const withOff = await collect(page);
  const offCaught = withOff.offscreen.some((e) => e.text.includes("off the edge"));
  found.push({
    assertion: "(c) every control is on screen",
    caught: offCaught,
    detail: offCaught
      ? `caught a button parked at ${withOff.offscreen.find((e) => e.text.includes("off the edge")).right}px on a ${withOff.innerWidth}px screen`
      : `parked a button past the right edge and the check did NOT report it`,
  });
  await page.evaluate(() => document.getElementById("__falsify_offscreen__")?.remove());

  for (const f of found) {
    const mark = f.caught ? c.green("caught") : c.red("MISSED");
    console.log(`  ${mark} ${label} · ${f.assertion} — ${f.detail}`);
    if (!f.caught) fail(`${label} · ${f.assertion} was NOT falsifiable: ${f.detail}`);
  }
  return found.every((f) => f.caught);
}

// ── main ───────────────────────────────────────────────────────────────────

console.log(
  c.bold(`\nHoops on a phone — ${FEED_BASE}`) +
    c.dim(`  (${WIDTHS.map((w) => `${w.device.viewport.width}px ${w.name}`).join(", ")})`) +
    (FALSIFY ? c.yellow("  [FALSIFY]") : ""),
);

let cookie = null;
try {
  cookie = await login();
  if (cookie) console.log(c.dim(`  authenticated as ${cookie.name}`));
  else console.log(c.dim("  no password given — assuming fail-open auth (local dev)"));
} catch (err) {
  console.log(`${c.red("✗")} ${err.message}`);
  fail(`could not authenticate against ${FEED_BASE}: ${err.message}`);
}

let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
} catch (err) {
  console.log(
    `\n${c.red(c.bold("FAILED"))} — could not launch the installed Google Chrome: ${err.message}\n` +
      `  This gate drives the real Chrome via playwright-core's \`channel: "chrome"\`; it never\n` +
      `  downloads a browser. Install Google Chrome, or run this where it is installed.\n`,
  );
  process.exit(1);
}

let allFalsified = true;
const summary = [];

try {
  for (const { name: deviceName, device } of WIDTHS) {
    const width = device.viewport.width;
    const context = await browser.newContext({ ...device, colorScheme: "dark" });
    if (cookie) {
      const { hostname, protocol } = new URL(FEED_BASE);
      await context.addCookies([
        {
          name: cookie.name,
          value: cookie.value,
          domain: hostname,
          path: "/",
          secure: protocol === "https:",
        },
      ]);
    }

    // ONE page per width, navigated repeatedly. A page per spec exhausted
    // Chrome's tabs on a first run ("Failed to open a new tab") — the player
    // ranking alone is a 10MB full-page screenshot.
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);

    for (const spec of PAGES) {
      const label = `${spec.path} @ ${width}px`;
      const slug = `${spec.id}-${width}`;
      try {
        await page.goto(`${FEED_BASE}${spec.path}`, {
          waitUntil: "domcontentloaded",
          timeout: 120_000,
        });
        await waitForText(page, spec.landmark, 120_000);
        if (spec.prepare) {
          await waitForHydration(page);
          await spec.prepare(page);
        }
        // Let layout settle (fonts, the scroll-into-view the matchup does).
        await page.waitForTimeout(400);

        if (FALSIFY) {
          const ok = await falsifyOnPage(page, spec, label);
          allFalsified = allFalsified && ok;
          continue;
        }

        const snap = await collect(page);
        const problems = judge(snap, spec);
        if (problems.length === 0) {
          console.log(
            `  ${c.green("PASS")} ${label} ${c.dim(
              `· ${snap.docScrollWidth}px wide, ${snap.scrollerSkipped} control(s) inside a horizontal scroller skipped`,
            )}`,
          );
          summary.push({ label, ok: true });
        } else {
          const path = await shot(page, slug);
          console.log(`  ${c.red("FAIL")} ${label}`);
          for (const p of problems) console.log(`       ${p}`);
          console.log(c.dim(`       screenshot: ${path}`));
          for (const p of problems) fail(`${label} — ${p}`);
          summary.push({ label, ok: false, problems });
        }
      } catch (err) {
        const path = await shot(page, `${slug}-error`);
        console.log(`  ${c.red("FAIL")} ${label} — ${err.message.split("\n")[0]}`);
        console.log(c.dim(`       screenshot: ${path}`));
        fail(`${label} — could not be checked: ${err.message.split("\n")[0]}`);
        summary.push({ label, ok: false, problems: [err.message.split("\n")[0]] });
        if (FALSIFY) allFalsified = false;
      }
    }
    await page.close();
    await context.close();
  }
} finally {
  await browser.close();
}

// ── verdict ────────────────────────────────────────────────────────────────

if (FALSIFY) {
  if (allFalsified && failures.length === 0) {
    console.log(
      `\n${c.green(c.bold("FALSIFICATION OK"))} — every injected break was caught on every page ` +
        `at every width: (a) a 2000px-wide element, (b) a \`truncate\` squeezed to 20px, and ` +
        `(c) a button parked past the right edge.\n` +
        `Exiting 1 because --falsify is a self-test, never a green run.\n`,
    );
  } else {
    console.log(
      `\n${c.red(c.bold("FALSIFICATION FAILED"))} — the gate did not catch a break it must catch:\n` +
        failures.map((f) => `  • ${f}`).join("\n") +
        "\n",
    );
  }
  process.exit(1);
}

if (failures.length > 0) {
  console.log(
    `\n${c.red(c.bold(`FAILED — the Hoops section does not fit on a phone (${failures.length} problem(s)):`))}\n` +
      failures.map((f) => `  • ${f}`).join("\n") +
      `\n\nScreenshots in ${OUT_DIR}/\n`,
  );
  process.exit(1);
}
console.log(
  `\n${c.green(c.bold("PASS"))} — ${summary.length} page/width combinations fit on a phone.\n`,
);
