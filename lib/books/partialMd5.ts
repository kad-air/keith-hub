import { createHash } from "crypto";

// The KOReader "partial MD5" document id — the content key the whole kosync
// protocol hangs on. Every client computes this over the file bytes it holds:
//
//   KOReader  frontend/util.lua partialMD5:   step,size = 1024,1024
//                                             for i = -1,10: seek(lshift(step, 2*i)); read(size)
//   CrossPoint lib/KOReaderSync/KOReaderDocumentId.cpp: CHUNK_SIZE=1024,
//                                             OFFSET_COUNT=12, offsets 1024 << 2i
//
// LuaJIT's bit.lshift is 32-bit, so lshift(1024, -2) ≡ 1024 << 30 mod 2^32 = 0
// — i.e. the i = -1 iteration reads from offset ZERO, not offset 256. The
// Python reference in ~/Code/stump/MAC-MINI-DEPLOYMENT-PLAN.md encodes the
// same thing explicitly (`off = 0 if i < 0 else 1024 << (2*i)`), and that
// implementation was verified byte-for-byte against Stump's stored
// koreader_hash values for the real library on 2026-08-16.
//
// Offsets are strictly increasing (0, 1KiB, 4KiB, 16KiB, … 1GiB), so KOReader's
// "break on failed read" and the reference's "skip when off >= size" are
// equivalent; a read that straddles EOF contributes its partial bytes.
//
// 🔴 Do not "improve" this: it must agree bit-for-bit with the devices, and
// check:books:kosync asserts it against an independently computed fixture.
export function partialMd5(bytes: Buffer): string {
  const md5 = createHash("md5");
  const size = bytes.length;
  for (let i = -1; i <= 10; i++) {
    const offset = i < 0 ? 0 : 1024 * Math.pow(4, i);
    if (offset >= size) continue;
    md5.update(bytes.subarray(offset, Math.min(offset + 1024, size)));
  }
  return md5.digest("hex");
}
