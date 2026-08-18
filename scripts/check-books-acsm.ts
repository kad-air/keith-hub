#!/usr/bin/env node
//
// 🔴 THE ADEPT SIGNATURE GATE.
//
//   npm run check:books:acsm   (standalone)
//   npm run build              (via prebuild)
//
// One property: the bytes we sign, and the signature we produce, match an
// INDEPENDENT implementation exactly.
//
// Why this is the thing worth pinning. Fulfilling an .acsm means asking Adobe
// for a book, and Adobe only answers a request signed over a byte-exact
// canonical serialisation of the request tree — element namespaces and local
// names, attributes sorted, text length-prefixed and chunked, each preceded by
// a type tag, with adept:signature/adept:hmac excluded. Get ONE byte wrong and
// every fulfilment fails with an opaque server error that says nothing about
// which byte. There is no partial credit and no useful diagnostic, so the
// canonicalisation is pinned against reference values produced by Leseratte10's
// Python (libadobe.hash_node_ctx + CustomRSA) in books-fixture/.
//
// 🔴 The signature is NOT a standard RSA signature. It is textbook RSA over
// `00 01 FF..FF 00 <sha1>` with NO DigestInfo prefix, so crypto.sign() cannot
// produce it — asserted below, because reaching for the built-in is the
// obvious "cleanup" a future reader would try.
//
// 🔴 WHAT THIS GATE DOES NOT COVER: the live HTTP exchange (Auth,
// InitLicenseService, Fulfill, download). That needs a real, unexpired token
// and a network, so it cannot run in a build. It was verified once, by hand,
// against a real Google Play Books purchase — see CLAUDE.md.
import fs from "node:fs";
import path from "node:path";
import { constants, createPrivateKey, createSign, privateDecrypt } from "node:crypto";

const repoRoot = path.dirname(new URL(import.meta.url).pathname) + "/..";
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, "books-fixture/adept-hash-cases.json"), "utf8"),
);
const testKeys = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, "books-fixture/adept-test-keys.json"), "utf8"),
);

const { parseXml, canonicalBytes, serializeXml } = await import("../lib/books/adeptXml.ts");
const { hashNode, signNode } = await import("../lib/books/adeptSign.ts");
const { isFulfillmentToken } = await import("../lib/books/acsm.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("check:books:acsm — the signature matches an independent implementation\n");

// ── 1. Canonical hash, every case ─────────────────────────────────────────
console.log("canonicalisation (vs Python reference)");
let cases = 0;
for (const [name, c] of Object.entries<any>(fixture.cases)) {
  const mine = hashNode(parseXml(c.xml)).toString("hex");
  assert(mine === c.sha1, `sha1 matches for "${name}"`);
  cases++;
}
assert(cases >= 6, `all ${cases} reference cases were exercised`);

// ── 2. The signature itself ───────────────────────────────────────────────
console.log("\nsignature");
const signingKey = Buffer.from(testKeys.right_private_pkcs8_der_b64, "base64");
const real = fixture.cases.synthetic_fulfill_request;
assert(real != null, "the fulfil-request case is present");
const sig = signNode(parseXml(real.xml), signingKey);
assert(
  sig === real.signature_b64,
  "🔴 the signature is byte-identical to the Python reference",
);

// 🔴 Reaching for crypto.sign() is the obvious future "cleanup". It adds a
// DigestInfo prefix Adobe does not expect, so it must NOT match.
const builtin = createSign("sha1").update(canonicalBytes(parseXml(real.xml))).sign(
  createPrivateKey({ key: signingKey, format: "der", type: "pkcs8" }),
  "base64",
);
assert(
  builtin !== real.signature_b64,
  "🔴 crypto.sign('sha1') does NOT match — the DigestInfo prefix is why this is hand-rolled",
);

// The raw private-key operation is the whole trick; prove it inverts.
const digest = hashNode(parseXml(real.xml));
const keyObj = createPrivateKey({ key: signingKey, format: "der", type: "pkcs8" });
const size = keyObj.asymmetricKeyDetails!.modulusLength! / 8;
const block = Buffer.concat([
  Buffer.from([0x00, 0x01]),
  Buffer.alloc(size - digest.length - 3, 0xff),
  Buffer.from([0x00]),
  digest,
]);
assert(
  privateDecrypt({ key: keyObj, padding: constants.RSA_NO_PADDING }, block).toString("base64") ===
    sig,
  "the padded block put through the raw RSA operation reproduces the signature",
);

// ── 3. Canonicalisation rules that a rewrite would plausibly break ────────
console.log("\ncanonicalisation rules (structural)");
const withSig = parseXml(
  `<adept:x xmlns:adept="http://ns.adobe.com/adept"><adept:a>keep</adept:a>` +
    `<adept:signature>DROP</adept:signature></adept:x>`,
);
const withoutSig = parseXml(
  `<adept:x xmlns:adept="http://ns.adobe.com/adept"><adept:a>keep</adept:a></adept:x>`,
);
assert(
  canonicalBytes(withSig).equals(canonicalBytes(withoutSig)),
  "🔴 adept:signature is excluded from the hash (it is what the hash produces)",
);

const attrsA = parseXml(`<r xmlns="http://x/" b="2" a="1"/>`);
const attrsB = parseXml(`<r xmlns="http://x/" a="1" b="2"/>`);
assert(
  canonicalBytes(attrsA).equals(canonicalBytes(attrsB)),
  "attribute order in the source does not change the hash (they are sorted)",
);

const nsA = parseXml(`<adept:r xmlns:adept="http://ns.adobe.com/adept"/>`);
const nsB = parseXml(`<r xmlns="http://ns.adobe.com/adept"/>`);
assert(
  canonicalBytes(nsA).equals(canonicalBytes(nsB)),
  "prefix vs default namespace spelling does not change the hash",
);
const nsC = parseXml(`<r xmlns="http://elsewhere/"/>`);
assert(
  !canonicalBytes(nsA).equals(canonicalBytes(nsC)),
  "…but a DIFFERENT namespace does",
);

// UTF-8 length prefixes are byte counts, not character counts.
const ascii = canonicalBytes(parseXml(`<a xmlns="http://n/"><b>abcd</b></a>`));
const multi = canonicalBytes(parseXml(`<a xmlns="http://n/"><b>café</b></a>`));
assert(
  multi.length === ascii.length + 1,
  "🔴 string lengths are UTF-8 BYTE counts (é costs two), not character counts",
);

// Text is trimmed, matching the reference's .strip().
assert(
  canonicalBytes(parseXml(`<a xmlns="http://n/"><b>  hi  </b></a>`)).equals(
    canonicalBytes(parseXml(`<a xmlns="http://n/"><b>hi</b></a>`)),
  ),
  "surrounding whitespace in text nodes is trimmed",
);

// ── 4. Parser behaviours the signature depends on ─────────────────────────
console.log("\nparser");
const doc = parseXml(
  `<?xml version="1.0"?><!-- c --><adept:fulfill xmlns:adept="http://ns.adobe.com/adept" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/"><adept:user>u</adept:user>` +
    `<dc:title>T</dc:title><empty/></adept:fulfill>`,
);
assert(doc.name === "fulfill" && doc.ns === "http://ns.adobe.com/adept", "root resolves");
assert(doc.children.length === 3, "declaration and comment are skipped, children counted");
assert(
  doc.children[1].ns === "http://purl.org/dc/elements/1.1/",
  "a second namespace prefix resolves independently",
);
assert(
  parseXml(`<r xmlns="http://x/"><c a="1"/></r>`).children[0].attrs[0].ns === "",
  "🔴 an unprefixed ATTRIBUTE is in no namespace (unlike an unprefixed element)",
);
assert(
  parseXml(`<r xmlns="http://x/">&amp;&lt;&gt;&quot;caf&#233;</r>`).text === `&<>"café`,
  "entities are decoded",
);
assert(
  parseXml(`<r xmlns="http://x/"><![CDATA[a<b]]></r>`).text === "a<b",
  "CDATA is taken literally",
);

// Round-tripping the embedded ACSM must not disturb its hash.
const acsmXml = real.xml.slice(real.xml.indexOf("<fulfillmentToken"));
const acsmEnd = acsmXml.indexOf("</fulfillmentToken>") + "</fulfillmentToken>".length;
const acsmNode = parseXml(acsmXml.slice(0, acsmEnd));
assert(
  canonicalBytes(parseXml(serializeXml(acsmNode))).equals(canonicalBytes(acsmNode)),
  "🔴 serialise→reparse is hash-stable (the ACSM is re-emitted into the request)",
);
// 🔴 …and with a PREFIX map, which is how acsm.ts actually calls it. Without
// this the xmlns:prefix branch is untested — falsification caught exactly that
// gap: deleting the prefix declaration left the no-prefix assertion green.
const adeptPrefix = new Map([["http://ns.adobe.com/adept", "adept"]]);
assert(
  canonicalBytes(parseXml(serializeXml(acsmNode, adeptPrefix))).equals(canonicalBytes(acsmNode)),
  "🔴 …hash-stable through a prefixed serialisation too",
);
assert(
  serializeXml(acsmNode, adeptPrefix).includes('xmlns:adept="http://ns.adobe.com/adept"'),
  "…and that serialisation actually declares the prefix it uses",
);

// ── 5. Token detection ────────────────────────────────────────────────────
console.log("\ndetection");
assert(isFulfillmentToken(Buffer.from(acsmXml)), "a real-shaped .acsm is detected");
assert(
  isFulfillmentToken(
    Buffer.from(`<?xml version="1.0"?>\n<fulfillmentToken xmlns="http://ns.adobe.com/adept"/>`),
  ),
  "…with a declaration ahead of it too",
);
assert(!isFulfillmentToken(Buffer.from("PK\x03\x04 not xml")), "an epub is not a token");
assert(!isFulfillmentToken(Buffer.from("<html><body>no</body></html>")), "html is not a token");

console.log(failures === 0 ? "\nAll ACSM checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
