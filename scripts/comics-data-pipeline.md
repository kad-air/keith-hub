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

The end-to-end pipeline lives in `~/Code/mu-reading-lists/`. Each
storyline gets its own subdir; the top-level scripts take a storyline
slug as an argument so the same code drives every list.

```
~/Code/mu-reading-lists/
  storylines.json                       (master index: slug, title, description)
  build.py                              (X-Men only — sitemap-driven)
  parse_markdown.py                     (any list with marvel.com URLs)
  fetch_applinks.py <slug>              (issue page → digital_book_id)
  fetch_drns.py <slug>                  (digital_book_id → drn + sourceId)
  hickman-x-men/
    lookup.json applinks.json drns.json
  hickman-secret-wars/
    source.md  lookup.json  applinks.json  drns.json
```

### Step 1 — Reading order

Two ways to source a reading order, depending on what you have:

**Hand-curated list (X-Men).** Edit the `READING_ORDER` Python list in
`build.py` and run it. It produces `<slug>/lookup.json` by looking up
each title in Marvel's comic sitemaps (Step 2). Currently used for
*Jonathan Hickman's X-Men* (House of X / Powers of X through X of
Swords), based on Comic Book Herald's order plus the X of Swords
crossover order from Wikipedia.

**Pre-built markdown checklist.** If you already have a markdown file
where each line is `- [ ] [Title](https://www.marvel.com/comics/issue/{id}/{slug})`,
drop it at `<slug>/source.md` and run `parse_markdown.py <slug>`. Skips
Step 2 entirely because the markdown already encodes the marvel.com page
ID and slug. Used for *Hickman Secret Wars* (sourced from
[emreparker/marvel-comics](https://github.com/emreparker/marvel-comics/blob/main/data/hickman_full.md)).

### Step 2 — Resolve issue page IDs (slug → marvel.com ID)

Only needed for `build.py`-driven storylines. `parse_markdown.py` skips
this entirely.

Marvel publishes its full comic catalog as XML sitemaps:
- https://www.marvel.com/sitemap-comics-0.xml
- https://www.marvel.com/sitemap-comics-1.xml

Combined, these contain ~56,000 URLs in the form
`https://www.marvel.com/comics/issue/{ID}/{slug}`. `build.py` downloads
both once, builds a `{slug → ID}` index (filtering out variant covers),
then for each reading-order entry generates candidate slugs and looks up
the issue ID.

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

### Step 5 — Generate `lib/comics-data.ts`

`scripts/generate-comics-data.mjs` (in this repo) reads
`storylines.json` and, for each entry, zips its `lookup.json`,
`applinks.json`, and `drns.json` together. Emits the static TS catalog
with `{ id, title, digitalBookId, marvelIssueId, drn, sourceId, slug }`
for each issue inside a `STORYLINES` array.

Storylines whose data is incomplete (missing applinks or drns rows) are
skipped with a warning so a partial regeneration during a long scrape
doesn't ship broken data.

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

```bash
cd ~/Code/mu-reading-lists

# (a) Hand-curated storyline: edit READING_ORDER in build.py, then:
python3 build.py                                # rewrites hickman-x-men/lookup.json

# (b) Markdown-checklist storyline: drop the file at
#     <slug>/source.md, add the storyline to storylines.json, then:
python3 parse_markdown.py <slug>                # writes <slug>/lookup.json

# Then for any storyline (including newly added ones):
python3 fetch_applinks.py <slug>                # ~5s/issue, resumable
python3 fetch_drns.py <slug>                    # ~1s/issue, resumable

# In this repo:
node scripts/generate-comics-data.mjs           # rewrites lib/comics-data.ts
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
