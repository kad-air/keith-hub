// Philox4x64-10 and the slice of numpy's `Generator` that hoops.rng uses.
//
// 🔴 This is a SECOND IMPLEMENTATION of a validated generator, which is the
// single most-repeated bug shape in this project family. Every claim below is
// asserted against the Python side by the shared fixture — see
// scripts/check-hoops-fixture.ts. Do not "tidy" anything here without
// re-running it.
//
// Philox rather than PCG64 (HOOPS_PLAN.md §6 said PCG64; it was wrong, and
// this is the lucky direction to be wrong in): Philox is counter-based,
// block-cipher-style lane arithmetic, so it ports with plain 64-bit lane math
// and no 128-bit multiply. numpy: `np.random.Philox(key=..., counter=...)`.
//
// Implementation note: BigInt, deliberately. It is the readable version, and
// it is what the fixture was first proven against. If a season simulation
// ever needs more throughput, the place to optimise is here (32-bit limbs) —
// with the fixture as the safety net that the optimisation didn't change a
// single draw.

import {
  ZIGGURAT_FI,
  ZIGGURAT_KI,
  ZIGGURAT_NOR_INV_R,
  ZIGGURAT_NOR_R,
  ZIGGURAT_WI,
} from "./ziggurat.ts";

const MASK64 = (1n << 64n) - 1n;
const MASK32 = (1n << 32n) - 1n;

const PHILOX_M0 = 0xd2e7470ee14c6c93n;
const PHILOX_M1 = 0xca5a826395121157n;
const PHILOX_W0 = 0x9e3779b97f4a7c15n; // golden ratio
const PHILOX_W1 = 0xbb67ae8584caa73bn; // sqrt(3) - 1
const PHILOX_ROUNDS = 10;

/** 64×64 → (hi, lo), via 32-bit limbs. BigInt would do this natively with a
 *  128-bit product, but doing it in limbs keeps the two halves explicit. */
function mulhilo64(a: bigint, b: bigint): [bigint, bigint] {
  const product = a * b;
  return [(product >> 64n) & MASK64, product & MASK64];
}

function philoxRound(ctr: bigint[], key: bigint[]): bigint[] {
  const [hi0, lo0] = mulhilo64(PHILOX_M0, ctr[0]);
  const [hi1, lo1] = mulhilo64(PHILOX_M1, ctr[2]);
  return [hi1 ^ ctr[1] ^ key[0], lo1, hi0 ^ ctr[3] ^ key[1], lo0];
}

function philox4x64(ctr: bigint[], key: bigint[]): bigint[] {
  let c = ctr;
  let k = key.slice();
  for (let r = 0; r < PHILOX_ROUNDS; r++) {
    if (r > 0) {
      k = [(k[0] + PHILOX_W0) & MASK64, (k[1] + PHILOX_W1) & MASK64];
    }
    c = philoxRound(c, k);
  }
  return c;
}

/**
 * numpy's `Generator(Philox(key, counter))`, to the extent hoops.rng uses it:
 * `random_raw`, `random` (uniform double), `standard_normal` (ziggurat).
 */
export class PhiloxGenerator {
  private readonly key: bigint[];
  private ctr: bigint[];
  private buffer: bigint[] = [0n, 0n, 0n, 0n];
  private bufferPos = 4; // == PHILOX_BUFFER_SIZE: nothing buffered yet

  constructor(key: bigint, counter: bigint) {
    this.key = [key & MASK64, (key >> 64n) & MASK64];
    this.ctr = [
      counter & MASK64,
      (counter >> 64n) & MASK64,
      (counter >> 128n) & MASK64,
      (counter >> 192n) & MASK64,
    ];
  }

  /** Increment the 256-bit counter by one, with carry across the four lanes. */
  private advanceCounter(): void {
    for (let i = 0; i < 4; i++) {
      this.ctr[i] = (this.ctr[i] + 1n) & MASK64;
      if (this.ctr[i] !== 0n) break;
    }
  }

  /** One raw uint64. numpy advances the counter BEFORE filling the buffer, so
   *  the first block a fresh generator emits is block (counter + 1) — proven
   *  by the fixture's raw_generator_output rung, not assumed. */
  nextUint64(): bigint {
    if (this.bufferPos < 4) {
      return this.buffer[this.bufferPos++];
    }
    this.advanceCounter();
    this.buffer = philox4x64(this.ctr, this.key);
    this.bufferPos = 1;
    return this.buffer[0];
  }

  randomRaw(n: number): bigint[] {
    const out: bigint[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.nextUint64();
    return out;
  }

  /** numpy's next_double for a 64-bit bit generator: the top 53 bits scaled. */
  nextDouble(): number {
    return Number(this.nextUint64() >> 11n) * (1.0 / 9007199254740992.0);
  }

  /** `Generator.random(n)`. */
  random(n: number): Float64Array {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.nextDouble();
    return out;
  }

  /**
   * `Generator.standard_normal(n)` — numpy's 256-level ziggurat
   * (distributions.c `random_standard_normal`), ported branch for branch
   * including the tail loop's log1p form and the wedge's exp comparison.
   */
  standardNormalOne(): number {
    for (;;) {
      const r = this.nextUint64();
      const idx = Number(r & 0xffn);
      const r8 = r >> 8n;
      const sign = Number(r8 & 0x1n);
      const rabs = (r8 >> 1n) & 0x000fffffffffffffn;
      const rabsNum = Number(rabs);
      let x = rabsNum * ZIGGURAT_WI[idx];
      if (sign & 0x1) x = -x;
      // 99.3% of draws leave here. rabs < 2^52 and every ki entry is below
      // 2^53, so the comparison is exact in doubles — no BigInt needed.
      if (rabsNum < ZIGGURAT_KI[idx]) return x;

      if (idx === 0) {
        for (;;) {
          // 1.0 - U rather than U, to avoid log(0) — numpy GH-13361.
          const xx = -ZIGGURAT_NOR_INV_R * Math.log1p(-this.nextDouble());
          const yy = -Math.log1p(-this.nextDouble());
          if (yy + yy > xx * xx) {
            return (rabs >> 8n) & 0x1n
              ? -(ZIGGURAT_NOR_R + xx)
              : ZIGGURAT_NOR_R + xx;
          }
        }
      } else {
        if (
          (ZIGGURAT_FI[idx - 1] - ZIGGURAT_FI[idx]) * this.nextDouble() +
            ZIGGURAT_FI[idx] <
          Math.exp(-0.5 * x * x)
        ) {
          return x;
        }
      }
    }
  }

  standardNormal(n: number): Float64Array {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.standardNormalOne();
    return out;
  }
}

export { MASK32, MASK64 };
