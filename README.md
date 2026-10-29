# Blue Light

Blue Light is a Deno CLI that extracts collaborative text content (chat
conversations, role-play sessions, character dialogue) from URLs and HTML files,
formats it as plain text, and optionally renders the dialogue to speech using
Microsoft Edge's Read Aloud voices.

It targets two sites out of the box:

- **gptgirlfriend.online** — character chats accessed via the site's private
  REST API (with a Clerk bearer token) when possible.
- **v2.dreamgen.com** — role-play / story sessions read straight out of the
  rendered HTML's inline `seroval` payload, with no browser needed.

For any other URL, Blue Light opens a real Chromium tab through the Chrome
DevTools Protocol (CDP), waits for content to render, scrolls infinite-scroll
chat UIs to load full history, then parses the resulting HTML.

## Requirements

- [Deno](https://deno.com) v2.x
- Chrome or Microsoft Edge, launched with the remote debugging port:

  ```bash
  chrome.exe --remote-debugging-port=9222
  msedge.exe --remote-debugging-port=9222
  ```

  Blue Light uses this to fetch session cookies for authenticated sites, and
  (when no API path is available) to render JavaScript-heavy pages.

## Installation

The project has no install step — Deno resolves all dependencies on first run
from the imports declared in `deno.json`:

```bash
deno cache main.ts
```

## Project layout

```text
.
├── deno.json              # Tasks, JS imports, fmt/lint excludes
├── main.ts                # CLI entry point
├── src/
│   ├── scraper.ts         # Plain HTTP fetch with optional Cookie header
│   ├── cookies.ts         # Cookie + Clerk token extraction via CDP
│   ├── browser.ts         # Browser tab control, navigation, infinite-scroll
│   ├── parser.ts          # HTML → CollaborativeContent;  story segmentation
│   ├── formatter.ts       # CollaborativeContent[] → plain text
│   ├── gptgf.ts           # gptgirlfriend.online REST client + chat lister
│   ├── dreamgen.ts        # DreamGen HTML/seroval parser + session lister
│   ├── tts.ts             # Edge Read Aloud WebSocket client + voice assignment
│   └── list.ts            # `list <site>` subcommand
├── tests/
│   ├── parser_test.ts     # parseCollaborativeContent unit tests
│   └── dreamgen_test.ts   # parseSessionTurns / activePath unit tests
├── research/              # One-off research spikes (Edge TTS, DreamGen capture)
│   ├── edge_tts_spike.ts
│   ├── edge_tts_research.md
│   ├── dreamgen_capture.ts
│   └── ...
├── debug_*.ts / debug.*        # Ad-hoc debugging artifacts (excluded from fmt/lint)
└── output/                     # Extracted text + TTS audio, per chat
    ├── Aspen/{Aspen.mp3, Aspen.txt}
    ├── Bree/{Bree.mp3, Bree.txt}
    ├── Quinn/{Quinn.mp3, Quinn.txt}
    └── Shirley/Shirley.txt
```

## Usage

```powershell
deno run -A main.ts <url-or-file> [options]
deno run -A main.ts list <site> [--cookie <v>] [--browser-port <n>]
deno run -A main.ts list-voices [locale]
```

### Options

| Flag                  | Description                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `-o, --output <file>` | Save plain-text output to a file (default: `output/<chatName>/<chatName>.txt` when a chat name can be derived, else stdout) |
| `-c, --cookie <v>`    | Cookie header string (plain fetch fallback only)                                                                            |
| `--browser-port <n>`  | Chrome/Edge remote debug port (default: `9222`)                                                                             |
| `--wait-ms <n>`       | Extra ms after page load to wait for dynamic content (default: `3000`)                                                      |
| `--no-browser`        | Skip CDP rendering; fall back to plain fetch with auto-cookie                                                               |
| `--tts`               | Render the dialogue to speech                                                                                               |
| `--tts-prompt`        | Prompt at the terminal for per-character voice choice                                                                       |
| `--tts-output <file>` | Where to write the audio (default: `output/<chatName>/<chatName>.mp3` when a chat name can be derived, else `<input>.mp3`)  |
| `-h, --help`          | Show the help message                                                                                                       |

### Subcommands

- **`list gptgf`** — list your gptgirlfriend.online chats (title + URL).
- **`list dreamgen`** — list your v2.dreamgen.com sessions (title + format +
  URL).
- **`list-voices [locale]`** — list Edge Read Aloud voices with gender, locale,
  and personality tags. Locale defaults to `en-US`; pass `en`, `fr-FR`, `all`,
  etc.

### Examples

```bash
# Extract a DreamGen session and print it as text
deno run -A main.ts https://v2.dreamgen.com/app/my/session/<id>

# Extract a gptgirlfriend.online chat, with extra render wait time
deno run -A main.ts https://www.gptgirlfriend.online/chat/<id> --wait-ms 5000

# Extract to a file
deno run -A main.ts ./sample.html --output results.txt

# Render a chat to speech with auto-assigned voices
deno run -A main.ts <url> --tts

# Render a chat to speech, picking voices interactively
deno run -A main.ts <url> --tts --tts-prompt

# Re-render speech from a previously saved text archive (no re-fetch needed)
deno run -A main.ts "output/Bree/Bree.txt" --tts --tts-prompt

# Same, from a file saved with --output, to a custom audio path
deno run -A main.ts results.txt --tts --tts-output story.mp3

# Force plain fetch (skip browser rendering)
deno run -A main.ts <url> --no-browser --cookie "<session-cookie>"
```

## How it works

When given a URL, the extractor tries paths in priority order:

1. **Site-specific API path** — if the URL is a gptgirlfriend or DreamGen
   session/chat URL, Blue Light calls that site's REST endpoint directly.
   gptgirlfriend also reads a Clerk bearer token out of the live tab via CDP
   (`fetchClerkTokenViaCDP`). All messages come back in one call — no rendering
   or scrolling needed.
2. **Browser rendering via CDP** — opens a Chromium tab, navigates to the URL,
   waits `--wait-ms`, scrolls the chat container to the top until no more
   history loads, then reads `document.documentElement.outerHTML`.
3. **Plain fetch + auto-cookie** — final fallback, used when CDP is disabled
   with `--no-browser`. Catches the simpler "static HTML" case.

When given a local file, the extractor reads it as text. `.txt` files are split
into `Author: message` lines; Perchance AI Story V1 `.json` files use the
`storySoFar` field as the story text and the `title` field for output naming;
other files are parsed as HTML. This means the text archives Blue Light itself
writes (via `--output` or the automatic `output/<chatName>/<chatName>.txt`) can
be fed back in as input — e.g. to run `--tts` on a chat that was already
extracted — and all TTS flags behave the same as for URLs. When the input _is_
the chat's own archive file, Blue Light skips the usual re-save so the archive
is never overwritten by its own re-parse.

## Module reference

- **`src/scraper.ts`** — `fetchHtml(url, options?)`. Thin wrapper around `fetch`
  that adds a desktop Chrome User-Agent and optional Cookie header.

- **`src/cookies.ts`** —
  - `fetchCookiesViaCDP(url, port?)`: builds a `Cookie` header string by talking
    to Chrome's CDP `/json` endpoint and using `Network.getCookies`.
  - `fetchClerkTokenViaCDP(domainMatch, port?)`: opens a CDP session on a tab
    whose URL matches `domainMatch`, then evaluates
    `window.Clerk.session.getToken()` to retrieve a short-lived Clerk JWT. Both
    connect to `127.0.0.1:<port>` (instead of `localhost`) because on Windows
    localhost may resolve to IPv6 while Edge binds IPv4 only.

- **`src/browser.ts`** — `fetchRenderedHtml(url, debugPort?, waitMs?)`. Creates
  a `CdpSession`, opens a new tab, navigates, scrolls the chat list container to
  the top until `scrollHeight` stops growing (capped at 60 iterations), and
  returns the resulting HTML.

- **`src/parser.ts`** —
  - `parseCollaborativeContent(html)`: parses HTML into `CollaborativeContent[]`
    using two strategies — gptgirlfriend bubble walk-up (`word-wrap-break` +
    avatar img alt text), then a generic fallback for any element with `message`
    / `chat-bubble` / `ChatBubble` in its class list.
  - `parsePlainTextContent(text)`: turns `Author: message` lines into
    `CollaborativeContent[]`, joining continuation lines to the previous author.
  - `decomposeContent(content)`: splits each message into `StorySegment` records
    (dialogue vs. narration), with light cross-attribution for third-person
    narration that mentions other character names.

- **`src/formatter.ts`** — `formatToPlainText(data)`. Emits `Author: text`
  lines, indenting continuation lines by two spaces, separated by blank lines.

- **`src/gptgf.ts`** —
  - `isGptGfChatUrl(url)` / `fetchGptGfMessages(url, cookie, token?)`: hit
    `/api/chat/<id>` for the full message list (with auth headers including the
    Clerk bearer if available). Replaces `{{char}}` / `{{user}}` template
    variables with the configured character / user names.
  - `listGptGfChats(cookie, token?)`: pages through `/api/v2/user/chats` to
    enumerate every chat with title, message count, and updatedAt.

- **`src/dreamgen.ts`** —
  - `isDreamGenSessionUrl(url)` / `dreamGenSessionId(url)`.
  - `parseSessionTurns(html)`: regex-extracts each inlined turn
    `{id:"…",parentId:…}` from the HTML's `seroval` payload.
  - `activePath(turns)`: walks the parent links from the most recent turn back
    to the root, returning the chronological conversation ("active" branch —
    newer regenerated turns override older siblings).
  - `parseSessionList(html)`: enumerates sessions with title, format,
    interaction count, and updatedAt.
  - `fetchDreamGenMessages(url, cookie)` / `listDreamGenSessions(cookie)`:
    compose the above with a plain authenticated fetch (v2.dreamgen.com
    server-renders every page with full data inline, so no browser is needed).

- **`src/tts.ts`** — Microsoft Edge Read Aloud WebSocket client.
  - `listVoices(localePrefix)` / `formatVoiceLine(voice)`: enumerate and
    pretty-print the available neural voices (filters by locale prefix; `"all"`
    returns everything).
  - `autoAssignVoices(characters)`: maps each character to a voice — name
    matches first ("Ava" → Ava voice), then alternating male/female pools of
    expressive voices. The narrator gets a voice tagged for
    news/novel/audiobook.
  - `promptAssignVoices(characters)`: same as above, but lets the user pick
    interactively.
  - `synthesize(text, voiceName)`: speaks one chunk and returns the MP3 bytes.
  - `synthesizeStory(segments, mapping)`: plays every segment in parallel with
    bounded concurrency, then concatenates the audio.

- **`src/list.ts`** — `runListCommand({site, cookie?, port})` — wires the
  per-site listers (`gptgf`, `dreamgen`) into the `list <site>` subcommand,
  including optional CDP-based cookie + Clerk-token resolution.

## Development tasks

```bash
deno task dev          # Watch mode for main.ts
deno fmt               # Format code
deno fmt --check       # Verify formatting (matches CI)
deno lint              # Run the linter
deno check **/*.ts     # Type-check the whole project
deno test              # Run the test suite
```

## Data files

The repository contains several large data artifacts that are excluded from
formatting and linting via `deno.json`:

- `debug.html`, `debug_rendered.html`, `debug_api.json` — captured HTML / JSON
  for debugging.
- `debug_*.ts` — throwaway debug scripts.
- `output/` — extracted text and TTS audio, organized as one subfolder per chat
  (e.g. `output/Aspen/Aspen.txt` and `output/Aspen/Aspen.mp3`).
- `.junie/`, `.idea/`, `.zencoder/`, `.claude/` — IDE / tool config.

## Configuration notes

- We use `127.0.0.1` rather than `localhost` for CDP endpoints because on
  Windows `localhost` may resolve to `::1` while Edge only binds `127.0.0.1`,
  causing `ECONNREFUSED`.
- The Edge Read Aloud WebSocket protocol requires a `Sec-MS-GEC` header — a
  SHA-256-based token over the current Windows file-time (bucketed to 5 minutes)
  and a known `TrustedClientToken`. See `research/edge_tts_research.md` for
  protocol details.
- The gptgirlfriend REST API now requires a Clerk JWT in addition to the session
  cookie; keep a logged-in gptgirlfriend tab open so the helper
  `fetchClerkTokenViaCDP` can read it from `window.Clerk.session`.
