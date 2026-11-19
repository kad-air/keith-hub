# How the Comics reading orders are built

The Comics section (`/comics`) is a static catalog of reading orders. Each
issue links into the Marvel Comics app (the WEBTOON-built app that replaced
Marvel Unlimited; Marvel Unlimited closed on December 28, 2026). Nothing is
fetched from Marvel at runtime.

```
comics/storylines.json        display order: ["hickman-x-men", …]
comics/<slug>.json            one storyline: title, description, source, issues
comics/series-aliases.json    fan-list series names the app spells differently
        │
        │  node scripts/generate-comics-data.mjs
        ▼
lib/comics-data.ts            generated, committed; what the pages import
```

`comics/<slug>.json` is the source of truth. Each issue carries its
`appIssueId`, the issue's id in the Marvel Comics app
(`www.marvelcomicsapp.com/issues/<appIssueId>`). The hub keys read marks on
`mca-<appIssueId>`.

## Adding a reading order

Reading orders come from fan lists, or from a list you write yourself. Marvel's
own reading guides are read in the app; the hub doesn't copy them.

**From the fan library.** [DieselTech/CBL-ReadingLists](https://github.com/DieselTech/CBL-ReadingLists)
collects about 1,150 Marvel reading orders (from Comic Book Reading Orders,
the Complete Marvel Reading Order, League of Comic Geeks, Marvel Guides and
others) as `.cbl` files. Each entry gives the series, its start year and the
issue number. On the Mac Mini, from this repo:

```bash
node scripts/comics-import.mjs --slug hickman-fantastic-four \
  --title "Hickman's Fantastic Four" \
  --description "The 2009–2012 run, in order." \
  --cbl "Marvel/Creator Runs/[Marvel] [2009-2012] Fantastic Four by Jonathan Hickman.cbl"
```

`--cbl` takes a path inside that library (as above), a URL to any `.cbl` file
(a `github.com/…/blob/…` link works), or a local file.

**From your own list.** One issue per line, `Series (Year) #N`; blank lines and
lines starting with `#` or `//` are ignored, and checklist markers are fine:

```
- [ ] Hawkeye (2012) #1
- [ ] Hawkeye (2012) #2
- [ ] Hawkeye Annual (2013) #1
```

```bash
node scripts/comics-import.mjs --slug my-list --title "My list" --titles my-list.txt
```

The year is the series' start year (how the app tells "Hawkeye (2012)" from
"Hawkeye (1983)"). It's optional, but leave it in.

**What the importer does.** It opens `www.marvelcomicsapp.com` in headless
Chrome, finds each issue, writes `comics/<slug>.json`, adds the slug to
`comics/storylines.json`, and regenerates `lib/comics-data.ts`. It paces itself at
about one request a second, which comes to roughly a second an issue: a
588-issue Hickman list took 12 minutes. Then commit
`comics/` and `lib/comics-data.ts` and open a PR.

It has to run on the Mac Mini (or anywhere with Google Chrome; set
`CHROME_PATH` for another browser). The app's API refuses plain HTTP clients:
it wants the site's `D-Comics-*` headers and an anonymous device-id cookie
that the site's own JS sets on page load, so the importer calls it from inside
a real page with `fetch()`. No sign-in is involved.

## How an issue is matched

`scripts/lib/comics-match.mjs`, in order:

1. **Issue search** on the full title, `"Hawkeye (2012) #5"`. Accepted only if a
   result has exactly that series name, start year and number.
2. **Series route.** Search series by name, keep every series with that exact
   name and start year (±1 if none is exact), and look for the number in each
   one's issue list. Every candidate series is checked because the app splits
   some series (Secret Wars Journal (2015) #4 sits alone in its own series).
   The app's search misses some exact names, so when nothing turns up it
   searches again with the part after the last colon ("The Hunt" for
   Infinity: The Hunt) or before the first comma ("Hank Johnson" for Hank
   Johnson, Agent of Hydra), still requiring the full name to match.
3. **Several matches** (a reprint or facsimile series that reuses the
   original's title, e.g. X-Men (1963) #1 also exists as 2019 and 2023
   printings): the issue published nearest the list's cover year wins, if it's
   clearly nearest. A hand-written list has no cover year, so there the
   earliest printing wins when every other match is five or more years later.
   Anything closer is left for you (Weirdworld (2015) and Silk (2015) are each
   two app series that both started in 2015).
4. **No exact match**: the issue is kept with `"appIssueId": null` and a
   `"review"` block giving the reason and the closest candidates. Nothing is
   guessed.

Names compare on letters and digits only (the app title-cases everything:
"Ff", "S.h.i.e.l.d.", "Secret Wars Ii"); numbers compare as strings, so point
issues like `#34.1` work.

**Renamed series.** The app spells some series differently from the fan lists:
Uncanny X-Men (1963) is "X-Men", Ultimate Comics Thor (2010) is "Ultimate
Thor", Marvel Super Heroes Secret Wars (1984) is "Secret Wars".
`comics/series-aliases.json` maps these; key them with the year, because names
get reused (the app's "X-Men (2013)" is a different book from Uncanny X-Men
(2013)). Give the value a year when the app files the series under another
start year: S.H.I.E.L.D. by Hickman & Weaver (2018) is the app's
"S.H.I.E.L.D. (2011)".

**Known gaps in the app's catalog.** X-Men (1963) #67–93 (the 1970–75
all-reprint issues) aren't in the app.

## Fixing the misses

A storyline with any unmatched issue is left off the hub (the generator says
which) until each one is fixed in `comics/<slug>.json`:

- set its `"appIssueId"` (one of the `review.candidates`, or an id you found in
  the app: it's the number in `www.marvelcomicsapp.com/issues/<id>`), or
- set `"skip": true` to drop it from the list (e.g. an issue the app doesn't
  have).

Then `node scripts/generate-comics-data.mjs`. Re-running the importer on the
same slug keeps every id already set, so fixes stick; run it with just
`--slug <slug>` to re-try only the misses (after adding an alias, say).

## Links

`www.marvelcomicsapp.com/issues/<id>` isn't a universal link on iOS (the site's
apple-app-site-association has no `applinks`), so from the PWA it would open a
web page. `components/ComicsClient.tsx` links the same AppsFlyer OneLink the
site's own "open in app" button builds, on `goto.marvelcomicsapp.com/w9za`, with
`af_dp=marvelcomicsapp://issueHome?issueId=<id>`.
(`marvelcomicsapp://viewer?issueId=<id>` would open the reader directly.)

## Read marks from before the switch

Before November 2026 the catalog was built from Marvel Unlimited data and read
marks were keyed on Marvel Unlimited's digital book ids. `lib/comics-rekey.ts`
moves any such mark to its `mca-` key the first time the Comics section reads
the database after a start, using the frozen map in `lib/comics-legacy-ids.ts`
(392 issues: the Hickman X-Men, Hickman Secret Wars and Fraction Hawkeye lists).
It does nothing once those ids are gone. The old pipeline (marvel.com sitemaps,
issue-page scrapes, `bifrost.marvel.com`, Branch smart.links, and the app's
`/api/v1/mu/issues/<marvelIssueId>` migration lookup) is retired.

## Tests

`npm run check:comics` (in prebuild) checks the catalog against `comics/`, the
generator's guards, the read-mark move, and the matcher against recorded app
answers in `scripts/comics-fixture/` (`cases.json`, and `api.json` recorded with
`COMICS_RECORD=scripts/comics-fixture/api.json` on an importer run over
`cases.titles.txt`).
