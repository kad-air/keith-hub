// Port of hoops-sim's `hoops.rng` — the counter-based RNG that makes every
// draw a pure function of its coordinates `(run_id, purpose, *coords)`.
//
// Read the Python module's docstring for WHY (it is the better explanation);
// the short version is that common random numbers only work if two runs that
// differ in a model parameter consume the same uniforms at the same
// coordinates. A sequential stream cannot do that and cannot be retrofitted:
// editing one player changes how many draws are consumed before possession
// 700, so everything after desyncs, the pairing is silently lost, and nothing
// crashes to tell you.
//
// Two details are load-bearing and are asserted by the shared fixture:
//
//   1. Keys come from blake2b, never a language hash. Coordinates are
//      LENGTH-PREFIXED (8-byte little-endian length before each part) so that
//      ("ab","c") and ("a","bc") cannot collide into one stream.
//   2. The replicate index is the position along the stream, never part of
//      the key — one call returns n draws for one coordinate, so replicate i
//      of the baseline pairs with replicate i of the counterfactual.

import { blake2bHasher } from "./blake2b.ts";
import { PhiloxGenerator } from "./philox.ts";

const KEY_BYTES = 16; // Philox 128-bit key
const COUNTER_BYTES = 32; // Philox 256-bit counter

/** Namespace prefix, so a run_id reused elsewhere can't collide. */
export const RNG_NAMESPACE = "hoops-sim/rng/v1";

export type Coord = string | number | boolean;

const encoder = new TextEncoder();

/** Python: `str(part).encode("utf-8")`. Only the types hoops uses as
 *  coordinates are supported, because Python's str() of anything else is not
 *  something a TS port should be guessing at. */
function pythonStr(part: Coord): string {
  if (typeof part === "string") return part;
  if (typeof part === "boolean") return part ? "True" : "False";
  if (Number.isInteger(part)) return String(part);
  throw new Error(
    `rng: coordinate ${String(part)} is a non-integer number — Python's str() ` +
      `formatting of floats is not reproduced here on purpose. Use an integer or a string.`,
  );
}

/** Length-prefixed blake2b over the coordinates → a little-endian integer. */
export function digestInt(nbytes: number, parts: Coord[]): bigint {
  const h = blake2bHasher(nbytes);
  const len = new Uint8Array(8);
  for (const part of parts) {
    const b = encoder.encode(pythonStr(part));
    // 8-byte little-endian length prefix — Python's len(b).to_bytes(8,"little")
    let n = b.length;
    for (let i = 0; i < 8; i++) {
      len[i] = n & 0xff;
      n >>>= 8;
    }
    h.update(len);
    h.update(b);
  }
  const digest = h.digest();
  let v = 0n;
  for (let i = digest.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(digest[i]); // int.from_bytes(..., "little")
  }
  return v;
}

/**
 * The digest rendered the way the Python fixture records it: as the hex of
 * the little-endian *integer*, i.e. the digest bytes reversed. Keep this
 * matching `hex(_digest_int(...))` on the hoops-sim side, not the raw digest
 * byte order — they differ, and only one of them is what the fixture pins.
 */
export function digestHex(nbytes: number, parts: Coord[]): string {
  return digestInt(nbytes, parts)
    .toString(16)
    .padStart(nbytes * 2, "0");
}

/** A generator depending ONLY on (run_id, purpose, *coords) — never on call order. */
export function stream(runId: string, purpose: string, ...coords: Coord[]): PhiloxGenerator {
  const key = digestInt(KEY_BYTES, [RNG_NAMESPACE, runId]);
  const counter = digestInt(COUNTER_BYTES, [purpose, ...coords]);
  return new PhiloxGenerator(key, counter);
}

/** `n` uniforms in [0,1) for one draw site. Element i belongs to replicate i. */
export function uniform(
  n: number,
  runId: string,
  purpose: string,
  ...coords: Coord[]
): Float64Array {
  return stream(runId, purpose, ...coords).random(n);
}

/** `n` standard normals for one draw site. Element i belongs to replicate i. */
export function normal(
  n: number,
  runId: string,
  purpose: string,
  ...coords: Coord[]
): Float64Array {
  return stream(runId, purpose, ...coords).standardNormal(n);
}

/** A stable run_id from descriptive parts. Deliberately not random. */
export function spawnRunId(...parts: Coord[]): string {
  const v = digestInt(8, parts);
  // .to_bytes(8, "little").hex()
  let out = "";
  let x = v;
  for (let i = 0; i < 8; i++) {
    out += Number(x & 0xffn)
      .toString(16)
      .padStart(2, "0");
    x >>= 8n;
  }
  return out;
}
