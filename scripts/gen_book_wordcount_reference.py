#!/usr/bin/env python3
"""
Offline reference word count for books-fixture/fixture.epub.

    python3 scripts/gen_book_wordcount_reference.py

Prints a JSON fragment to paste into books-fixture/expected.json under
"text". Run it again only when the fixture epub itself is rebuilt.

WHY THIS EXISTS. lib/books/epubText.ts turns an epub into a word count, and
that count is the denominator behind every page number the stats page prints
("312 pages to go", "you read 40 pages today"). A silently wrong denominator
produces confident, plausible, wrong numbers forever — the reader has no way
to tell 312 from 480.

So the count gets a second source, deliberately unlike the first:

  - a real HTML parser (html.parser) instead of the TS regex stripper
  - a real XML parser (ElementTree) for the OPF spine instead of regexes
  - a different language, written from the epub spec rather than from the
    TS code

Agreement between two implementations that share no code is evidence. The
check asserts a tight relative tolerance rather than exact equality, because
the two disagree by construction on the last fraction of a percent (entity
expansion, whitespace inside inline tags). Every failure mode that actually
matters — counting CSS or script blocks, missing spine documents, counting
markup as prose, walking the zip instead of the reading order — moves the
number by whole percent or more. See scripts/check-books-stats.ts.
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

SKIP_TAGS = {"script", "style", "head"}


class ProseExtractor(HTMLParser):
    """Collects text, skipping non-prose elements, inserting a space per tag
    boundary so <p>one</p><p>two</p> is two words rather than one."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip_depth += 1
        self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self.skip_depth > 0:
            self.skip_depth -= 1
        self.parts.append(" ")

    def handle_data(self, data):
        if self.skip_depth == 0:
            self.parts.append(data)

    def text(self):
        return "".join(self.parts)


def spine_documents(zf):
    """The OPF spine's XHTML hrefs, in reading order, resolved against the
    OPF's directory — parsed with ElementTree, not regexes."""
    container = zf.read("META-INF/container.xml").decode("utf-8")
    root = ElementTree.fromstring(container)
    rootfile = root.find(".//{*}rootfile")
    opf_path = rootfile.get("full-path")
    opf_dir = posixpath.dirname(opf_path)

    opf = ElementTree.fromstring(zf.read(opf_path).decode("utf-8"))
    manifest = {}
    for item in opf.findall(".//{*}manifest/{*}item"):
        media = item.get("media-type") or ""
        href = item.get("href") or ""
        if "html" not in media and not re.search(r"\.(x?html|htm)$", href, re.I):
            continue
        manifest[item.get("id")] = href

    docs = []
    for itemref in opf.findall(".//{*}spine/{*}itemref"):
        href = manifest.get(itemref.get("idref"))
        if not href:
            continue
        href = href.split("#")[0]
        docs.append(posixpath.normpath(posixpath.join(opf_dir, href)))
    return docs


def count_words(path):
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        total = 0
        docs = spine_documents(zf)
        for doc in docs:
            if doc not in names:
                continue
            parser = ProseExtractor()
            parser.feed(zf.read(doc).decode("utf-8", errors="replace"))
            total += len(parser.text().split())
        return total, len(docs)


if __name__ == "__main__":
    if not os.path.exists(FIXTURE):
        sys.exit(f"fixture not found: {FIXTURE}")
    words, docs = count_words(FIXTURE)
    print(
        json.dumps(
            {
                "text": {
                    "comment": (
                        "Word count for fixture.epub computed OFFLINE by "
                        "scripts/gen_book_wordcount_reference.py — an independent "
                        "implementation (html.parser + ElementTree, Python) of what "
                        "lib/books/epubText.ts does with regexes. The stats page's "
                        "page numbers are all derived from this denominator. "
                        "Regenerate only by rebuilding the fixture and re-running "
                        "that script; never by copying the TS output back in."
                    ),
                    "words": words,
                    "spine_documents": docs,
                }
            },
            indent=2,
        )
    )
