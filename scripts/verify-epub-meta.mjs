// Dev sanity: run extractEpubMeta over every epub in /Volumes/HDD/Books and
// print what lands. Not a gate — extraction is allowed to return nulls.
import { extractEpubMeta } from "../lib/books/epubMeta.ts";
import fs from "node:fs";
import path from "node:path";

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.toLowerCase().endsWith(".epub")) yield p;
  }
}

for (const p of walk("/Volumes/HDD/Books")) {
  const m = extractEpubMeta(fs.readFileSync(p));
  const series = m.series ? ` [${m.series} #${m.seriesIndex ?? "?"}]` : "";
  const cover = m.cover ? `cover ${m.cover.ext} ${(m.cover.bytes.length / 1024).toFixed(0)}KB` : "NO COVER";
  console.log(`${path.basename(p)}\n  → "${m.title}" by ${m.author}${series} (${m.language ?? "?"}) ${cover}`);
}
