#!/usr/bin/env node
/**
 * Generate PWA icon PNGs from the SVG sources using sharp.
 *
 * Usage: node scripts/generate-icons.mjs
 *
 * Outputs:
 *   public/icons/icon-192.png       (192×192, from icon.svg)
 *   public/icons/icon-512.png       (512×512, from icon.svg)
 *   public/icons/icon-512-maskable.png (512×512, from icon-maskable.svg)
 *   public/icons/apple-touch-icon.png  (180×180, from icon.svg)
 *   public/icons/favicon-32.png     (32×32, from icon.svg)
 */

import sharp from "sharp";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, "../public/icons");

const regularSvg = readFileSync(resolve(iconsDir, "icon.svg"));
const maskableSvg = readFileSync(resolve(iconsDir, "icon-maskable.svg"));

const targets = [
  { name: "icon-192.png", size: 192, svg: regularSvg },
  { name: "icon-512.png", size: 512, svg: regularSvg },
  { name: "icon-512-maskable.png", size: 512, svg: maskableSvg },
  { name: "apple-touch-icon.png", size: 180, svg: regularSvg },
  { name: "favicon-32.png", size: 32, svg: regularSvg },
];

for (const { name, size, svg } of targets) {
  const out = resolve(iconsDir, name);
  await sharp(svg, { density: Math.ceil((size / 1024) * 72 * 4) })
    .resize(size, size)
    .png()
    .toFile(out);
  console.log(`  ✓ ${name} (${size}×${size})`);
}

console.log("\nDone — all icons generated.");
