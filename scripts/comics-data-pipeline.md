# How `lib/comics-data.ts` is built

The comic catalog isn't fetched at runtime — it's a static TS file generated
from a sibling repo (`~/Code/hickman-xmen/`). This doc explains where the
data comes from and what each link in the catalog is.

## What we want

Each issue in the catalog needs a URL that opens the Marvel Unlimited reader
directly (not the marvel.com landing page). The format is:

```
https://read.marvel.com/#/book/{digital_book_id}
```

The challenge is that `digital_book_id` is internal to Marvel's CMS — it's
not exposed in the issue's URL slug, the reading-order guides that list
issues, or the official Marvel API (which is effectively dead).

## Pipeline

The end-to-end pipeline lives in `~/Code/hickman-xmen/`:

```
reading-order text  ─┐
                     │
sitemap-comics-*.xml ├──> build.py ──> lookup.json    (issue page IDs + slugs)
                     │
issue HTML pages ────┴──> fetch_applinks.py ──> applinks.json   (digital book IDs)
                                          │
                                          └──> generate-comics-data.mjs ──> comics-data.ts
```

### Step 1 — Reading order

A hand-curated ordered list of 150 issues, sourced from
[Comic Book Herald's Hickman X-Men reading order](https://www.comicbookherald.com/the-complete-marvel-reading-order-guide/jonathan-hickman-x-men-reading-order/),
expanded inline with the X of Swords crossover order from Wikipedia. Lives
as a Python list in `~/Code/hickman-xmen/build.py`.

### Step 2 — Resolve issue page IDs (slug → marvel.com ID)

Marvel publishes its full comic catalog as XML sitemaps:
- https://www.marvel.com/sitemap-comics-0.xml
- https://www.marvel.com/sitemap-comics-1.xml

Combined, these contain ~56,000 URLs in the form:

```
https://www.marvel.com/comics/issue/{ID}/{slug}
```

`build.py` downloads both sitemaps once, builds a `{slug → ID}` index
(filtering out variant covers), then for each reading-order entry it
generates candidate slugs and looks up the issue ID. Output: `lookup.json`.

This gives URLs like
`https://www.marvel.com/comics/issue/76795/x-force_2019_7` — but those open
the marvel.com landing page, not the reader. Step 3 fixes that.

### Step 3 — Resolve digital book IDs (issue page → reader URL)

The digital book ID isn't in the sitemap. It only appears embedded in the
HTML of each issue's landing page, in two forms:

```
https://applink.marvel.com/issue/{digital_book_id}
https://read.marvel.com/#/book/{digital_book_id}
```

`fetch_applinks.py` fetches each issue page (throttled — Marvel.com
aggressively rate-limits scrapers, so requests are paced 4–7s apart with a
resumable JSON cache). It extracts the first `applink.marvel.com` ID; if
absent, it falls back to the first `read.marvel.com/#/book/{id}` ID.
Output: `applinks.json`, a `{slug → digital_book_id}` map.

### Step 4 — Generate `lib/comics-data.ts`

`scripts/generate-comics-data.mjs` (in this repo) zips `lookup.json` and
`applinks.json` together and emits the static TS catalog with
`{ id, title, digitalBookId, marvelIssueId, slug }` for each issue.

## Why three IDs per issue

| Field             | URL pattern                                     | Opens                              |
|-------------------|-------------------------------------------------|------------------------------------|
| `digitalBookId`   | `read.marvel.com/#/book/{id}`                   | The reader (web or app universal link) |
| `marvelIssueId`   | `marvel.com/comics/issue/{id}/{slug}`           | The landing page (kept as fallback) |
| `slug`            | (joins the two)                                 | Used in landing-page URL only      |

The catalog stores all three so we can change which URL the UI links to
without re-running the scrape.

## Re-running the pipeline

If the reading order changes (e.g. a new storyline gets added):

```bash
# In ~/Code/hickman-xmen/, edit READING_ORDER in build.py, then:
python3 build.py            # regenerates lookup.json
python3 fetch_applinks.py   # fetches applink IDs for any new slugs
                            # (resumable; cached IDs are skipped)

# Then in this repo:
node scripts/generate-comics-data.mjs   # rewrites lib/comics-data.ts
```

## Notes

- `applink.marvel.com` has no DNS — it's a pure iOS/Android universal-link
  prefix the apps intercept. It will not open as a web URL.
- `read.marvel.com/#/book/{id}` is a real web URL (the Marvel Unlimited
  reader) and is also a universal link target on iOS/Android.
- Marvel.com's developer API exists but is effectively unmaintained — the
  sitemap + page scrape is more reliable.
