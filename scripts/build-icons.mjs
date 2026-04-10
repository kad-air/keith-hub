#!/usr/bin/env node
// Rasterize public/icons/icon.svg into the PWA icon set.
// Run manually whenever the source SVG changes:
//   node scripts/build-icons.mjs

import sharp from "sharp";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "..", "public", "icons");

const sourceSvg = readFileSync(join(iconsDir, "icon.svg"));
const maskableSvg = readFileSync(join(iconsDir, "icon-maskable.svg"));

async function build() {
  // Standard "any" icons — full bleed F.
  await sharp(sourceSvg, { density: 384 })
    .resize(192, 192)
    .png()
    .toFile(join(iconsDir, "icon-192.png"));

  await sharp(sourceSvg, { density: 384 })
    .resize(512, 512)
    .png()
    .toFile(join(iconsDir, "icon-512.png"));

  // Apple touch icon — iOS ignores manifest icons, uses this one.
  // 180x180, opaque, square (iOS rounds the corners itself).
  await sharp(sourceSvg, { density: 384 })
    .resize(180, 180)
    .flatten({ background: "#0c0a08" })
    .png()
    .toFile(join(iconsDir, "apple-touch-icon.png"));

  // Maskable icon — Android adaptive icons crop into circles/squircles,
  // so the F is inset to ~60% of the safe area in the dedicated SVG.
  await sharp(maskableSvg, { density: 384 })
    .resize(512, 512)
    .png()
    .toFile(join(iconsDir, "icon-512-maskable.png"));

  // Favicon for desktop browser tabs.
  await sharp(sourceSvg, { density: 192 })
    .resize(32, 32)
    .png()
    .toFile(join(iconsDir, "favicon-32.png"));

  console.log("✓ Icons written to public/icons/");
}

build().catch((err) => {
  console.error("Icon build failed:", err);
  process.exit(1);
});
