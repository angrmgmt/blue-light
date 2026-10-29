import { parseArgs } from "@std/cli/parse-args";
import { fetchHtml } from "./src/scraper.ts";
import { pollForClerkToken, withCookieRetry } from "./src/cookies.ts";
import { fetchRenderedHtml } from "./src/browser.ts";
import {
  type CollaborativeContent,
  decomposeContent,
  parseCollaborativeContent,
  parseLocalInput,
  type StorySegment,
} from "./src/parser.ts";
import { formatToPlainText } from "./src/formatter.ts";
import { fetchGptGfMessages, isGptGfChatUrl } from "./src/gptgf.ts";
import { fetchDreamGenMessages, isDreamGenSessionUrl } from "./src/dreamgen.ts";
import {
  autoAssignVoices,
  formatVoiceLine,
  listVoices,
  promptAssignVoices,
  synthesizeStory,
} from "./src/tts.ts";
import { runListCommand } from "./src/list.ts";
import {
  deriveChatName,
  extractHtmlTitle,
  sanitizeFolderName,
} from "./src/chatname.ts";

/** Output dir, kept in sync with the README and `deno.json` fmt excludes. */
const OUTPUT_ROOT = "output";

/** Result of fetching content for a URL — messages plus an optional title. */
interface UrlFetchResult {
  messages: CollaborativeContent[];
  /** Best-effort chat title pulled from the source (API doc, HTML title…). */
  title: string | null;
  /** Raw HTML when the source was a browser-rendered page; null otherwise. */
  html: string | null;
  /** Pre-attributed TTS segments for formats that are prose rather than chats. */
  ttsSegments?: StorySegment[];
}

/**
 * Main entry point for the Blue Light CLI.
 */
async function main() {
  const args = parseArgs(Deno.args, {
    string: ["output", "cookie", "browser-port", "wait-ms", "tts-output"],
    boolean: ["help", "no-browser", "tts", "tts-prompt", "refresh-cookies"],
    alias: {
      output: "o",
      cookie: "c",
      help: "h",
      "refresh-cookies": "r",
    },
    default: {
      "browser-port": "9222",
      "wait-ms": "3000",
    },
  });

  // Allow scripted callers to force a cookie refresh via env var.
  const refreshCookies = Boolean(args["refresh-cookies"]) ||
    Deno.env.get("BL_REFRESH_COOKIES") === "1";

  if (args.help) {
    printHelp();
    return;
  }

  const command = args._[0]?.toString();

  // Subcommands (browsing / discovery) run before the extract flow.
  if (command === "list-voices") {
    await runListVoices(args._[1]?.toString());
    return;
  }
  if (command === "list") {
    await runListCommand({
      site: args._[1]?.toString(),
      cookie: args.cookie,
      port: parseInt(args["browser-port"], 10),
      refresh: refreshCookies,
    });
    return;
  }

  const input = command;

  if (!input) {
    console.error("Error: Missing URL or file path.");
    printHelp();
    Deno.exit(1);
  }

  let fetched: UrlFetchResult;
  try {
    if (isUrl(input)) {
      fetched = await fetchUrlContent(input, args);
    } else {
      const text = await Deno.readTextFile(input);
      const parsed = parseLocalInput(input, text);
      const isJson = input.toLowerCase().endsWith(".json");
      fetched = {
        messages: parsed.messages,
        title: parsed.title
          ? sanitizeFolderName(parsed.title)
          : deriveChatName(input),
        html: isJson ? null : text,
        ttsSegments: parsed.ttsSegments,
      };
    }
  } catch (error) {
    console.error(`Error reading input: ${errorMessage(error)}`);
    Deno.exit(1);
  }

  const {
    messages: content,
    title: apiTitle,
    html,
    ttsSegments: preparedTtsSegments,
  } = fetched;
  if (content.length === 0) {
    console.warn("No collaborative content found in the provided input.");
    return;
  }

  // Prefer a chat name from the API / document; fall back to URL-derived or
  // file-derived names so we always have a usable folder title.
  const chatName = apiTitle ??
    (html ? extractHtmlTitle(html) : null) ??
    deriveChatName(input);

  const formatted = formatToPlainText(content);

  // Text output routing:
  //  - explicit -o/--output → use that path verbatim
  //  - chat name resolved    → write to output/<chat>/<chat>.txt (and also
  //                            print to stdout when no -o was given)
  //  - no chat name, no -o  → stdout only (preserves the historical default)
  if (args.output) {
    await writeTextSafely(args.output, formatted);
    console.log(
      `Successfully extracted ${content.length} messages to ${args.output}`,
    );
  } else if (chatName) {
    const archivePath = defaultTextArchive(chatName);
    // Re-reading a saved archive (e.g. to run --tts on it) must not rewrite
    // the archive with its own re-parse — the round-trip flattens message
    // newlines, so writing back would degrade the source.
    if (!isUrl(input) && isSameFile(input, archivePath)) {
      console.error(
        `Input is the existing text archive (${archivePath}); leaving it as-is.`,
      );
      console.log(formatted);
    } else {
      await writeTextSafely(archivePath, formatted);
      console.log(
        `Saved ${content.length} messages to ${archivePath} (also printing below).`,
      );
      console.log(formatted);
    }
  } else {
    console.log(formatted);
  }

  // TTS Logic
  if (args.tts) {
    console.error("Starting TTS generation...");
    const segments = preparedTtsSegments ?? decomposeContent(content);
    const characters = [...new Set(segments.map((s) => s.speaker))];
    console.error(`Found characters: ${characters.join(", ")}`);

    const mapping = args["tts-prompt"]
      ? await promptAssignVoices(characters)
      : await autoAssignVoices(characters);

    const audio = await synthesizeStory(segments, mapping);
    const ttsOutput = args["tts-output"] ??
      (chatName ? defaultTtsArchive(chatName) : defaultTtsOutput(input));
    try {
      await Deno.writeFile(ttsOutput, audio);
      console.error(`Successfully saved TTS audio to ${ttsOutput}`);
    } catch (error) {
      console.error(`Error writing TTS audio: ${errorMessage(error)}`);
      Deno.exit(1);
    }
  }
}

/**
 * Writes `text` to `path`, creating parent directories on demand. Reports
 * errors via stderr and exits the process on failure.
 */
async function writeTextSafely(path: string, text: string): Promise<void> {
  try {
    await Deno.mkdir(joinDir(".", dirname(path)), {
      recursive: true,
    }).catch(() => {});
    await Deno.writeTextFile(path, text);
  } catch (error) {
    console.error(`Error writing to output file: ${errorMessage(error)}`);
    Deno.exit(1);
  }
}

/**
 * True when two paths refer to the same existing file. Resolves both through
 * `Deno.realPathSync` so relative/absolute spellings and case differences on
 * Windows compare equal; non-existent paths are never "the same file".
 */
function isSameFile(a: string, b: string): boolean {
  try {
    const ra = Deno.realPathSync(a);
    const rb = Deno.realPathSync(b);
    return Deno.build.os === "windows"
      ? ra.toLowerCase() === rb.toLowerCase()
      : ra === rb;
  } catch {
    return false;
  }
}

/** Returns the directory portion of a POSIX or Windows path. */
function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : ".";
}

/** Joins a directory and a relative path (POSIX-style; Deno handles both). */
function joinDir(base: string, rel: string): string {
  if (!rel) return base;
  return `${base.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;
}

/** Default text archive path under `output/<chatName>/`. */
function defaultTextArchive(chatName: string): string {
  return `${OUTPUT_ROOT}/${chatName}/${chatName}.txt`;
}

/** Default TTS archive path under `output/<chatName>/`. */
function defaultTtsArchive(chatName: string): string {
  return `${OUTPUT_ROOT}/${chatName}/${chatName}.mp3`;
}

/** Coerces an unknown thrown value to a printable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Picks a default TTS output filename when no chat name is available. */
function defaultTtsOutput(input: string): string {
  if (isUrl(input)) return "story.mp3";
  const baseName = input.split(/[\\/]/).pop() || "story";
  const nameWithoutExt = baseName.includes(".")
    ? baseName.split(".").slice(0, -1).join(".")
    : baseName;
  return `${nameWithoutExt}.mp3`;
}

/**
 * Fetches and parses content for a URL.
 *
 * Priority:
 *   1. gptgirlfriend.online chat URLs → direct API call (fastest, all messages)
 *   2. Other URLs → CDP browser rendering (handles JS-rendered content)
 *   3. Fallback → plain fetch with auto-cookie
 *
 * Site-specific API calls route through `withCookieRetry`, which caches
 * session cookies to disk, auto-launches a browser if no CDP endpoint is
 * listening, and self-repairs on 401. So once you've run the command once
 * successfully, you don't need a browser open at all anymore.
 *
 * Returns the raw HTML when the source was browser-rendered (so we can
 * extract a `<title>` for the chat folder) or `null` for API/static paths.
 */
async function fetchUrlContent(
  url: string,
  args: {
    cookie?: string;
    "no-browser": boolean;
    "browser-port": string;
    "wait-ms": string;
    "refresh-cookies": boolean;
  },
): Promise<UrlFetchResult> {
  const port = parseInt(args["browser-port"], 10);
  const waitMs = parseInt(args["wait-ms"], 10);
  const refresh = Boolean(args["refresh-cookies"]) ||
    Deno.env.get("BL_REFRESH_COOKIES") === "1";

  // 1. Site-specific API paths (fastest, all messages in one call).
  if (isGptGfChatUrl(url)) {
    try {
      console.error("Fetching via gptgirlfriend.online API...");
      const result = await withCookieRetry(
        "gptgf",
        "https://www.gptgirlfriend.online",
        port,
        async (cookie) => {
          const token = await resolveClerkToken(port);
          return await fetchGptGfMessages(url, cookie, token);
        },
        { explicit: args.cookie, forceRefresh: refresh },
      );
      return {
        messages: result.messages,
        title: sanitizeFolderName(result.title),
        html: null,
      };
    } catch (error) {
      console.warn(`Warning: API fetch failed: ${errorMessage(error)}`);
      console.warn("Falling back to browser rendering.");
    }
  }

  if (isDreamGenSessionUrl(url)) {
    try {
      console.error("Fetching via v2.dreamgen.com API...");
      const result = await withCookieRetry(
        "dreamgen",
        "https://v2.dreamgen.com",
        port,
        (cookie) => fetchDreamGenMessages(url, cookie),
        { explicit: args.cookie, forceRefresh: refresh },
      );
      return {
        messages: result.messages,
        title: result.title ? sanitizeFolderName(result.title) : null,
        html: null,
      };
    } catch (error) {
      console.warn(`Warning: API fetch failed: ${errorMessage(error)}`);
      console.warn("Falling back to browser rendering.");
    }
  }

  // 2. Browser rendering via CDP
  if (!args["no-browser"]) {
    try {
      console.error(
        `Rendering via browser (port ${port}, +${waitMs}ms wait)...`,
      );
      const html = await fetchRenderedHtml(url, port, waitMs);
      return {
        messages: parseCollaborativeContent(html),
        title: null,
        html,
      };
    } catch (error) {
      console.warn(
        `Warning: CDP rendering failed: ${errorMessage(error)}`,
      );
      console.warn("Falling back to plain fetch.");
    }
  }

  // 3. Plain fetch — only the user-supplied cookie here, since for arbitrary
  //    URLs there is no stable cache key and CDP rendering has already been
  //    tried. Users with cookie-protected non-DreamGen / non-gptgirlfriend
  //    URLs can pass --cookie explicitly, or remove --no-browser.
  const html = await fetchHtml(url, { cookie: args.cookie });
  return {
    messages: parseCollaborativeContent(html),
    title: null,
    html,
  };
}

/** Mirrors `cookies.ts`'s default Clerk wait timeout (BL_LOGIN_TIMEOUT_MS). */
const CLERK_POLL_TIMEOUT_MS = 3 * 60_000;

/**
 * Best-effort Clerk bearer token from an open gptgirlfriend.online tab.
 * Polls the page until `window.Clerk.session.getToken()` mints a JWT or
 * `CLERK_POLL_TIMEOUT_MS` elapses, giving the user a real chance to
 * complete the Clerk sign-in flow after the page loads. Returns undefined
 * on timeout (the API call may then 401 and fall back).
 */
async function resolveClerkToken(port: number): Promise<string | undefined> {
  try {
    return (
      (await pollForClerkToken(
        "gptgirlfriend",
        port,
        CLERK_POLL_TIMEOUT_MS,
      )) || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Prints the available Edge Read Aloud voices with their metadata.
 * @param locale Optional locale prefix (e.g. "en", "fr-FR") or "all".
 */
async function runListVoices(locale?: string) {
  const voices = await listVoices(locale || "en-US");
  if (voices.length === 0) {
    console.log(`No voices found for locale "${locale}".`);
    return;
  }
  console.log(
    `${voices.length} voice(s)${locale ? ` for "${locale}"` : " (en-US)"}:\n`,
  );
  for (const v of voices) {
    console.log(`  ${formatVoiceLine(v)}`);
  }
}

/**
 * Prints the help message.
 */
function printHelp() {
  console.log(`
Blue Light – Collaborative Content Extractor

Usage:
  deno run -A main.ts <url-or-file> [options]
  deno run -A main.ts list <site> [--cookie <v>] [--browser-port <n>]
  deno run -A main.ts list-voices [locale]

Input:
  <url-or-file> is an http(s) URL, an HTML file, or a plain-text transcript
  (.txt) previously saved by this tool (via --output or the automatic
  output/<chatName>/<chatName>.txt archive). All options — including --tts,
  --tts-prompt, and --tts-output — work the same for file input, so audio can
  be (re)generated from a saved archive without re-fetching the chat.

Commands:
  list <site>          Browse chats/sessions for a site (gptgf | dreamgen)
                       and print their titles + extractable URLs.
  list-voices [locale] List Edge Read Aloud voices with gender + personality
                       tags. Locale defaults to en-US; pass e.g. "en", "fr-FR",
                       or "all".

Options:
  -o, --output <file>      Save the text output to a file instead of printing
                           to stdout. When omitted, text is auto-saved to
                           output/<chatName>/<chatName>.txt and printed to
                           stdout (if a chat name can be resolved).
  -c, --cookie <value>     Cookie header string (plain fetch fallback only).
      --browser-port <n>   Chrome/Edge remote debug port (default: 9222).
      --wait-ms <n>        Extra ms to wait after page load for dynamic content
                           (default: 3000).
      --no-browser         Skip CDP rendering; use plain fetch with auto-cookie
                           instead.
      --tts                Enable Text-to-Speech generation.
      --tts-prompt         Prompt for voice assignment for each character.
      --tts-output <file>  Path to save the generated audio. When omitted and
                           a chat name is known, defaults to
                           output/<chatName>/<chatName>.mp3; otherwise
                           <input-stem>.mp3 or story.mp3 for URLs.
  -h, --help               Show this help message.

Output organization:
  Whenever a chat title can be derived (from the site API, the rendered
  page's <title>, the URL path, or the input filename), text and TTS audio
  are written under output/<chatName>/. Pass -o / --tts-output to override.

Browser rendering (default for URLs):
  Blue Light opens a real browser tab via the DevTools Protocol so that
  JavaScript-rendered content (React, Next.js, etc.) is fully loaded before
  extraction. Requires Chrome/Edge launched with:

    chrome.exe --remote-debugging-port=9222
    msedge.exe --remote-debugging-port=9222

Examples:
  deno run -A main.ts https://example.com/chat
  deno run -A main.ts https://example.com/chat --wait-ms 5000
  deno run -A main.ts https://example.com/chat --no-browser
  deno run -A main.ts ./sample.html --output results.txt
  deno run -A main.ts "output/Bree/Bree.txt" --tts --tts-prompt
  deno run -A main.ts results.txt --tts --tts-output story.mp3
  `);
}

/**
 * Checks if a string is a URL.
 */
function isUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

if (import.meta.main) {
  await main();
}
