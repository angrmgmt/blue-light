import { DOMParser, Element } from "deno-dom";

/**
 * Data model for collaborative content (chat messages).
 */
export interface CollaborativeContent {
  author: string;
  text: string;
  metadata?: Record<string, string>;
}

/**
 * A segment of a story, either dialogue or narration.
 */
export interface StorySegment {
  speaker: string;
  text: string;
}

export interface LocalInputResult {
  messages: CollaborativeContent[];
  title: string | null;
  ttsSegments?: StorySegment[];
}

const PERCHANCE_FORMAT = "perchance-ai-story-v1";

/**
 * Heuristic: does a string look like a real character / author header? Real
 * headers are short, ASCII letter-based, and have no regex metacharacters or
 * embedded sentence punctuation. A line like "I think for a while, ... : ..."
 * ends up with hundreds of chars, commas, and periods, so it fails the check.
 */
function looksLikeAuthorName(name: string): boolean {
  if (!name) return false;
  if (name.length > 50) return false;
  return /^[A-Za-z][A-Za-z' .\-]*$/.test(name);
}

/**
 * Strip asterisks around inline emphasis so they don't atomize narration.
 * Inline emphasis is *word* glued to letters, or a short phrase with no
 * internal sentence punctuation. Actor-direction brackets (*She turned...*)
 * are kept intact so the segmenter still splits them out.
 *
 * Markdown-bold pairs (**word**) are peeled off first so the outer asterisks
 * don't survive as stray delimitators when only the inner pair is removed.
 * Without this pass, `**him**` becomes `*him` (only the inner `*him*` is
 * stripped), and that stray `*` then opens a giant bracket in the output
 * that swallows every following action bracket until the next surviving `*`.
 */
function stripInlineEmphasis(text: string): string {
  const phase1 = text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  return phase1.replace(/\*([^*]+)\*/g, (full, content, offset) => {
    const before = offset > 0 ? phase1[offset - 1] : "";
    const after = offset + full.length < phase1.length
      ? phase1[offset + full.length]
      : "";
    const beforeIsWord = /\w/.test(before);
    const afterIsWord = /\w/.test(after);
    const isShortPhrase = content.length < 25 && !/[,.;:!?]/.test(content);
    const isEmphasis = beforeIsWord || afterIsWord || isShortPhrase;
    return isEmphasis ? content : full;
  });
}

/**
 * Decomposes collaborative content into story segments.
 * Identifies dialogue and narration with stable attribution.
 *
 * Speaker attribution rules:
 *   - Quoted dialogue in a block belongs to that block's primary author.
 *   - 1st-person narration (`I`, `me`, `we`, ...) belongs to the primary author.
 *   - 3rd-person narration is attributed to a generic Narrator voice.
 *
 * Cross-block attribution was removed: the previous heuristic that mutated the
 * active speaker whenever a name appeared in narration was unreliable and
 * produced misattributions like Scott being assigned Jeanette's lines.
 */
export function decomposeContent(
  content: CollaborativeContent[],
): StorySegment[] {
  const segments: StorySegment[] = [];

  // Collect character names that look like real author headers only. Names
  // with regex metacharacters or embedded sentence punctuation are filtered
  // out here so they cannot crash the per-narration regex construction.
  const allAuthors = new Set<string>();
  for (const item of content) {
    for (const a of item.author.split(/&|,|\band\b/i)) {
      const name = a.trim();
      if (looksLikeAuthorName(name)) allAuthors.add(name);
    }
  }

  for (const item of content) {
    const authorsInHeader = item.author.split(/&|,|\band\b/i).map((s) =>
      s.trim()
    );
    const primaryAuthor = looksLikeAuthorName(authorsInHeader[0])
      ? authorsInHeader[0]
      : (allAuthors.values().next().value ?? "Narrator");

    // Pre-strip inline emphasis so the asterisk regex doesn't split out
    // single words like *present* or *offered* as their own segments.
    const cleanedText = stripInlineEmphasis(item.text);

    const regex = /"([^"]+)"|“([^”]+)”|\*([^*]+)\*|([^*"“”]+)/g;
    let match;

    while ((match = regex.exec(cleanedText)) !== null) {
      const dialogue = match[1] || match[2];
      const asteriskContent = match[3];
      const other = match[4];

      if (dialogue) {
        const text = dialogue.trim();
        if (text) segments.push({ speaker: primaryAuthor, text });
        continue;
      }

      const narrationText = (asteriskContent || other || "").trim();
      if (!narrationText) continue;

      const isFirstPerson = /\b(I|me|my|mine|we|us|our|ours)\b/i.test(
        narrationText,
      );
      segments.push({
        speaker: isFirstPerson ? primaryAuthor : "Narrator",
        text: narrationText,
      });
    }
  }

  return segments;
}

/**
 * Parses collaborative content from plain text.
 *
 * Recognizes headers of the form `Author: message` where the author is a short
 * title-cased name (letters, apostrophes, periods, hyphens, spaces — up to 50
 * chars). Continuation lines (indented or not) without such a header are
 * appended to the most recent message. This avoids treating any in-text `:` as
 * a header boundary, which would otherwise split a message at commas like
 * `...front of my face: ...`.
 */
const AUTHOR_RE = /^([A-Z][A-Za-z' .\-]{0,49}):\s*(.*)$/;

export function parsePlainTextContent(text: string): CollaborativeContent[] {
  const lines = text.split(/\r?\n/);
  const results: CollaborativeContent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(AUTHOR_RE);
    if (match) {
      results.push({ author: match[1].trim(), text: match[2].trim() });
    } else if (results.length > 0) {
      results[results.length - 1].text += " " + trimmed;
    }
  }

  return results;
}

/** Parses supported local files without changing HTML or plain-text behavior. */
export function parseLocalInput(input: string, text: string): LocalInputResult {
  const lowerInput = input.toLowerCase();
  if (lowerInput.endsWith(".txt")) {
    return { messages: parsePlainTextContent(text), title: null };
  }
  if (lowerInput.endsWith(".json")) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Malformed JSON input: ${detail}`);
    }
    return parsePerchanceAiStoryV1(value);
  }
  return { messages: parseCollaborativeContent(text), title: null };
}

/** Parses a Perchance AI Story V1 document into Blue Light's content model. */
export function parsePerchanceAiStoryV1(value: unknown): LocalInputResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Unsupported JSON input; expected format "${PERCHANCE_FORMAT}".`,
    );
  }

  const document = value as Record<string, unknown>;
  if (document.format !== PERCHANCE_FORMAT) {
    throw new Error(
      `Unsupported JSON input; expected format "${PERCHANCE_FORMAT}".`,
    );
  }
  if (typeof document.storySoFar !== "string") {
    throw new Error(
      `Invalid ${PERCHANCE_FORMAT} input: storySoFar must be a string.`,
    );
  }

  const story = stripPerchanceSummaries(document.storySoFar);
  const title = typeof document.title === "string" && document.title.trim()
    ? document.title.trim()
    : null;
  return {
    messages: story.trim() ? [{ author: "Narrator", text: story }] : [],
    title,
    ttsSegments: decomposePerchanceStory(story),
  };
}

/** Removes Perchance's "SUMMARY^N: ..." context-reminder paragraphs. */
export function stripPerchanceSummaries(story: string): string {
  return story
    .replace(/^[ \t]*SUMMARY\^\d+:.*(?:\r?\n|$)/gm, "")
    .replace(/(\r?\n){3,}/g, "\n\n");
}

/** Splits prose and dialogue, attributing speech only when a name is explicit. */
export function decomposePerchanceStory(story: string): StorySegment[] {
  const segments: StorySegment[] = [];
  const quotePattern = /"([^"]+)"|“([^”]+)”/g;
  const speechVerb =
    "(?:said|asked|replied|answered|whispered|shouted|murmured|called|exclaimed|added|told)";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = quotePattern.exec(story)) !== null) {
    const before = story.slice(cursor, match.index);
    const after = story.slice(quotePattern.lastIndex);
    const beforeTag = before.match(
      new RegExp(
        `(?:^|[\\s,;.!?])([A-Z][A-Za-z'’-]*(?:\\s+[A-Z][A-Za-z'’-]*)?)\\s+${speechVerb}\\s*[,;:]?\\s*$`,
      ),
    );
    const afterTag = after.match(
      new RegExp(
        `^\\s*[,;:]?\\s*([A-Z][A-Za-z'’-]*(?:\\s+[A-Z][A-Za-z'’-]*)?)\\s+${speechVerb}\\b`,
      ),
    );

    if (before.trim()) {
      segments.push({ speaker: "Narrator", text: before.trim() });
    }
    segments.push({
      speaker: beforeTag?.[1] ?? afterTag?.[1] ?? "Narrator",
      text: (match[1] ?? match[2]).trim(),
    });
    cursor = quotePattern.lastIndex;
  }

  const remainder = story.slice(cursor).trim();
  if (remainder) segments.push({ speaker: "Narrator", text: remainder });
  return segments;
}

/**
 * Parses collaborative content (chat-style) from HTML.
 *
 * @param html The HTML content to parse.
 * @returns An array of extracted collaborative content.
 */
export function parseCollaborativeContent(
  html: string,
): CollaborativeContent[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  if (!doc) return [];

  const results: CollaborativeContent[] = [];

  // Strategy 1: gptgirlfriend.online
  // Message bubbles carry the class "word-wrap-break".
  // User bubbles also have "bg-indigo-500"; AI bubbles have "dark:bg-zinc-800".
  // The author's name is in the nearest avatar img alt text three levels up.
  const bubbles = doc.querySelectorAll('[class*="word-wrap-break"]');
  if (bubbles.length > 0) {
    results.push(...parseGptGirlfriendBubbles(bubbles));
  }

  // Strategy 2: Generic fallback for other chat UIs.
  const potentialMessages = doc.querySelectorAll(
    '[class*="message"], [class*="chat-bubble"], [class*="ChatBubble"]',
  );
  for (const msg of potentialMessages) {
    if (!(msg instanceof Element)) continue;
    const author = findAuthor(msg);
    const text = findText(msg);
    if (author && text) results.push({ author, text });
  }

  // Strategy 3: Next.js inline RSC payloads (e.g. God Simulator). Chat-shaped
  // objects are pushed into `self.__next_f` as `{name, text}` or
  // `{name, description}` JSON.
  for (const script of doc.querySelectorAll("script")) {
    if (!(script instanceof Element)) continue;
    const text = script.textContent ?? "";
    if (!text.includes("__next_f")) continue;
    results.push(...parseNextJsRSC(text));
  }

  return results;
}

/**
 * Parses gptgirlfriend.online-style message bubbles.
 * DOM path from bubble: p → justify-wrapper → content-col → group/message
 */
function parseGptGirlfriendBubbles(
  bubbles: Iterable<Element>,
): CollaborativeContent[] {
  const results: CollaborativeContent[] = [];

  for (const node of bubbles) {
    const cls = node.getAttribute("class") ?? "";
    const isUser = cls.includes("bg-indigo-500");

    const text = node.textContent?.trim();
    if (!text) continue;

    // Walk up 3 levels to the group/message container div.
    const container = node.parentElement?.parentElement?.parentElement ?? null;

    // Avatar alt text is e.g. "Bree's avatar" → author = "Bree"
    const avatarImg = container?.querySelector('img[alt*="avatar"]');
    const altText = avatarImg?.getAttribute("alt") ?? "";
    const author = altText.replace(/'s avatar$/i, "").trim() ||
      (isUser ? "User" : "AI");

    results.push({ author, text });
  }

  return results;
}

/**
 * Heuristically finds the author name within a message element.
 */
function findAuthor(el: Element): string | null {
  const authorEl = el.querySelector(
    '[class*="author"], [class*="name"], [class*="sender"], strong, b',
  );
  if (authorEl) return authorEl.textContent.trim();
  const firstChild = el.firstElementChild;
  if (firstChild && firstChild.textContent.length < 30) {
    return firstChild.textContent.trim();
  }
  return null;
}

/**
 * Heuristically finds the message text within a message element.
 */
function findText(el: Element): string | null {
  const textEl = el.querySelector(
    '[class*="text"], [class*="content"], [class*="body"], [class*="message-text"], p',
  );
  if (textEl) return textEl.textContent.trim();
  let longestText = "";
  for (const child of el.children) {
    const t = child.textContent.trim();
    if (t.length > longestText.length) longestText = t;
  }
  return longestText || null;
}

/**
 * Unescapes a JS string-literal body (the captured group between double quotes,
 * still containing `\"`, `\\`, `\n`, etc.) into the real string value.
 */
function unescapeJsString(body: string): string {
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return body
      .replace(
        /\\u([0-9a-fA-F]{4})/g,
        (_, h) => String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
  }
}

/**
 * Extracts chat-shaped objects from a Next.js RSC inline script.
 * Recognises JSON-like `{"name":"...","text":"..."}` (and the `description`
 * variant) inlined via `self.__next_f.push(...)`.
 */
function parseNextJsRSC(scriptText: string): CollaborativeContent[] {
  const results: CollaborativeContent[] = [];
  const objRe =
    /\{"name":"((?:[^"\\]|\\.)*)","(text|description)":"((?:[^"\\]|\\.)*)"\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(scriptText)) !== null) {
    const name = unescapeJsString(m[1]);
    const value = unescapeJsString(m[3]);
    if (m[2] === "description") {
      results.push({
        author: name,
        text: value,
        metadata: { type: "description" },
      });
    } else {
      results.push({ author: name, text: value });
    }
  }
  return results;
}
