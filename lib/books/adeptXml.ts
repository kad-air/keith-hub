// A minimal namespace-aware XML parser, and Adobe's ADEPT canonical hash.
//
// 🔴 Why a parser at all, when the rest of lib/books/ reads XML with regexes:
// the ADEPT signature is computed over a CANONICAL SERIALISATION of the request
// tree — element namespaces and local names, attributes sorted, text nodes
// length-prefixed, children recursed, each preceded by a type tag. That needs
// real structure, not pattern matching, and it has to be byte-exact or Adobe
// rejects the request. The ACSM we embed is arbitrary XML from the retailer, so
// it must be parsed rather than assumed.
//
// Ported from Leseratte10's acsm-calibre-plugin (`libadobe.hash_node_ctx`),
// itself a port of Adobe's own implementation. Cross-checked byte-for-byte
// against that Python on 7 cases including a REAL Google Play fulfil request —
// see scripts/check-books-acsm.ts.

export type XmlNode = {
  /** Namespace URI, or "" when the element is not in a namespace. */
  ns: string;
  /** Local name, prefix stripped. */
  name: string;
  /** Attributes as {ns, name, value}. xmlns declarations are NOT included. */
  attrs: Array<{ ns: string; name: string; value: string }>;
  /** Concatenated direct text content (lxml's `.text` equivalent: leading text only). */
  text: string;
  children: XmlNode[];
};

const XML_NS = "http://www.w3.org/XML/1998/namespace";

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

type RawAttr = { rawName: string; value: string };

function parseAttrs(src: string): RawAttr[] {
  const out: RawAttr[] = [];
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ rawName: m[1], value: decodeEntities(m[3] ?? m[4] ?? "") });
  }
  return out;
}

/**
 * Parse an XML document into a namespace-resolved tree.
 * Deliberately small: elements, attributes, text, CDATA, comments, PIs and the
 * declaration. No DTDs, no entity definitions — ADEPT documents have none, and
 * refusing to invent support for them keeps the signature surface small.
 */
export function parseXml(xml: string): XmlNode {
  let i = 0;
  const stack: Array<{ node: XmlNode; nsMap: Map<string, string> }> = [];
  let root: XmlNode | null = null;

  const resolve = (raw: string, nsMap: Map<string, string>, isAttr: boolean) => {
    const idx = raw.indexOf(":");
    if (idx === -1) {
      // Unprefixed attributes are in NO namespace; unprefixed elements take the
      // default xmlns. This asymmetry is XML-spec behaviour and matters here —
      // getting it wrong changes what gets hashed.
      return { ns: isAttr ? "" : (nsMap.get("") ?? ""), name: raw };
    }
    const prefix = raw.slice(0, idx);
    const local = raw.slice(idx + 1);
    if (prefix === "xml") return { ns: XML_NS, name: local };
    return { ns: nsMap.get(prefix) ?? "", name: local };
  };

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;

    // Text preceding this tag belongs to the element currently open.
    if (lt > i && stack.length > 0) {
      const raw = xml.slice(i, lt);
      const top = stack[stack.length - 1].node;
      // Only the FIRST text run is lxml's `.text`, which is what the reference
      // implementation hashes; later runs are `.tail` of children and are not
      // hashed. Mirroring that exactly.
      if (top.children.length === 0) top.text += decodeEntities(raw);
    }

    if (xml.startsWith("<!--", lt)) {
      i = xml.indexOf("-->", lt) + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      const raw = xml.slice(lt + 9, end);
      if (stack.length > 0) {
        const top = stack[stack.length - 1].node;
        if (top.children.length === 0) top.text += raw;
      }
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      i = xml.indexOf("?>", lt) + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      i = xml.indexOf(">", lt) + 1;
      continue;
    }

    const gt = xml.indexOf(">", lt);
    if (gt === -1) break;
    let inner = xml.slice(lt + 1, gt);

    if (inner.startsWith("/")) {
      stack.pop();
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);

    const sp = inner.search(/\s/);
    const rawName = sp === -1 ? inner : inner.slice(0, sp);
    const rawAttrs = sp === -1 ? [] : parseAttrs(inner.slice(sp));

    // Namespace scope: inherit, then apply this element's xmlns declarations.
    const parentMap = stack.length > 0 ? stack[stack.length - 1].nsMap : new Map<string, string>();
    const nsMap = new Map(parentMap);
    for (const a of rawAttrs) {
      if (a.rawName === "xmlns") nsMap.set("", a.value);
      else if (a.rawName.startsWith("xmlns:")) nsMap.set(a.rawName.slice(6), a.value);
    }

    const resolved = resolve(rawName, nsMap, false);
    const node: XmlNode = {
      ns: resolved.ns,
      name: resolved.name,
      attrs: rawAttrs
        .filter((a) => a.rawName !== "xmlns" && !a.rawName.startsWith("xmlns:"))
        .map((a) => {
          const r = resolve(a.rawName, nsMap, true);
          return { ns: r.ns, name: r.name, value: a.value };
        }),
      text: "",
      children: [],
    };

    if (stack.length === 0) root = node;
    else stack[stack.length - 1].node.children.push(node);

    if (!selfClosing) stack.push({ node, nsMap });
    i = gt + 1;
  }

  if (!root) throw new Error("adept xml: no root element");
  return root;
}

/**
 * Serialise a node back to XML (used to embed the ACSM into a fulfil request).
 *
 * 🔴 Namespace declarations are EMITTED, not assumed. An earlier version relied
 * on the surrounding request root having already declared the adept prefix; the
 * output then looked fine in place but lost every namespace when reparsed on
 * its own — a silent corruption for any caller that isn't embedding it. Note
 * this cannot change a signature: the canonical hash sees resolved namespace
 * URIs and local names, never prefixes or where they were declared.
 */
export function serializeXml(node: XmlNode, nsPrefix?: Map<string, string>): string {
  const prefixes = nsPrefix ?? new Map<string, string>();
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

  const walk = (n: XmlNode, inheritedDefault: string, declared: Set<string>): string => {
    const prefix = prefixes.get(n.ns);
    const tag = prefix ? `${prefix}:${n.name}` : n.name;

    let decls = "";
    let nextDefault = inheritedDefault;
    const nextDeclared = declared;
    if (prefix) {
      if (!declared.has(n.ns)) {
        decls += ` xmlns:${prefix}="${escAttr(n.ns)}"`;
        nextDeclared.add(n.ns);
      }
    } else if (n.ns !== inheritedDefault) {
      // Unprefixed element in a namespace: it becomes the default here.
      decls += ` xmlns="${escAttr(n.ns)}"`;
      nextDefault = n.ns;
    }

    const attrs = n.attrs
      .map((a) => {
        const ap = a.ns ? prefixes.get(a.ns) : undefined;
        return ` ${ap ? `${ap}:${a.name}` : a.name}="${escAttr(a.value)}"`;
      })
      .join("");

    const inner =
      esc(n.text) + n.children.map((c) => walk(c, nextDefault, nextDeclared)).join("");
    return inner.length > 0
      ? `<${tag}${decls}${attrs}>${inner}</${tag}>`
      : `<${tag}${decls}${attrs}/>`;
  };

  return walk(node, "", new Set<string>());
}

// ── Adobe's canonicalisation ──────────────────────────────────────────────
// Each piece is preceded by a one-byte type tag; every string is written as a
// two-byte big-endian length followed by its UTF-8 bytes.
const ASN_NS_TAG = 1; // BEGIN_ELEMENT
const ASN_CHILD = 2; // END_ATTRIBUTES
const ASN_END_TAG = 3; // END_ELEMENT
const ASN_TEXT = 4; // TEXT_NODE
const ASN_ATTRIBUTE = 5; // ATTRIBUTE

const ADEPT_NS = "http://ns.adobe.com/adept";

function appendString(out: number[], s: string): void {
  const bytes = Buffer.from(s, "utf8");
  // 🔴 The length prefix is (len/256, len & 0xFF) — the reference computes the
  // high byte by integer division, so a string of 65536+ bytes would overflow
  // the byte. Text nodes are chunked at 0x7fff below, exactly as Adobe does,
  // so this can't be reached with a legal document.
  out.push(Math.floor(bytes.length / 256), bytes.length & 0xff);
  for (const b of bytes) out.push(b);
}

function hashNodeInto(node: XmlNode, out: number[]): void {
  // 🔴 adept:hmac and adept:signature are excluded from the hash — they are
  // what the hash produces, so including them would be circular.
  if ((node.name === "hmac" || node.name === "signature") && node.ns === ADEPT_NS) return;

  out.push(ASN_NS_TAG);
  appendString(out, node.ns);
  appendString(out, node.name);

  // Attributes sorted. The reference sorts lxml's "{ns}name" strings; we
  // reproduce that key exactly rather than sorting on local name alone.
  const sorted = [...node.attrs].sort((a, b) => {
    const ka = a.ns ? `{${a.ns}}${a.name}` : a.name;
    const kb = b.ns ? `{${b.ns}}${b.name}` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const attr of sorted) {
    out.push(ASN_ATTRIBUTE);
    appendString(out, attr.ns);
    appendString(out, attr.name);
    appendString(out, attr.value);
  }

  out.push(ASN_CHILD);

  // Text is trimmed, then hashed in ≤0x7fff-byte chunks.
  const text = node.text.trim();
  if (text.length > 0) {
    let done = 0;
    while (done < text.length) {
      const take = Math.min(text.length - done, 0x7fff);
      out.push(ASN_TEXT);
      appendString(out, text.slice(done, done + take));
      done += take;
    }
  }

  for (const child of node.children) hashNodeInto(child, out);

  out.push(ASN_END_TAG);
}

/** The bytes Adobe hashes for a node — exposed so the gate can diff them. */
export function canonicalBytes(node: XmlNode): Buffer {
  const out: number[] = [];
  hashNodeInto(node, out);
  return Buffer.from(out);
}
