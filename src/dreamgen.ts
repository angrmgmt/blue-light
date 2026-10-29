/**
 * DreamGen (v2.dreamgen.com) API client.
 *
 * The v2 app is a TanStack Start SPA, but every session page and session-list
 * page is server-rendered with all of its data inlined as a seroval `$R[...]`
 * cross-reference stream inside the HTML document. So a plain authenticated
 * fetch (session cookie, no browser) returns everything — no client-side
 * server-function calls need to be replayed.
 *
 * Domain model:
 *   - scenario     : an authored role-play/story template
 *   - session      : a user's playthrough; its turns form a tree (regenerations
 *                    create sibling branches)
 *   - interaction  : one turn — `{ header: { role, characters }, body: { content } }`
 *   - gameFormat   : "role-play" | "story"
 *
 * The "active" conversation is the path from the tree root down to the most
 * recently created leaf (a regeneration becomes the new tip); there is no
 * explicit path pointer in the payload, so we reconstruct it from parent links
 * and `createdAt`.
 */

import type { CollaborativeContent } from "./parser.ts";

const ORIGIN = "https://v2.dreamgen.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// Session/game URL, capturing the session id (UUID).
const SESSION_URL_PATTERN =
  /^https?:\/\/(?:www\.)?v2\.dreamgen\.com\/app\/(?:my\/)?(?:session|game-sessions?)\/([0-9a-f-]{8,})/i;

// A JS/JSON string literal body (handles \" and \\ escapes).
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;

export interface DreamGenSessionSummary {
  id: string;
  title: string;
  gameFormat: string;
  interactionCount: number;
  updatedAt: string;
  url: string;
}

export interface DreamGenTurn {
  id: string;
  parentId: string | null;
  author: string;
  text: string;
  createdAt: string;
}

/** Returns true if the URL is a DreamGen v2 session/game URL. */
export function isDreamGenSessionUrl(url: string): boolean {
  return SESSION_URL_PATTERN.test(url);
}

/** Extracts the session id from a DreamGen session URL, or null. */
export function dreamGenSessionId(url: string): string | null {
  return url.match(SESSION_URL_PATTERN)?.[1] ?? null;
}

/** Unescapes a captured JS string-literal body into its real text. */
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
 * Parses all interaction (turn) nodes out of a session document.
 * A turn node is `{id:"<uuid>",parentId:(void 0|"<uuid>"),...}` — no other
 * inlined object begins with an id immediately followed by `parentId`.
 */
export function parseSessionTurns(html: string): DreamGenTurn[] {
  const headRe = /\{id:"([0-9a-f-]{36})",parentId:(void 0|"[0-9a-f-]{36}")/g;
  const nameRe = new RegExp(`name:${STR}`);
  const roleRe = /role:"([^"]*)"/;
  const contentRe = new RegExp(
    `content:\\$R\\[\\d+\\]=\\{kind:"([^"]*)",data:${STR}`,
  );
  const createdRe = /createdAt:\$R\[\d+\]=new Date\("([^"]+)"\)/;

  // Collect node start offsets so we can slice each node's own span.
  const starts: number[] = [];
  for (let m = headRe.exec(html); m; m = headRe.exec(html)) {
    starts.push(m.index);
  }
  starts.push(html.length);

  const turns: DreamGenTurn[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const seg = html.slice(starts[i], starts[i + 1]);
    const head = /^\{id:"([0-9a-f-]{36})",parentId:(void 0|"[0-9a-f-]{36}")/
      .exec(seg);
    if (!head) continue;
    const content = contentRe.exec(seg);
    if (!content || content[1] !== "text") continue; // only text turns

    // The speaker is the first character name that appears before the body.
    const bodyIdx = seg.indexOf("body:");
    const nameScope = bodyIdx > 0 ? seg.slice(0, bodyIdx) : seg;
    const name = nameRe.exec(nameScope);
    const role = roleRe.exec(nameScope);
    const author = name
      ? unescapeJsString(name[1])
      : role && role[1] === "writer"
      ? "Narrator"
      : "Narrator";

    const created = createdRe.exec(seg);
    turns.push({
      id: head[1],
      parentId: head[2] === "void 0" ? null : head[2].slice(1, -1),
      author,
      text: unescapeJsString(content[2]),
      createdAt: created ? created[1] : "",
    });
  }
  return turns;
}

/**
 * Reconstructs the active conversation path: walk up from the most recently
 * created turn to the root via parent links, then reverse to chronological
 * order.
 */
export function activePath(turns: DreamGenTurn[]): DreamGenTurn[] {
  if (turns.length === 0) return [];
  const byId = new Map(turns.map((t) => [t.id, t]));
  let tip = turns[0];
  for (const t of turns) if (t.createdAt > tip.createdAt) tip = t;

  const chain: DreamGenTurn[] = [];
  const seen = new Set<string>();
  let cur: DreamGenTurn | undefined = tip;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain.reverse();
}

/** Result of `fetchDreamGenMessages`: the session's title plus its messages. */
export interface DreamGenSessionFetch {
  /** Scenario / session display name, or null if not present in the payload. */
  title: string | null;
  messages: CollaborativeContent[];
}

/**
 * Extracts the session's display name from a DreamGen session page.
 *
 * The page embeds a `{sessionId:"<uuid>",...name:"<title>",...}` node per
 * session — same shape used by `parseSessionList`. We slice the document on
 * that head marker and look for the matching `name:` literal inside the
 * session whose id matches `sessionId`.
 */
export function parseSessionMeta(
  html: string,
  sessionId: string,
): { title: string | null } {
  const nameRe = new RegExp(`name:${STR}`);

  const head = new RegExp(
    `^\\{sessionId:"${escapeRegExp(sessionId)}"[^{}]*`,
  );
  const match = head.exec(html);
  if (!match) return { title: null };

  // Walk forward to the next top-level comma at the same brace depth so we
  // don't swallow subsequent sibling nodes.
  let depth = 0;
  let end = match.index;
  for (let i = match.index; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      end = i;
      break;
    }
  }

  const seg = html.slice(match.index, end === match.index ? html.length : end);
  const name = nameRe.exec(seg);
  return { title: name ? unescapeJsString(name[1]).trim() : null };
}

/** Escapes a string for safe inclusion in a RegExp literal body. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fetches the active conversation for a DreamGen session URL.
 * Requires a valid session cookie string.
 */
export async function fetchDreamGenMessages(
  url: string,
  cookie: string,
): Promise<DreamGenSessionFetch> {
  const sessionId = dreamGenSessionId(url);
  if (!sessionId) {
    throw new Error(`Not a DreamGen session URL: ${url}`);
  }
  const html = await fetchDreamGenPage(url, cookie);
  const path = activePath(parseSessionTurns(html));
  if (path.length === 0) {
    if (looksUnauthenticated(html)) {
      throw new Error(
        "401 unauthorized: DreamGen returned the unauthenticated page instead of this session. " +
          "Re-run so the cookie can be refreshed.",
      );
    }
    throw new Error("No interactions found in DreamGen session page.");
  }
  const { title } = parseSessionMeta(html, sessionId);
  return {
    title,
    messages: path.map((t) => ({
      author: t.author,
      text: t.text,
      metadata: t.createdAt ? { createdAt: t.createdAt } : undefined,
    })),
  };
}

/**
 * Lists the current user's DreamGen sessions (both role-play and story).
 * Requires a valid session cookie string.
 */
export async function listDreamGenSessions(
  cookie: string,
): Promise<DreamGenSessionSummary[]> {
  const pages = ["role-play", "story"];
  const seen = new Set<string>();
  const all: DreamGenSessionSummary[] = [];

  for (const fmt of pages) {
    const html = await fetchDreamGenPage(
      `${ORIGIN}/app/my/sessions/${fmt}`,
      cookie,
    );
    if (looksUnauthenticated(html)) {
      throw new Error(
        "401 unauthorized: DreamGen returned the unauthenticated page. " +
          "Re-run so the cookie can be refreshed.",
      );
    }
    for (const s of parseSessionList(html)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      all.push(s);
    }
  }

  // Most recently updated first.
  all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return all;
}

/**
 * Heuristic: an authenticated DreamGen v2 SPA document contains a
 * `sessionId:` or `interactionId:` shape; the unauthenticated shell is a
 * marketing/login page that contains "Sign in" / "Log in" but no such marker.
 * Intentionally cheap — a false positive just triggers a one-time refresh.
 */
export function looksUnauthenticated(html: string): boolean {
  const lower = html.toLowerCase();
  const hasSessionMarker = lower.includes("sessionid:") ||
    lower.includes("interactionid:");
  if (hasSessionMarker) return false;
  return /sign\s*in|log\s*in|login[^a-z]/.test(lower);
}

/**
 * Parses the session-list entries from a `/app/my/sessions/<fmt>` document.
 * Each entry is `{sessionId:"<uuid>",...name:"<title>",...
 * definition:{format:"role_play"|"story"},interactions:{count:N},updatedAt}`.
 */
export function parseSessionList(html: string): DreamGenSessionSummary[] {
  const headRe = /\{sessionId:"([0-9a-f-]{36})"/g;
  const nameRe = new RegExp(`name:${STR}`);
  const fmtRe = /definition:\$R\[\d+\]=\{format:"([a-z_]+)"\}/;
  const cntRe = /interactions:\$R\[\d+\]=\{count:(\d+)\}/;
  const updRe = /updatedAt:\$R\[\d+\]=new Date\("([^"]+)"\)/;

  const starts: number[] = [];
  for (let m = headRe.exec(html); m; m = headRe.exec(html)) {
    starts.push(m.index);
  }
  starts.push(html.length);

  const out: DreamGenSessionSummary[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const seg = html.slice(starts[i], starts[i + 1]);
    const id = /^\{sessionId:"([0-9a-f-]{36})"/.exec(seg)?.[1];
    if (!id) continue;
    const name = nameRe.exec(seg);
    const fmt = fmtRe.exec(seg);
    const cnt = cntRe.exec(seg);
    const upd = updRe.exec(seg);
    out.push({
      id,
      title: name ? unescapeJsString(name[1]).trim() : "(untitled)",
      gameFormat: fmt ? fmt[1].replace("_", "-") : "",
      interactionCount: cnt ? parseInt(cnt[1], 10) : 0,
      updatedAt: upd ? upd[1] : "",
      url: `${ORIGIN}/app/my/session/${id}`,
    });
  }
  return out;
}

/** Fetches a DreamGen page with the session cookie, throwing on non-2xx. */
async function fetchDreamGenPage(url: string, cookie: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "Cookie": cookie, "User-Agent": UA },
  });
  if (!resp.ok) {
    throw new Error(
      `DreamGen request failed: ${resp.status} ${resp.statusText}`,
    );
  }
  return await resp.text();
}
