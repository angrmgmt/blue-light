# Final Report: Blue Light Phase 1 Implementation

## What was Implemented

The first phase of the **Blue Light** project focused on extracting
collaborative content (chat-style messages) from web pages or local HTML files
and formatting them into a clean plain text structure.

Key components implemented:

- **CLI Entry Point (`main.ts`)**: A Deno-based command-line interface that
  accepts a URL or file path, extracts content, and either prints it to stdout
  or saves it to a specified file.
- **Scraper (`src/scraper.ts`)**: Handles fetching HTML content from URLs using
  Deno's native `fetch` API, including a modern Edge user-agent to avoid basic
  bot detection.
- **Parser (`src/parser.ts`)**: A heuristic-based parser using `deno-dom`. It
  employs multiple strategies:
  - **DOM Heuristics**: Identifies repeating message structures by looking for
    classes containing "message", "chat", or "bubble" and extracting author/text
    pairs.
  - **Next.js RSC/JSON Payload**: Extracts structured data directly from
    `self.__next_f.push` scripts, which is common in modern React-based chat
    applications.
  - **God Simulator Pattern**: Specifically handles the "name/description"
    pattern found in some collaborative platforms.
- **Formatter (`src/formatter.ts`)**: Converts the structured
  `CollaborativeContent` array into a clean `[Author]: [Text]` format, with
  proper indentation for multiline messages.
- **Edge TTS Research (`research/edge_tts_research.md`)**: A detailed technical
  spike documenting the WebSocket protocol, authentication (Sec-MS-GEC), and
  data flow required for Phase 2.

## How the Solution was Tested

The implementation was verified through several layers:

1. **Unit Tests**: A comprehensive test suite in `tests/parser_test.ts` covers:
   - Standard DOM-based chat bubble structures.
   - Next.js RSC payload extraction using regex.
   - Metadata-rich patterns (God Simulator style).
   - Edge cases like empty input or HTML with no matching patterns.
2. **Integration Verification**: The CLI was tested against sample HTML content
   to ensure the full pipeline (Read/Fetch -> Parse -> Format -> Write) works as
   expected.
3. **Linting and Formatting**: The codebase adheres to Deno's standards via
   `deno lint` and `deno fmt`.

## Biggest Issues or Challenges Encountered

- **Dynamic Content (SPA/RSC)**: Many modern chat applications do not render
  messages directly in the static HTML but instead load them via Next.js RSC
  payloads or JSON scripts. Solving this required moving beyond simple DOM
  traversal and implementing regex-based extraction from script tags.
- **Heuristic Accuracy**: Collaborative content varies wildly across platforms.
  Creating a "one size fits all" heuristic for author/text detection is
  inherently challenging. The multi-strategy approach (DOM + Script extraction)
  was implemented to mitigate this.
- **Edge TTS Protocol Complexity**: Researching the Microsoft Edge Read Aloud
  API revealed complex security requirements, specifically the `Sec-MS-GEC`
  token calculation which is time-sensitive and requires specific headers. This
  will be the primary challenge for Phase 2.
