import { execSync } from "child_process";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  cacheOnNavigation: true,
  reloadOnOnline: true,
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
    return execSync("git log -1 --merges --format=%cI").toString().trim() || "";
  } catch {
    return "";
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
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Don't bundle server-only modules on client
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }
    return config;
  },
};

export default withSerwist(nextConfig);
