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

For the iOS PWA, `read.marvel.com` URLs are not enough — they get trapped
in the in-PWA SFSafariViewController and never trigger Marvel Unlimited's
universal link. To force app handoff we also store a per-issue `drn` and
`sourceId` and build a `marvel.smart.link` URL (see Step 5).

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

### Step 4 — Resolve DRNs and source IDs (digital book → smart.link)

To get the iOS PWA → Marvel Unlimited handoff working, every issue also
needs a Branch.io smart.link URL. The format is fixed:

```
https://marvel.smart.link/fiir7ec77?type=issue&drn={drn}&sourceId={sourceId}
```

`drn` is a Marvel-internal "Distributed Resource Name" (UUID-shaped); it
isn't on the issue's marvel.com page. We discovered the lookup endpoint by
reading the marvel.com bundle (`marvel-fitt-*.js`, search for `unison`):

```
GET https://bifrost.marvel.com/unison/legacy?digitalId={digital_book_id}
```

Returns JSON like:

```json
{ "data": { "dynamicQueryOrError": { "entity": { "contents": [{
  "content": {
    "id": "drn:src:marvel:unison::prod:6e60b594-…",
    "externalIds": [
      { "key": "MarvelDigitalComicID", "value": "51975" },
      { "key": "SourceId", "value": "72984" }
    ]
  }
}]}}}}
```

Pull `content.id` (the DRN, used verbatim) and the `SourceId` external id
(equal to `marvelIssueId` in our spot checks; safer to read from the
response than assume the equality). Bifrost is unauthenticated and
permissive — pace the requests anyway (~1/s) to be polite.

The scraper isn't checked in yet; when you write it, drop it next to
`fetch_applinks.py` and emit a `{ digital_book_id → { drn, sourceId } }`
JSON map.

### Step 5 — Generate `lib/comics-data.ts`

`scripts/generate-comics-data.mjs` (in this repo) zips `lookup.json`,
`applinks.json`, and the DRN map together and emits the static TS catalog
with `{ id, title, digitalBookId, marvelIssueId, drn, sourceId, slug }`
for each issue.

## Why three IDs per issue

| Field             | URL pattern                                     | Opens                              |
|-------------------|-------------------------------------------------|------------------------------------|
| `digitalBookId`   | `read.marvel.com/#/book/{id}`                   | The reader (web; universal link in Safari only — fails from PWA) |
| `marvelIssueId`   | `marvel.com/comics/issue/{id}/{slug}`           | The landing page (kept as fallback) |
| `slug`            | (joins the two)                                 | Used in landing-page URL only      |
| `drn` + `sourceId`| `marvel.smart.link/fiir7ec77?type=issue&drn={drn}&sourceId={sourceId}` | Marvel Unlimited app on iOS, even from inside the PWA |

The catalog stores all of them so we can change which URL the UI links to
without re-running the scrape. Currently the UI links to the smart.link
URL (PWA-friendly).

## Re-running the pipeline

If the reading order changes (e.g. a new storyline gets added):

```bash
# In ~/Code/hickman-xmen/, edit READING_ORDER in build.py, then:
python3 build.py            # regenerates lookup.json
python3 fetch_applinks.py   # fetches applink IDs for any new slugs
                            # (resumable; cached IDs are skipped)
python3 fetch_drns.py       # fetches DRN + sourceId via bifrost (Step 4)
                            # also resumable; one request per digital_book_id

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
- `bifrost.marvel.com` is Marvel.com's internal GraphQL-ish gateway. The
  `unison/legacy?digitalId=…` resource is what marvel.com itself calls when
  you tap the share button on an issue page. No auth required, but treat
  it as undocumented — the path/shape can change without notice.
- The smart.link template ID `fiir7ec77` is the "issue" default lifted
  straight from the marvel.com bundle's `renderShareButton`. Other content
  types use different templates (series=`jahtrdori`, character=`7p9nz1ef0`,
  reading-list=`3u1vpwc6p`, creator=`3c7b95oqa`, comic=`o5a7ja652`).
