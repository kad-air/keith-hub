import { crc32, deflateRawSync } from "zlib";

// A minimal, deterministic ZIP writer.
//
// 🔴 Why this exists rather than adm-zip (which the rest of lib/books/ uses to
// READ): adm-zip cannot emit a spec-conforming EPUB. Measured directly — it
// sorts entries alphabetically, so `mimetype` stops being the first record,
// and it ignores a per-entry STORED override, so `mimetype` is deflated. OCF
// requires that entry first and uncompressed. adm-zip stays the reader; this
// is the writer, used on the ONE path that has to rebuild an archive
// (lib/books/adept.ts, stripping DRM).
//
// Deterministic on purpose: fixed DOS timestamps and a fixed compression
// choice mean the same input bytes always produce the same output bytes. That
// is what lets check:books:drm pin a decrypted result by hash — and, more
// importantly, it means re-running a decrypt can never silently mint a new
// partial_md5 for a book already synced to a device (BOOKS_PLAN §4).

export type ZipEntry = {
  name: string;
  data: Buffer;
  /** STORED rather than DEFLATE. Required for `mimetype`. */
  store?: boolean;
};

// 1980-01-01 00:00:00 in DOS format — the epoch of the field, so nothing here
// varies with when the decrypt ran.
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/**
 * Build a ZIP archive. Entries are written in the order given — the caller is
 * responsible for putting `mimetype` first when writing an EPUB (see
 * `writeEpub` below, which enforces it).
 */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data) >>> 0;
    const uSize = entry.data.length;

    // Deflate only when it actually helps; a store that grows the file is
    // the worst of both worlds. `mimetype` is forced STORED by the caller.
    let method = 0;
    let payload = entry.data;
    if (!entry.store) {
      const deflated = deflateRawSync(entry.data);
      if (deflated.length < uSize) {
        method = 8;
        payload = deflated;
      }
    }
    const cSize = payload.length;
    if (uSize > 0xffffffff || cSize > 0xffffffff) {
      throw new Error(`zip: entry ${entry.name} exceeds 4GB (zip64 unsupported)`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags — no data descriptor, sizes are known
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(cSize, 18);
    local.writeUInt32LE(uSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(cSize, 20);
    central.writeUInt32LE(uSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // relative offset of local header
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...locals, cd, eocd]);
}

/**
 * Build an EPUB: `mimetype` first and STORED, everything else in the order
 * given. Pass entries WITHOUT a mimetype record — it is written here so the
 * OCF requirement can't be forgotten at a call site.
 */
export function writeEpub(entries: ZipEntry[]): Buffer {
  const rest = entries.filter((e) => e.name !== "mimetype");
  return writeZip([
    { name: "mimetype", data: Buffer.from("application/epub+zip", "ascii"), store: true },
    ...rest,
  ]);
}
