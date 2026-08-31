#!/usr/bin/env python3
"""Regenerate books-fixture/discworld-opf.json.

The Discworld map matches library rows to poster nodes. To assert that match
against something this codebase did not itself produce, the fixture holds the
metadata carried INSIDE the reader's own epub files — read here with Python's
zipfile + ElementTree, entirely independently of lib/books/epubMeta.ts (which
reads the OPF with regexes).

Run it on the Mac Mini, where the master library lives:

    python3 scripts/gen_discworld_opf_reference.py

🔴 Never regenerate this by copying TypeScript output back in. The value of
the fixture is that a second implementation read the same bytes.
"""

import glob
import json
import os
import re
import xml.etree.ElementTree as ET
import zipfile

LIBRARY = "/Volumes/HDD/Books/Terry Pratchett"
OUT = os.path.join(os.path.dirname(__file__), "..", "books-fixture", "discworld-opf.json")
DC = {"dc": "http://purl.org/dc/elements/1.1/"}


def read_opf(path):
    with zipfile.ZipFile(path) as z:
        container = z.read("META-INF/container.xml").decode("utf-8", "replace")
        opf_path = re.search(r'full-path="([^"]+)"', container).group(1)
        root = ET.fromstring(z.read(opf_path))

    title = root.find(".//dc:title", DC)
    creator = root.find(".//dc:creator", DC)
    series = series_index = None
    for meta in root.iter():
        if meta.tag.endswith("}meta") or meta.tag == "meta":
            if meta.get("name") == "calibre:series":
                series = meta.get("content")
            if meta.get("name") == "calibre:series_index":
                series_index = meta.get("content")

    return {
        "sourceFile": os.path.basename(path),
        "opfTitle": title.text if title is not None else None,
        "opfCreator": creator.text if creator is not None else None,
        "opfSeries": series,
        "opfSeriesIndex": float(series_index) if series_index else None,
    }


def main():
    paths = sorted(glob.glob(os.path.join(LIBRARY, "**", "*.epub"), recursive=True))
    if not paths:
        raise SystemExit(f"no epubs under {LIBRARY} — is the volume mounted?")

    doc = {
        "_provenance": (
            "Metadata read straight out of the reader's OWN epub files on "
            f"{LIBRARY}, by scripts/gen_discworld_opf_reference.py (Python zipfile + "
            "ElementTree). It is the PUBLISHER'S metadata, not a row this codebase "
            "wrote — which is the whole point: check:books:discworld asserts the "
            "matcher resolves what the files themselves say."
        ),
        "_note": (
            "Men at Arms is the case that justifies the design. Its dc:title is "
            "'Pratchett, Terry - Discworld 15 - Men at Arms' — a title match alone "
            "would miss it, and only calibre:series_index carries it to the right "
            "node. Any future rewrite that demotes series_index below the title has "
            "to break this."
        ),
        "books": [read_opf(p) for p in paths],
    }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {len(doc['books'])} book(s) to {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
