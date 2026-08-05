// blake2b, enough of it to reproduce hoops-sim's key/counter derivation.
//
// Why hand-rolled rather than node:crypto — the engine runs in the BROWSER
// too (live re-simulation while editing a roster is the whole point of the
// studio), and Web Crypto has no blake2b. This is the same code both sides.
//
// Unkeyed, one-shot, digest sizes 1–64 bytes. That's all `hoops.rng` uses.
// Correctness is asserted against node:crypto's blake2b512 AND against
// Python's hashlib output in the fixture — see scripts/check-hoops-fixture.ts.

const IV: bigint[] = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

// prettier-ignore
const SIGMA: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const MASK64 = (1n << 64n) - 1n;

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

class Blake2b {
  private h: bigint[];
  private buf = new Uint8Array(128);
  private bufLen = 0;
  private counter = 0n;
  private readonly digestSize: number;

  constructor(digestSize: number) {
    if (digestSize < 1 || digestSize > 64) {
      throw new Error(`blake2b: digest size ${digestSize} out of range`);
    }
    this.digestSize = digestSize;
    this.h = IV.slice();
    // Parameter block: digest length, key length (0), fanout 1, depth 1.
    this.h[0] ^= 0x01010000n ^ BigInt(digestSize);
  }

  private compress(block: Uint8Array, offset: number, last: boolean): void {
    const m: bigint[] = new Array(16);
    for (let i = 0; i < 16; i++) {
      let v = 0n;
      for (let j = 7; j >= 0; j--) {
        v = (v << 8n) | BigInt(block[offset + i * 8 + j]);
      }
      m[i] = v;
    }

    const v: bigint[] = this.h.concat(IV);
    v[12] ^= this.counter & MASK64;
    v[13] ^= (this.counter >> 64n) & MASK64;
    if (last) v[14] ^= MASK64;

    const mix = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
      v[a] = (v[a] + v[b] + x) & MASK64;
      v[d] = rotr64(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & MASK64;
      v[b] = rotr64(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & MASK64;
      v[d] = rotr64(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & MASK64;
      v[b] = rotr64(v[b] ^ v[c], 63n);
    };

    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r];
      mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
      mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
      mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
      mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
      mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
      mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
      mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
      mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }

    for (let i = 0; i < 8; i++) {
      this.h[i] = this.h[i] ^ v[i] ^ v[i + 8];
    }
  }

  update(data: Uint8Array): this {
    for (let i = 0; i < data.length; i++) {
      // blake2b only compresses a full block once it knows more data follows,
      // so the final block can be flagged. Hence the "buffer is full AND
      // there's another byte" condition rather than a plain flush.
      if (this.bufLen === 128) {
        this.counter += 128n;
        this.compress(this.buf, 0, false);
        this.bufLen = 0;
      }
      this.buf[this.bufLen++] = data[i];
    }
    return this;
  }

  digest(): Uint8Array {
    this.counter += BigInt(this.bufLen);
    this.buf.fill(0, this.bufLen);
    this.compress(this.buf, 0, true);

    const out = new Uint8Array(this.digestSize);
    for (let i = 0; i < this.digestSize; i++) {
      out[i] = Number((this.h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
    }
    return out;
  }
}

export function blake2b(data: Uint8Array, digestSize: number): Uint8Array {
  return new Blake2b(digestSize).update(data).digest();
}

/** Incremental form, for the length-prefixed multi-part digest in rng.ts. */
export function blake2bHasher(digestSize: number): {
  update: (d: Uint8Array) => void;
  digest: () => Uint8Array;
} {
  const h = new Blake2b(digestSize);
  return { update: (d) => void h.update(d), digest: () => h.digest() };
}
