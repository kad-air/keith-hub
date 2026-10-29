import { execSync } from "child_process";
import withSerwistInit from "@serwist/next";
import { AlphaTabWebPackPlugin } from "@coderline/alphatab-webpack";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  cacheOnNavigation: true,
  // reloadOnOnline is literally `window.addEventListener("online", () =>
  // location.reload())` — on a gig stage with flapping connectivity that
  // reloads a LIVE chart mid-song, killing scroll position and autoscroll.
  // Every page already handles reconnect gracefully (NetworkFirst + the
  // OfflineWarm re-warm on `online`), so the hard reload buys nothing.
  reloadOnOnline: false,
  // Disable SW in dev so HMR isn't fighting cached responses.
  disable: process.env.NODE_ENV === "development",
});

// Bake git metadata into the build so the app menu can show version info.
// Railway builds may not have .git — fall back to RAILWAY_GIT_COMMIT_SHA.
const GIT_COMMIT = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return (process.env.RAILWAY_GIT_COMMIT_SHA || "unknown").slice(0, 7);
  }
})();
const GIT_LAST_MERGE_TS = (() => {
  try {
    return execSync("git log -1 --format=%cI").toString().trim() || "";
  } catch {
    return new Date().toISOString();
  }
})();

const nextConfig = {
  // Allow better-sqlite3 to be used server-side only
  experimental: {
    instrumentationHook: true,
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: GIT_COMMIT,
    NEXT_PUBLIC_GIT_LAST_MERGE_TS: GIT_LAST_MERGE_TS,
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || "",
  },
  // Hoops split into two areas (2026-10-29): the real games under
  // /hoops/scores and the hoops-sim studio under /hoops/sim. The sim pages
  // and the standings used to sit directly under /hoops, so their old URLs
  // (bookmarks, shared sim runs, links the Mac Mini prints) redirect here.
  // Query strings ride along. Temporary (307), so a later move can't be
  // pinned by a browser's redirect cache.
  async redirects() {
    const moved = [
      ["/hoops/matchup", "/hoops/sim/matchup"],
      ["/hoops/teams", "/hoops/sim/teams"],
      ["/hoops/players", "/hoops/sim/players"],
      ["/hoops/game", "/hoops/sim/game"],
      ["/hoops/projections", "/hoops/sim/projections"],
      ["/hoops/standings", "/hoops/scores/standings"],
    ];
    return moved.flatMap(([from, to]) => [
      { source: from, destination: to, permanent: false },
      { source: `${from}/:path*`, destination: `${to}/:path*`, permanent: false },
    ]);
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Don't bundle server-only modules on client
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
      // Wire up alphatab's web worker + audio worklet so the layout worker
      // and the player actually spawn in the Next.js bundle. Without this,
      // `new URL('./alphaTab.worker.mjs', import.meta.url)` inside alphatab
      // never resolves to an emitted chunk, renderFinished never fires, and
      // the viewer hangs on "Rendering tab…". Fonts + soundfont are already
      // committed in public/alphatab/, so skip the plugin's asset copy.
      config.plugins.push(
        new AlphaTabWebPackPlugin({ assetOutputDir: false }),
      );
    }
    return config;
  },
};

export default withSerwist(nextConfig);
