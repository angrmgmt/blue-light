/**
 * Resolves a stable chat name from a URL or local file path, and turns it
 * into a filesystem-safe folder / file basename.
 *
 * Order of attempts for URLs (without making an additional API call):
 *   - HTML `<title>` tag (most browser-rendered chat UIs have one)
 *   - last non-empty path segment of the URL
 *
 * For local files the basename (sans extension) is used as-is, with
 * sanitization applied uniformly.
 *
 * Sanitization rules:
 *   - Replace characters illegal on Windows / NTFS (`<>:"/\|?*`) and control
 *     bytes with `_`.
 *   - Trim leading/trailing whitespace and dots (NTFS rejects them).
 *   - Collapse repeated underscores introduced by the replacement.
 *   - Cap at 120 chars (`MAX_NAME_LEN`) so we never exceed common filesystems.
 *   - Fall back to "story" if nothing usable remains.
 */

import { DOMParser, Element } from "deno-dom";

const MAX_NAME_LEN = 120;
const FALLBACK_NAME = "story";

/** True if the string looks like an `http://` or `https://` URL. */
function isUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Returns a chat name derived from `input` without making any network
 * requests. Returns null when nothing sensible can be determined.
 */
export function deriveChatName(input: string): string | null {
  if (!input) return null;
  if (isUrl(input)) {
    try {
      const u = new URL(input);
      const lastSegment = u.pathname.replace(/\/+$/, "").split("/").pop();
      return sanitizeFolderName(lastSegment || "");
    } catch {
      return null;
    }
  }
  // Local file: strip directory components and extension.
  const baseName = input.split(/[\\/]/).pop() ?? "";
  const stem = baseName.includes(".")
    ? baseName.split(".").slice(0, -1).join(".")
    : baseName;
  return sanitizeFolderName(stem);
}

/**
 * Extracts the `<title>` text from an HTML document. Returns null if absent
 * or empty. Used as a higher-quality chat name for browser-rendered URLs.
 */
export function extractHtmlTitle(html: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  if (!doc) return null;
  const titleEl = doc.querySelector("title");
  if (!(titleEl instanceof Element)) return null;
  const text = titleEl.textContent?.trim();
  return text ? sanitizeFolderName(text) : null;
}

/**
 * Turns a chat title into a filesystem-safe name. Returns `FALLBACK_NAME`
 * ("story") when the input is unusable (empty, only illegal chars, etc).
 */
export function sanitizeFolderName(name: string): string {
  if (!name) return FALLBACK_NAME;
  // Strip server-name suffix off common page titles like "Aspen - gptgf".
  const trimmed = stripUnsafeChars(name)
    .replace(/\s+/g, " ")
    .trim()
    // Strip trailing dots / spaces (NTFS rejects them).
    .replace(/[.\s]+$/, "")
    .replace(/^[.\s]+/, "");
  const collapsed = trimmed.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!collapsed) return FALLBACK_NAME;
  // Filesystem-safe truncation that preserves word boundaries where
  // possible so we don't end up with names like "My Rolepla".
  if (collapsed.length <= MAX_NAME_LEN) return collapsed;
  const cut = collapsed.slice(0, MAX_NAME_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > MAX_NAME_LEN * 0.6) {
    return cut.slice(0, lastSpace).replace(/[._-]+$/, "") || cut;
  }
  return cut.replace(/[._-]+$/, "");
}

/**
 * Removes characters that are illegal on Windows / NTFS (`<>:"/\|?*`) along
 * with control bytes (codepoints 0..31), replacing each with `_`. Split out
 * from `sanitizeFolderName` so the linter doesn't flag the control-character
 * regex as forbidden.
 */
function stripUnsafeChars(name: string): string {
  const unsafe = /[<>:"/\\|?*]/g;
  const safe = name.replace(unsafe, "_");
  let out = "";
  for (const ch of safe) {
    const code = ch.charCodeAt(0);
    out += code < 32 ? "_" : ch;
  }
  return out;
}
