#!/usr/bin/env python3
"""
Offline reference x-pointers for books-fixture/fixture.epub.

    python3 scripts/gen_book_xpointer_reference.py

Prints a JSON fragment to paste into books-fixture/expected.json under
"xpointer". Run it again only when the fixture epub itself is rebuilt.

WHY THIS EXISTS. lib/books/xpointer.ts SYNTHESIZES kosync progress pointers —
the one deliberate exception to the "progress is opaque" rule — and a wrong
pointer doesn't error anywhere: the device just opens the wrong page, silently.
The dialect was established empirically before this shipped: regenerating the
three paragraph-level pointers real devices had synced to production
(/body/DocFragment[6]/body/p[21], /body/DocFragment[11]/body/section[1]/p[105],
/body/DocFragment[17]/body/p[1]) from their epubs' bytes reproduced the
device's own strings exactly, using THE ALGORITHM BELOW (html.parser walk,
1-based same-tag sibling indexing, DocFragment 1-based over the full spine).
Those epubs can't be committed, so this script freezes the validated algorithm
against the fixture instead: an independent implementation (Python html.parser
vs the TS tag tokenizer, different language, no shared code) whose output the
TS side must reproduce byte-for-byte. See scripts/check-books-xpointer.ts.

Sampled paragraphs, not all 900: enough to pin the dialect (first, last, and
every 37th — a stride coprime with round numbers so structural periodicity in
a generated fixture can't hide a systematic disagreement).
"""

import json
import os
import posixpath
import re
import sys
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(ROOT, "books-fixture", "fixture.epub")

VOID = {"br", "img", "hr", "meta", "link", "input", "area", "base", "col",
        "embed", "source", "track", "wbr", "param"}
STRIDE = 37


class PathBuilder(HTMLParser):
    """CRengine-style path for every <p>: from <body> down, each element step
    indexed 1-based among same-TAG siblings. The exact walk validated against
    real CrossPoint pointers (see module docstring)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []          # [(segment, {child_tag: count})]
        self.in_body = False
        self.paras = []          # (path, text)
        self._open = None        # (path, [text parts], depth)

    def handle_starttag(self, tag, attrs):
        if tag == "body":
            self.in_body = True
            self.stack = [("body", {})]
            return
        if not self.in_body or tag in VOID:
            return
        counts = self.stack[-1][1]
        counts[tag] = counts.get(tag, 0) + 1
        self.stack.append((f"{tag}[{counts[tag]}]", {}))
        if tag == "p" and self._open is None:
            path = "/".join(seg for seg, _ in self.stack)
            self._open = (path, [], len(self.stack))

    def handle_endtag(self, tag):
        if tag == "body":
            self.in_body = False
            return
        if not self.in_body or tag in VOID:
            return
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i][0].startswith(f"{tag}["):
                del self.stack[i:]
                break
        if self._open and len(self.stack) < self._open[2]:
            path, parts, _ = self._open
            text = re.sub(r"\s+", " ", " ".join(parts)).strip()
            self.paras.append((path, text))
            self._open = None

    def handle_data(self, data):
        if self._open is not None:
            self._open[1].append(data)


def full_spine(zf):
    c = ElementTree.fromstring(zf.read("META-INF/container.xml").decode("utf-8"))
    opf_path = c.find(".//{*}rootfile").get("full-path")
    opf_dir = posixpath.dirname(opf_path)
    opf = ElementTree.fromstring(zf.read(opf_path).decode("utf-8"))
    man = {i.get("id"): i.get("href") for i in opf.findall(".//{*}manifest/{*}item")}
    out = []
    for ir in opf.findall(".//{*}spine/{*}itemref"):
        href = man.get(ir.get("idref"))
        if href:
            out.append(posixpath.normpath(posixpath.join(opf_dir, href.split("#")[0])))
    return out


def main():
    if not os.path.exists(FIXTURE):
        sys.exit(f"fixture not found: {FIXTURE}")
    samples = []
    with zipfile.ZipFile(FIXTURE) as zf:
        names = set(zf.namelist())
        spine = full_spine(zf)
        for d, doc in enumerate(spine):
            if doc not in names:
                continue
            pb = PathBuilder()
            pb.feed(zf.read(doc).decode("utf-8", errors="replace"))
            n = len(pb.paras)
            picks = sorted({0, n - 1, *range(0, n, STRIDE)}) if n else []
            for k in picks:
                path, text = pb.paras[k]
                samples.append({
                    "pointer": f"/body/DocFragment[{d + 1}]/{path}",
                    "paragraph_ordinal": k,
                    "doc_index": d + 1,
                    "first_words": " ".join(text.split()[:8]),
                })
    print(json.dumps({
        "xpointer": {
            "comment": (
                "CRengine-dialect x-pointers for a sample of fixture.epub's "
                "paragraphs, computed OFFLINE by "
                "scripts/gen_book_xpointer_reference.py — an independent "
                "Python implementation of lib/books/xpointer.ts's path walk, "
                "itself validated byte-exact against three real CrossPoint "
                "pointers from production. check:books-xpointer asserts the "
                "TS walk reproduces every pointer here exactly. Regenerate "
                "only by rebuilding the fixture and re-running that script; "
                "never by copying the TS output back in."
            ),
            "stride": STRIDE,
            "paragraph_count": len(samples),
            "samples": samples,
        }
    }, indent=2))


if __name__ == "__main__":
    main()
