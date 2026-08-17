# Books — implementation plan

> A personal EPUB library as a section of The Feed: an OPDS 1.2 catalog, a KOReader
> progress-sync server, and upload/manage. On Railway, like the rest of the hub.

**Status:** ✅ COMPLETE 2026-08-16 — built, deployed, device-proven, and Stump torn out, all in
one session. The evidence chain, in order:
- `partialMd5` verified **13/13 against Stump's stored Rust-computed hashes** before anything was
  built on it; all three gates (`check:books:bytes` / `:opds` / `:kosync`) falsification-tested.
- Production: 13 books pushed; `check-books-live.mjs` verified **all 13 downloads through the
  deployed /opds path sha256-identical** to the HDD sources; the 3 Stump positions migrated and
  resolving by content hash.
- **§1's gate zero + the device test both passed on the real X3**: it browsed the hub catalog over
  TLS to Railway (settling the relitigated LAN-only question for good), downloaded The Running
  Man, and pushed progress — landing at the hub as
  `/body/DocFragment[4]/body/p[3]/text()[1].373` under document hash `4bf66593…`, which equals our
  ingest-computed `partial_md5` exactly. That equality closes the whole byte-identity loop:
  HDD → upload → Railway volume → OPDS download → device hash.
- §11 teardown done: LaunchAgent removed, cloudflared `books.` ingress removed (mcp/plex intact),
  `~/Stump` + `~/.stump` deleted. Keepers (final stump.db backup, `organize-books.py`, the
  upstream issue draft + repro, the old deployment plan) archived in `~/Stump-retired/`.
  `/Volumes/HDD/Books` remains the master copy.
- **Readest verified working** on the phone against the hub (OPDS + kosync) — both readers live.
- Remaining loose ends, neither blocking: the `books.keiths-home-server.us` CNAME still exists in
  Cloudflare DNS (routes to the tunnel's catch-all 404; deleting it needs the dashboard, as
  cloudflared can't remove routes), and the X3 still lists the dead "Stump" OPDS entry alongside
  the live one — delete it from the device UI at leisure rather than poking a 56KB-heap device.
- **Post-ship addition, then reverted deliberately:** an MCP/admin-API path for agent-driven
  metadata cleanup (`/api/books-admin` + Mac Mini MCP tools) was built and then stood down the same
  session — the `/books` detail page already exposes every editable field, so it solved a problem
  that didn't exist, and it made the Mini a dependency for a workflow that never touches it. See
  commit `78ad7c9` if it's ever revisited; the better version would be hosted on Railway beside the
  data, and the blocker there is re-implementing MCP transport + OAuth (274 lines of it already
  solved on the Mini) rather than anything about books. What survives is
  `npm run check:books:metadata`, trimmed to the assertion that guards the UI's own edit button.

---

## 0. The decision

Build OPDS 1.2 + kosync into keith-hub, on Railway. **EPUB only. Files on the Railway volume.**

### 🔴 The relitigated decision: the X3 does NOT need to stay on LAN HTTP

`MAC-MINI-DEPLOYMENT-PLAN.md` lists "X3 stays on LAN HTTP" under *"decisions already made (don't
relitigate)"*, on the grounds of mbedTLS heap pressure on an ESP32-C3. **That was re-examined
2026-08-16 against the firmware source and reversed.** The evidence:

| Claim | Evidence |
|---|---|
| The X3 runs **wolfSSL, not mbedTLS** | `-DFREEINK_NET_WOLFSSL=1` in `[base].build_flags`, inherited by `[env:gh_release]` (`FREEINK_DEVICE_X3=1`). Verified **at the `v1.5.0` tag** — the firmware actually on the device — not just master. Dep: `wolfssl/Arduino-wolfSSL @ 5.7.2`, `-DWOLFSSL_TLS13`. |
| Remote HTTPS is the *intended* model | `src/network/HttpDownloader.cpp`: *"the model is **public servers over verified https** and local servers over plain http."* |
| wolfSSL exists **because** mbedTLS was the problem | same file: *"it speaks TLS 1.3 and reads large bodies from servers where the esp_http_client/mbedTLS path fails to connect or stalls mid-stream."* |
| Remote HTTPS sync is the shipped default | CrossPoint's default `koServerUrl` is `https://sync.crosspointreader.com`. |

The original decision was risk-aversion against a stack the device no longer uses. Dropping it
also *gains* something real: the X3 currently syncs **only at home**. Over HTTPS it syncs anywhere
it has wifi.

🔴 **This is a paper argument until the device proves it.** See §1 — the TLS test is the first
gate and it runs before any code is written.

### What this buys, and what it costs

Serving from Railway means **no Mac Mini in the read path at all** — the property Hoops
deliberately designed for. It also deletes a LaunchAgent, a cloudflared ingress, a 42 MB binary,
and a second auth model.

**Why EPUB only.** Panels can't read text EPUB (it reads CBR/CBZ/CB7/PDF and *comic* EPUB), so
"support Panels" means "serve 50–200 MB comics," which is the only requirement that would push
storage off the Railway volume. The actual library is **13 EPUBs, 20 MB**. Storage was never the
interesting question. Comics are §12.

---

## 1. 🔴 Gate zero: prove the X3 does remote HTTPS

**Before writing anything.** `hub.keithadair.com` presents Let's Encrypt `YE2` → ISRG `Root YE`
→ `ISRG Root X2` → **`ISRG Root X1`**, over **TLS 1.3** (verified 2026-08-16). X1 is in every CA
bundle worth the name, and TLS 1.3 matches the wolfSSL build. That is necessary, not sufficient.

The free test, using the *existing* stump instance and costing zero new code:

```bash
# slot 0 (the LAN catalog) stays untouched; the device holds 8
curl -X POST -H "Content-Type: application/json" --max-time 30 \
  -d '{"name":"TLS test","url":"https://books.keiths-home-server.us/opds/<key>/v1.2/catalog"}' \
  http://crosspoint.local/api/opds
```

Then browse it on the device. Success proves remote HTTPS OPDS works on this hardware. It does
**not** prove the Railway chain specifically (Cloudflare's edge cert ≠ Railway's LE cert) — that
gets proven the moment `/opds` first answers, and it is the acceptance criterion for §11.1.

> ### ⚠️ Device handling rules (from the deployment plan; these are not optional)
> The X3 has **~56 KB free heap** and crashes under load. **One request at a time, never
> pipelined.** `--max-time 30` — it took 6 s just to serve its root page. `GET /api/opds` is small
> and safe; **`GET /api/settings` crashed the device** and must not be issued. Prefer `POST` with a
> small partial body over reading state back; prefer `GET /api/status` for liveness.

---

## 2. The clients

| Client | Catalog | Progress sync | Notes |
|---|---|---|---|
| **Xteink X3** (CrossPoint 1.5.0) | OPDS 1.2 over **HTTPS** (after §1) | vanilla kosync, `koMatchMethod = 1` (binary) | the constrained client; everything below is shaped by it |
| **Readest** (iOS) | OPDS 1.2 over HTTPS | vanilla kosync, checksum = `File Content` | already proven against stump |
| ~~Stump's own app~~ | — | — | **gone.** It spoke Readium locators and clobbered kosync progress — the bug in `stump-issue-draft.md`. Removing it removes the bug. |
| ~~Panels~~ | deferred, §12 | none | comics only |

🔴 **No OPDS 2.0.** Both clients are 1.2 (Atom XML). 2.0 is where a reference implementation like
stump spends most of its effort and none of it reaches these devices.

### 🔴 CrossPoint's parser constraints — these are correctness, not polish

From `lib/OpdsParser/OpdsParser.cpp`, and each one is a silent failure mode:

| Constraint | Failure if violated |
|---|---|
| **≤ 62 entries per feed page** (`ENTRY_STORAGE_CAPACITY - 2`) | book list truncates mid-way, `feedTruncated` flag set |
| Acquisition type is an **exact `strcmp`** on `application/epub+zip` | book invisible to the device entirely |
| Acquisition rel contains `opds-spec.org/acquisition` | same |
| href should contain `.epub` or `/epub/` | book not picked up |
| Pagination rel is **`previous`**, not `prev` | back-navigation silently does nothing |
| Title / author / href caps: 160 / 120 / 768 chars | truncation |

All six become assertions in §10.

---

## 3. Auth

🔴 **Neither protocol can use the `hub-auth` cookie.** Exempt `/opds` and `/kosync` from
`middleware.ts`'s matcher and do their own auth inside — the pattern `api/hoops/import` already
establishes and documents. Both **fail closed** when unset.

- **OPDS: API key in the URL path** — `/opds/{key}/v1.2/catalog`. This is what stump used and what
  is *proven* against CrossPoint. It also needs no auth negotiation on a heap-constrained device.
  (CrossPoint does support HTTP Basic per its `USER_GUIDE.md`; accept it too, but key-in-URL is the
  path that has actually shipped.)
- **kosync: `x-auth-user` + `x-auth-key`**, where the key is `md5(password)` computed client-side.
  🔴 The **wire** value is md5 and cannot be changed without breaking every client. What you store
  **at rest** is free — hash the received md5 again into `key_hash`. Harden the storage, never the wire.
- Keep `/kosync/{key}/...` accepting a key segment too, mirroring stump's shape, so the X3's
  existing sync URL needs only a hostname swap.
- ⚠️ **Never put Cloudflare Access or any challenge in front of these paths** — a key-in-URL client
  cannot complete one.

---

## 4. The invariant everything rests on: byte identity

The kosync document key is a partial MD5 of **file content**, computed on-device:

```
CHUNK_SIZE=1024, OFFSET_COUNT=12, offsets 1024 << (2*i) for i = -1..10
```

Because it is content-addressed, **renaming and moving never break sync** — the whole
`Author/Series/` reorganization on the HDD left every hash untouched, verified in the deployment
plan. The corollary is the dangerous one:

🔴 **A different copy of the same book — a re-rip, a Calibre re-export that rewrites metadata —
has different bytes, a different hash, and will silently never match.** One book = one file,
everywhere. This constrains the migration in §5 and the download path in §7:

- The 13 files must be copied to the Railway volume **byte-for-byte**. Any re-encode detaches the
  progress on all three books that have it.
- The download route must serve stored bytes **untouched** — no compression layer, no metadata
  injection, no rewrite-in-place on metadata edit. A metadata edit writes the DB row; if a file
  must genuinely change, it is a new book id.

**Known client bug, so it isn't misdiagnosed as ours:** [readest#5065](https://github.com/readest/readest/issues/5065)
— Readest on iOS retrieves remote progress for a fresh book and never applies it.

---

## 5. 🔴 Migration: there is live progress, and a clean rebuild loses it

`~/.stump/stump.db` holds real reading positions pushed by `crosspoint-reader`:

| Book | x-pointer | % |
|---|---|---|
| The Two Towers | `/body/DocFragment[11]/body/section[1]/p[105]` | 31.7% |
| The Little Drummer Girl | `/body/DocFragment[17]/body/p[1]` | 34.6% |
| Jonathan Strange and Mr Norrell | `/body/DocFragment[6]/body/p[21]` | 0.4% |

Migrate by joining `reading_sessions` → `media.koreader_hash`, taking the **latest row per
(user, hash)** by `updated_at` (there are multiple sessions per book). That hash is the kosync
document key directly — it needs no translation, and it will match the hash recomputed from the
copied file if and only if §4 was respected. **That equality is the migration's own check.**

Ignore `end_locator` entirely: it is the Readium locator from stump's own app, in the position
language that caused the clobbering bug. Only `koreader_progress` + `end_percentage` carry over.

---

## 6. Storage & DB

Files at `data/books/<book_id>/book.epub` on the volume (`lib/db.ts` already resolves
`process.cwd()/data`, which is `/app/data` in production). One directory per book id — titles get
edited, and a rename is a rewrite risk.

```sql
CREATE TABLE books (
  id, title, author, series, series_index, language, description,
  file_name, file_size,
  sha256       TEXT NOT NULL,   -- integrity + the byte-identity gate (§10)
  partial_md5  TEXT NOT NULL,   -- the kosync document key, computed at ingest
  has_cover, added_at, updated_at
);
CREATE INDEX books_partial_md5 ON books(partial_md5);

CREATE TABLE kosync_users    (username PK, key_hash, created_at);
CREATE TABLE kosync_progress (username, document, progress, percentage,
                              device, device_id, timestamp,
                              PRIMARY KEY (username, document));
```

`kosync_progress.document` is deliberately **not** a FK to `books.id`. A client may sync a document
this library has never seen; the sync server must accept it regardless. `books.partial_md5` is what
lets the UI join the two when they happen to match.

---

## 7. The OPDS surface

Mounted at `/opds/{key}/v1.2/*`, mirroring stump's shape so the X3's URL changes only in hostname.

| Route | Kind |
|---|---|
| `/catalog` | navigation root |
| `/books`, `/books/latest` | acquisition, paginated **≤62/page** |
| `/series`, `/series/{id}` | navigation → acquisition |
| `/search`, `/search/feed?q=` | OpenSearch description → acquisition |
| `/books/{id}/file/{name}.epub` | the bytes (§4) |
| `/books/{id}/thumbnail` | cover |

Serving: stream `fs.createReadStream` as a `ReadableStream`, with `Range` support — a resumed
download on a flaky e-reader connection is the normal case.

---

## 8. Ingest & metadata

An EPUB is a zip: `META-INF/container.xml` → OPF → `<dc:title>`, `<dc:creator>`, `<dc:language>`,
`<dc:description>`, Calibre's `calibre:series` / `series_index`, cover manifest item. A small zip
dep is the sane call (unlike `blake2b` in Hoops, nothing forces a hand-roll).

`~/Stump/organize-books.py` already encodes the author-normalisation and series logic (including
the hand-maintained `SERIES_OVERRIDES` for the two books with no series metadata). **Port its
rules; don't re-derive them.** Metadata extraction failing must not fail the upload — fall back to
the filename and fix it in the UI.

---

## 9. UI

A **Books** entry in the Library group of `lib/sections.ts` (alongside Comics and Hoops).

- `/books` — cover grid, sort/filter, per-book sync state (joined via `partial_md5`).
- `/books/[id]` — metadata, editable fields, download, delete, current position + device + time.
- `/books/add` — multi-file upload with extracted metadata shown before commit.
- **Setup values rendered on screen**, not in a tooltip: the OPDS URL, the kosync URL, and
  `koMatchMethod = 1` / `File Content`. These are the settings that fail *silently*.

Structural precedents: `lib/charts.ts`, `lib/setlists.ts`, `/tune`.

---

## 10. Build / verify gates

`~/Stump/healthcheck.sh` already asserts the **device's contract** rather than server
self-consistency. **Port its assertions; they are hard-won.**

- `npm run check:opds` — catalog is 200 and parses as XML; an entry has a rel containing
  `opds-spec.org/acquisition`; its type is **exactly** `application/epub+zip`; its href contains
  `.epub`; fetching it returns bytes starting with `PK`; **no page exceeds 62 entries**; pagination
  uses `previous`. (§2's table, one assertion each.)
- `npm run check:kosync` — TS `partialMD5` matches a digest computed **independently** (the Python
  snippet in the deployment plan) over a committed fixture, plus a round trip through all endpoints.
- 🔴 `npm run check:books:bytes` — **the §4 landmine pin.** `sha256(bytes served by the download
  route) == books.sha256`, and the recomputed partial MD5 of the served stream equals the stored
  one. This is what stops a future compression middleware from silently desynchronising every
  device at once.
- 🔴 `npm run check:books:migration` — every hash in §5's migrated progress resolves to a book in
  the library. A miss means a file was not copied byte-for-byte.

All wired into `prebuild`, following `check:hoops*` — a broken invariant fails the deploy.

---

## 11. Milestones

1. **Gate zero + ingest.** §1's device TLS test. Then schema, the byte-for-byte copy of the 13
   files, EPUB metadata extraction, `/books` browse. *Check:* `check:books:bytes`.
2. **OPDS.** §7's feeds, key-in-URL auth, ≤62 pagination. *Check:* `check:opds`. **Then the real
   one:** point the X3's slot 1 at `hub.keithadair.com` and download a book.
3. **kosync + migration.** The endpoints, §5's migration. *Check:* `check:kosync` +
   `check:books:migration`. **Then the real one:** read a page on the X3, confirm the position
   lands in the hub; open the same book in Readest and confirm it resumes.
4. **Upload/manage + teardown.** Upload flow, then §11's teardown below.

### Teardown (only after milestone 3 is proven on the device)

Ordering matters — the replacement must be proven before the original is removed.

- [ ] Back up `~/.stump/stump.db` and `/Volumes/HDD/Books` before touching anything
- [ ] Repoint the X3's OPDS slot 0 and `koServerUrl` at `hub.keithadair.com`
- [ ] Repoint Readest
- [ ] `launchctl bootout gui/$(id -u)/com.local.stump`; remove the plist
- [ ] Remove the `books.keiths-home-server.us` ingress from `~/.cloudflared/config.yml`, restart
      cloudflared, and delete the DNS route
- [ ] Remove `~/Stump` and `~/.stump` (keeping `organize-books.py` — §8 ports from it)
- [ ] `/Volumes/HDD/Books` **stays** as the master copy / backup
- [ ] Update `CLAUDE.md` for the new section, and delete `MAC-MINI-DEPLOYMENT-PLAN.md`

---

## 12. Deferred & open questions

- **Comics / Panels — decided AGAINST 2026-08-17, not merely deferred.** Costed it: Railway storage
  is **$0.15/GB/mo**, egress **$0.05/GB** (none free), so even a ~400-issue library is only ~$3/mo.
  But the **Hobby plan caps a volume at 5 GB** (~100 issues at ~50 MB), so the true price is the
  **+$15/mo Pro upgrade** — five times the storage it unlocks. And the payoff is nil: Panels has no
  kosync (it syncs via iCloud regardless), and the X3 can't meaningfully read comics, so there is no
  second-device story of the kind that justified this entire project for EPUBs. The owner's comics
  live in Google Drive and Humble Bundle, and **Panels reads Google Drive directly** — self-hosting
  would spend money to lose Drive's storage and gain a second copy to keep in sync. Revisit only if
  Panels' Drive integration degrades (third-party Drive clients do get squeezed by API policy
  changes); the OPDS spine already stands, and would need a format column, comic MIME types and a
  bigger volume — not a rewrite.
- **If gate zero fails** *(it didn't — see the status header)*. If the X3 genuinely can't do TLS to Railway, the fallback is the
  standalone-on-the-Mini service (Node/TS on port 10801, preserving stump's URL shapes so the device
  needs no reconfiguration). Everything in §3–§10 ports unchanged; only the host moves.
- **Upstream issue.** `stump-issue-draft.md` is still worth filing — an ESP32 OPDS client is a
  combination the maintainer doesn't test against, and the `rel="prev"` class of bug falls out of it.
- **Ingest source.** Manual upload in v1. `organize-books.py --import` already dedupes by content
  hash if a drop-folder flow is wanted later.
</content>
