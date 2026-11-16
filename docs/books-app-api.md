# Books app API

The contract between keith-hub and a native client (a private build of Sheafs) for the hub's book
features. Base URL: `https://hub.keithadair.com`. Every request and response body is JSON (UTF-8)
unless stated otherwise. `npm run check:books:app-token` (in `prebuild`) checks every endpoint
listed here against the real routes, and checks the fields below against real responses.

## Conventions

- **Auth:** send `Authorization: Bearer <BOOKS_APP_TOKEN>` on every request. Details below.
- **Book id:** a UUID string, stable for the life of a book (metadata edits and file replacements
  keep it).
- **Document key (`partialMd5`):** the KOReader-sync partial MD5 of the epub file's bytes, as 32
  lowercase hex characters. The hub accepts it in either case.
- **Timestamps:** two kinds. Fields on `Book` (`addedAt`, `updatedAt`, `toReadAt`) are ISO 8601
  strings (`"2026-11-15T15:45:43.123Z"`). Every other time field is an integer of **Unix seconds**.
- **Days:** a `day` is a `"YYYY-MM-DD"` calendar day in `America/Denver`, never UTC.
- **Percentages:** `0..1` (as the kosync protocol uses them), not `0..100`.
- **Pages:** one page is 387 words of the epub's own text (`pageWords` in the stats response). Page
  figures are estimates, within about ±20% of a printed edition.
- **Nullability:** a field shown as `T | null` is always present and may be `null`. Fields are never
  omitted unless the endpoint says so. Clients should ignore fields they don't know, because new
  fields may be added.
- **Errors:** a non-2xx response is `{ "error": string }` (a human-readable reason) unless stated
  otherwise. Any endpoint can answer `500 { "error": "Internal server error" }`.

## Auth

```
Authorization: Bearer <BOOKS_APP_TOKEN>
```

- The scheme is case-insensitive (`Bearer`, `bearer`). Exactly one space-separated token, nothing
  after it.
- The token is accepted on `/api/books` and `/api/books/…` **only**. On any other hub path it is
  ignored: other `/api/…` routes answer `401`, and pages redirect to `/login`.
- A missing, malformed or wrong token on `/api/books/…` gets
  `401 { "error": "Unauthorized" }`. The token is **refused when the server has no
  `BOOKS_APP_TOKEN` set** (fail closed): every bearer request gets `401` until it is configured.
- A request is let through exactly as a logged-in browser's would be. Nothing behind the middleware
  can tell the two apart, so every endpoint below behaves identically for the cookie and the token.
- A path containing an encoded dot, slash or backslash (`%2e`, `%2f`, `%5c`) is refused on the
  token. No Books route needs one.

## Types

### `Book`

```jsonc
{
  "id": "string",              // UUID
  "title": "string",
  "author": "string | null",
  "series": "string | null",
  "seriesIndex": "number | null", // may be fractional (2.5)
  "language": "string | null",    // dc:language, e.g. "en"
  "description": "string | null",
  "fileName": "string",           // the uploaded file name
  "fileSize": "number",           // bytes
  "sha256": "string",             // hex, of the stored file
  "partialMd5": "string",         // the CURRENT document key
  "coverName": "string | null",   // null = no cover; else GET /api/books/{id}/cover serves it
  "wordCount": "number | null",   // null = not measured yet, 0 = no readable text
  "toRead": "boolean",            // on the To Read shelf
  "toReadAt": "string | null",    // ISO 8601, when it was put on the shelf
  "addedAt": "string",            // ISO 8601
  "updatedAt": "string"           // ISO 8601, last metadata edit or file replacement
}
```

### `Sync`

The latest synced position for the book, from any device.

```jsonc
{
  "progress": "string",       // the device's position string, byte-exact (an EPUB x-pointer); opaque
  "percentage": "number",     // 0..1
  "device": "string | null",  // the device name it was synced from
  "timestamp": "number"       // Unix seconds, when the hub received it
}
```

### `BookHistory`

One book's reading history, as `/books/{id}` shows it.

```jsonc
{
  "started": "boolean",               // false = never synced; the forecast is then for the WHOLE book
  "daysRead": "number",               // distinct days with progress on this book
  "pages": "number",                  // pages read in this book (integer)
  "firstSeen": "number | null",       // Unix seconds, first sync the hub recorded
  "lastRead": "number | null",        // Unix seconds
  "finishes": [{ "finishedAt": "number", "daysTaken": "number | null" }], // newest first
  "readingDaysToFinish": "number | null", // reading days left at the reader's rate
  "daysToFinish": "number | null",    // calendar days left; the finish date is now + this many days
  "pagesLeft": "number | null",
  "totalPages": "number | null"       // null when the word count is unknown
}
```

`readingDaysToFinish` and `daysToFinish` are `null` together: either the reader has fewer than 3
reading days in the last 21, or the book's length is unknown. History begins on the day the hub
started recording; earlier reading isn't in it.

### `AskTurn`

```jsonc
{
  "id": "number",
  "role": "\"user\" | \"assistant\"",
  "content": "string",   // the question, or the answer as Markdown
  "words": "number",     // words of the book that had been read when it was asked
  "createdAt": "number"  // Unix seconds
}
```

## Endpoints

### `GET /api/books/by-md5/{partialMd5}`

Find the hub's book for the file the app has open, by its document key. Old keys still work: a book
whose file was edited in place (new cover, fixed title) keeps every earlier key as an **alias**, so
a copy downloaded before the edit still finds the same book and the same position.

Response `200`:

```jsonc
{
  "book": Book,               // book.partialMd5 is the CURRENT key
  "matchedAlias": "boolean",  // true = the key asked for is an older file's key (the app has an old copy)
  "aliases": ["string"],      // every older key of this book, oldest first ([] if none)
  "sync": Sync | null,        // null = never synced
  "history": BookHistory
}
```

`matchedAlias: true` means the app's copy is out of date. Syncing it still works, and the hub
treats both keys as one book.

Errors: `400` when the key is not 32 hex characters, `404 { "error": "no book with this key" }`
when no book has the key (for example, a sideloaded file the hub doesn't have).

### `GET /api/books/stats`

The reading statistics, exactly as `/books/stats` renders them (the same server call).

Response `200`:

```jsonc
{
  "stats": ReadingStats,
  "pageWords": 387,             // words per page, for labels
  "timeZone": "America/Denver"  // the zone every `day` is in
}
```

`ReadingStats`:

```jsonc
{
  "hasHistory": "boolean",
  "since": "number | null",          // Unix seconds of the first recorded event; "all time" means since this
  "today": { "day": "string", "pages": "number", "syncs": "number", "books": "number" },
  "streak": {
    "current": "number",             // days; survives until a whole day is missed
    "longest": "number",
    "bankedToday": "boolean",        // today already counts
    "atRisk": "boolean"              // current > 0 and today not banked yet
  },
  "calendar": [                      // 371 cells, oldest first, ending today
    { "day": "string", "pages": "number", "syncs": "number", "books": "number" }
  ],
  "rate": {                          // null until 3+ reading days in the last 21
    "perCalendarDay": "number",      // pages per calendar day over the window (1 decimal)
    "perReadingDay": "number",       // pages per day actually read (1 decimal)
    "readingDays": "number",
    "pages": "number",
    "windowDays": "number"           // 21
  } | null,
  "nowReading": [                    // books in progress (< 97%), most recently synced first
    {
      "book": StatsBook | null,      // null = a document no hub book matches
      "document": "string",          // its current document key
      "percentage": "number",        // 0..1
      "pagesRead": "number",
      "pagesLeft": "number",
      "lastReadAt": "number",        // Unix seconds
      "daysIdle": "number",
      "readingDaysToFinish": "number | null",
      "daysToFinish": "number | null",   // calendar days; finish date = now + this
      "stalled": "boolean"           // no sync for 10+ days
    }
  ],
  "finished": [                      // newest first; a finish = crossing 97%
    {
      "book": StatsBook | null,
      "document": "string",
      "finishedAt": "number",        // Unix seconds
      "day": "string",
      "words": "number | null",
      "daysTaken": "number | null"   // null when the start wasn't observed
    }
  ],
  "records": {
    "bestDay": { "day": "string", "pages": "number" } | null,
    "longestStreak": "number"
  },
  "totals": {
    "pages": "number",
    "words": "number",
    "booksFinished": "number",
    "daysRead": "number",
    "pagesThisYear": "number",
    "booksFinishedThisYear": "number"
  },
  "pace": {
    "last7": "number",               // pages per day over the last 7 days (1 decimal)
    "last30": "number",              // pages per day over the last 30 days (1 decimal)
    "window": "number"               // 21
  },
  "devices": [                       // most syncs first; "Unknown device" when a sync named none
    { "device": "string", "pages": "number", "syncs": "number" }
  ],
  "badges": [
    {
      "key": "string",               // stable: first-light, kindling, week-one, fortnight, the-long-haul,
                                     // centurion, century, double-century, the-end, shelf-of-five,
                                     // doorstopper, devoured, comeback, series-sweep, two-timer, ambidextrous
      "name": "string",
      "blurb": "string",
      "earnedAt": "number | null",   // Unix seconds; null = not earned
      "progress": "number"           // 0..1 toward earning it
    }
  ],
  "unmeasured": { "documents": "number", "syncs": "number" } // synced documents no hub book matches
}
```

`StatsBook` is a subset of `Book`:
`{ "id", "title", "author", "series", "seriesIndex", "partialMd5", "wordCount", "coverName" }`, with
the same types.

Reading days count by the day a sync arrived, which is not always the day the reading happened. The
statistics are deliberately missing two things: time spent reading and time of day. A sync records
when the device pushed, not when the reading happened, so neither can be measured.

### `POST /api/books/{id}/to-read`

Put a book on the To Read shelf, or take it off.

Request: `{ "toRead": boolean }`. Response `200 { "book": Book }`.

Errors: `400 { "error": "toRead must be a boolean" }` (also for a body that isn't JSON),
`404 { "error": "not found" }`.

### `PUT /api/books/{id}`

Edit the book's metadata in the hub. This changes the database row only, never the file: the key,
the position and the copy on any device are unaffected, and a device keeps showing its own file's
title.

Request: a JSON object, every field optional. A field left out is unchanged.

| field | accepted | effect |
| --- | --- | --- |
| `title` | non-empty string | trimmed. An empty or whitespace string is ignored, so a title can't be cleared |
| `author`, `series`, `language`, `description` | string or `null` | trimmed; `""` or `null` clears to `null` |
| `seriesIndex` | finite number or `null` | `null` clears |

Values of any other type are ignored. Response `200 { "book": Book }` (the updated book).

Errors: `404 { "error": "not found" }`, `500` for a body that isn't JSON.

### `GET /api/books/{id}/cover`

The cover image bytes (not JSON). `Content-Type` is `image/jpeg`, `image/png`, `image/gif` or
`image/webp`, with `Cache-Control: private, max-age=3600`. `404` with an empty body when the book
has no cover (`book.coverName` is `null`) or doesn't exist.

The route ignores the query string. Append `?v=<first 12 hex chars of book.sha256>` to bust a cached
cover after a file replacement; the OPDS feed does the same.

### Where Ask cuts the book: `until`

The model is sent the book from the start up to a position, and nothing at or after it. That
position is the app's **`until`** when it sends one, otherwise the latest synced position:

```jsonc
"until": {
  "pointer": "string",     // a CREngine pointer to the END of what the reader can see: the first
                           // character after the page (or spread) on screen, /body/DocFragment[N]/…
  "percentage": "number"   // that place as a fraction of the book, 0..1 (used when the pointer's
                           // element can't be found)
}
```

The word the pointer names is the first one **not** sent; everything before it is. The start of a
chapter (`/body/DocFragment[N]/body`) sends all of the chapter before it. A pointer past the book's
last word (or a percentage of 1 for an element that can't be found) sends the whole book. A synced
position, by contrast, is where the page STARTS, so without `until` the page on screen is left out.

`until` is optional (the web page and older apps don't send it). When present it must be valid, or
the request is refused `400 { "error" }` naming it: `pointer` a non-empty string of at most 1,000
characters that parses as a pointer, `percentage` a number from 0 to 1. A malformed `until` is never
quietly replaced by the synced position. A hub from before `until` ignores it and cuts at the synced
position; `cut` (below) is missing in its answers.

### `GET /api/books/{id}/ask`

The book's saved conversation (one thread per book, shared by every device), and whether a
question can be asked right now. `?until=<pointer>&percentage=<0..1>` (URL-encoded) asks how much
the app's cutoff would send; the same rules as POST's `until`, `400` when malformed.

Response `200`. It always has:

```jsonc
{
  "turns": [AskTurn],          // oldest first; alternates user, assistant
  "pending": "boolean",        // the last question is still being answered
  "configured": "boolean"      // the server has an Anthropic key
}
```

plus **one** of:

```jsonc
{ "unavailable": "string" }    // why a question can't be asked: no synced position yet (and no
                               // until), the position is at the very start, or the file can't be read
```

```jsonc
{
  "words": "number",           // words of the book that would be sent (everything before the position)
  "totalWords": "number",
  "percentage": "number",      // the position cut at (until's, else the synced one), 0..1
  "precision": "\"word\" | \"paragraph\" | \"percentage\" | \"none\"", // how exactly the position resolved
  "cut": "\"until\" | \"synced\""  // which position: the app's until, or the latest sync
}
```

`configured: false` means `POST` will answer `503`. Errors: `404 { "error": "not found" }`,
`400 { "error" }` for a malformed `until`.

While `pending` is true, poll this endpoint every few seconds. An answer is finished and saved on the
server even if the app disconnects mid-answer, so it shows up here on its own. A question that has
been pending for 5 minutes stops counting as pending.

### `POST /api/books/{id}/ask`

Ask a question. The model is sent the book's text up to `until` (else the latest synced position)
and nothing after it, plus the saved conversation. The earlier turns come from the server, never
from the request.

Request: `{ "question": string, "until"?: { "pointer": string, "percentage": number } }` (the
question trimmed, 1 to 4,000 characters; `until` as above). The turn stores the words it was
answered from (`AskTurn.words`), so with `until` that is the end of the page on screen.

Refusals before anything starts are ordinary JSON errors, checked in this order:

| status | when |
| --- | --- |
| `400` | `question` missing, empty, or over 4,000 characters; or `until` malformed |
| `503` | the server has no `ANTHROPIC_API_KEY` |
| `404` | no such book |
| `409` | no `until` and no synced position yet, or the position is at the very start of the book |
| `500` / `422` | the stored file can't be read / its text can't be parsed |
| `409` | an earlier question on this book is still being answered |

Otherwise the response is `200`, `Content-Type: application/x-ndjson; charset=utf-8`: one JSON object
per line, each ending `\n`, streamed as they happen:

```jsonc
{"t":"meta","words":number,"totalWords":number,"percentage":number,"cut":"until"|"synced"} // always first
{"t":"text","v":"string"}   // zero or more; concatenate the v's to get the answer (Markdown)
{"t":"done"}                // last line on success
{"t":"error","v":"string"}  // last line on failure, instead of "done"; v is a readable reason
```

Exactly one of `done` or `error` ends the stream. On `error`, the question has been removed from the
thread, with one exception: `"The answer was cut off at the length limit."` comes after the text,
and that truncated answer **is** saved. After the stream ends, `GET` the thread for the saved state.

### `DELETE /api/books/{id}/ask`

Clear the book's conversation. Response `200 { "cleared": number }` (turns removed).
Errors: `404 { "error": "not found" }`.

### Also available

#### `GET /api/books`

`200 { "books": [Book] }`: the whole library, sorted by author, series, series index, then title.

#### `GET /api/books/{id}`

`200 { "book": Book }`, or `404 { "error": "not found" }`.
