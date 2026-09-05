// Resolve hook so plain `node` can execute the app's TypeScript modules
// directly against the REAL code — the same idea as the hoops/books checks,
// which use explicit `.ts` relative imports. The feed modules (lib/fetcher.ts,
// lib/queries.ts, lib/config.ts, lib/bluesky.ts) are older and use Next's
// `@/` alias plus extensionless relative specifiers, which Node's type
// stripping cannot resolve on its own. This hook maps `@/x` → `<repo>/x.ts`
// and `./x` → `./x.ts` (or `/index.ts`) when the extensionless file exists.
//
// Use: node --import ./scripts/lib/ts-resolve-hooks.mjs scripts/check-feed-dedup.ts
import { registerHooks } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function firstExisting(base) {
  for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
    const candidate = base + suffix;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const hit = firstExisting(path.join(repoRoot, specifier.slice(2)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    } else if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !/\.(m?[jt]sx?|json|node)$/.test(specifier)
    ) {
      const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
      const hit = firstExisting(base);
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
