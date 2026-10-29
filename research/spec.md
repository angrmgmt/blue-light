# Technical Specification: Blue Light (Web Text Extractor & TTS)

## 1. Technical Context

- **Runtime**: Deno 2.x (Severing ties with Node.js)
- **Language**: TypeScript
- **Dependencies**:
  - `jsr:@b-on/deno-dom`: Light-weight HTML parsing (JSR native).
  - `jsr:@std/cli`: Command-line argument parsing.
  - `jsr:@std/fs`: File system operations.
  - `jsr:@std/http`: WebSocket and networking (for Edge TTS).
- **External APIs**: Microsoft Edge Read Aloud WebSocket API
  (`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`).

## 2. Implementation Approach

### Phase 1: Text Extraction (Current Focus)

- **Fetching**: Use Deno's native `fetch` API. Target:
  `https://www.gptgirlfriend.online/recent-chats`. If it requires authentication
  or is an SPA, we will attempt to handle it via fetch if possible, or advise on
  how to extract from the WebView2 app.
- **Parsing**: Utilize `deno-dom` (JSR) if necessary for complex parsing, but
  prefer zero external imports if the required logic is simple enough to
  implement natively.
- **Collaborative Pattern Detection**: Look for repeatable structures (e.g.,
  chat bubbles) as seen in the "Chats" page of GirlfriendGPT.
- **Output**: Stream the processed text into a `.txt` file with clear
  author/content separation.

### Phase 2: Edge TTS Integration (Future)

- **WebSocket Client**: Implement a Deno-native WebSocket client to communicate
  with the Edge Read Aloud service.
- **Multi-voice Support**: Manage a pool of voice identifiers and switch
  dynamically based on the "author" identified in Phase 1.
- **Zero-delay Switching**: Buffer the next sentence/author's audio while the
  current one is playing.
- **Audio Output**: Support direct playback or saving to an `.mp3` file.

## 3. Source Code Structure Changes

- `main.ts`: CLI entry point for processing URLs or files.
- `src/scraper.ts`: Logic for fetching and initial DOM parsing.
- `src/parser.ts`: Logic for identifying and extracting collaborative content
  patterns.
- `src/formatter.ts`: Logic for converting extracted data into the final text
  format.
- `src/tts/`: (Future) Edge TTS implementation.
- `tests/`: Unit tests for parsing logic.

## 4. Data Model / API / Interface Changes

- **Internal Representation**:
  ```typescript
  interface CollaborativeContent {
    author: string;
    text: string;
    metadata?: Record<string, string>;
  }
  ```
- **CLI Interface**:
  ```bash
  deno run -A main.ts <url-or-file> --output <filename.txt>
  ```

## 5. Verification Approach

- **Unit Testing**: Test the `parser.ts` with mock HTML snippets of
  "collaborative" formats.
- **Linting**: Use `deno lint`.
- **Formatting**: Use `deno fmt`.
- **Integration Test**: Run the scraper against a known sample URL and verify
  the `.txt` output.
