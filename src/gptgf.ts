/**
 * gptgirlfriend.online API client.
 *
 * Detects chat URLs for the site and fetches all messages directly via the
 * private REST API, which returns all messages in a single call without any
 * browser rendering or scroll simulation.
 */

import type { CollaborativeContent } from "./parser.ts";

const CHAT_URL_PATTERN =
  /^https?:\/\/(?:www\.)?gptgirlfriend\.online\/chat\/([a-zA-Z0-9]+)/;

/** Returns true if the URL is a gptgirlfriend.online chat page. */
export function isGptGfChatUrl(url: string): boolean {
  return CHAT_URL_PATTERN.test(url);
}

interface GptGfMessage {
  id: number;
  content: string;
  role: "assistant" | "user";
  createdAt: string;
}

interface GptGfChat {
  character: { name: string };
  user: { username: string };
  messages: GptGfMessage[];
}

const BASE = "https://www.gptgirlfriend.online";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Builds request headers for the gptgirlfriend.online API.
 *
 * The API authenticates with a Clerk bearer token; the session cookie alone
 * returns 401. When a token is supplied, it is sent as `Authorization: Bearer`.
 */
function authHeaders(cookie: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Cookie": cookie,
    "User-Agent": UA,
    "Accept": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** Result of `fetchGptGfMessages`: the chat's title plus its messages. */
export interface GptGfChatFetch {
  /** Display name of the character the user is chatting with. */
  title: string;
  messages: CollaborativeContent[];
}

/**
 * Fetches all messages for a gptgirlfriend.online chat URL via the site API.
 * Requires a valid session cookie string and (for the current Clerk-protected
 * API) a bearer token; see fetchClerkTokenViaCDP in ./cookies.ts.
 *
 * Returns the chat's character name alongside the messages so callers can use
 * it as a folder / file title for output paths.
 */
export async function fetchGptGfMessages(
  url: string,
  cookie: string,
  token?: string,
): Promise<GptGfChatFetch> {
  const match = url.match(CHAT_URL_PATTERN);
  if (!match) throw new Error(`Not a gptgirlfriend.online chat URL: ${url}`);
  const chatId = match[1];

  const apiUrl = `${BASE}/api/chat/${chatId}`;
  const resp = await fetch(apiUrl, { headers: authHeaders(cookie, token) });

  if (!resp.ok) {
    throw new Error(
      `API request failed: ${resp.status} ${resp.statusText}` +
        (resp.status === 401
          ? " (needs a Clerk bearer token — keep a " +
            "logged-in gptgirlfriend.online tab open for auto-token retrieval)"
          : ""),
    );
  }

  const { chat }: { chat: GptGfChat } = await resp.json();
  const charName = chat.character.name;
  const userName = chat.user.username;

  return {
    title: charName,
    messages: chat.messages.map((msg) => ({
      author: msg.role === "assistant" ? charName : userName,
      text: expandTemplates(msg.content, charName, userName),
      metadata: { role: msg.role, createdAt: msg.createdAt },
    })),
  };
}

export interface GptGfChatSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  url: string;
}

interface GptGfChatListEntry {
  id: string;
  updatedAt?: string;
  chatCount?: number;
  character?: { name?: string };
}

interface GptGfChatListResponse {
  data?: {
    chats?: GptGfChatListEntry[];
    totalCount?: number;
  };
}

/**
 * Lists the current user's gptgirlfriend.online chats via the site API.
 * Requires a valid session cookie string.
 *
 * The recent-chats view is backed by a paginated endpoint:
 *   GET /api/v2/user/chats?take=N&skip=M&includeCharacter=true&isFavorite=false
 * returning `{ data: { chats: [...], totalCount } }`. We page through it until
 * every chat has been collected.
 */
export async function listGptGfChats(
  cookie: string,
  token?: string,
): Promise<GptGfChatSummary[]> {
  const pageSize = 50;
  const out: GptGfChatSummary[] = [];
  let skip = 0;
  let total = Infinity;

  while (skip < total) {
    const url = `${BASE}/api/v2/user/chats?take=${pageSize}&skip=${skip}` +
      `&includeCharacter=true&isFavorite=false`;
    const resp = await fetch(url, { headers: authHeaders(cookie, token) });
    if (!resp.ok) {
      throw new Error(
        `Could not list gptgirlfriend chats: ${resp.status} ${resp.statusText}` +
          (resp.status === 401
            ? " (needs a Clerk bearer token — keep a " +
              "logged-in gptgirlfriend.online tab open for auto-token retrieval)"
            : ""),
      );
    }
    const { data }: GptGfChatListResponse = await resp.json();
    const chats = data?.chats ?? [];
    if (data?.totalCount !== undefined) total = data.totalCount;
    if (chats.length === 0) break;

    for (const c of chats) {
      out.push({
        id: String(c.id),
        title: c.character?.name || `Chat ${c.id}`,
        messageCount: c.chatCount ?? 0,
        updatedAt: c.updatedAt ?? "",
        url: `${BASE}/chat/${c.id}`,
      });
    }
    skip += chats.length;
  }

  return out;
}

/** Replaces {{char}} and {{user}} template variables with real names. */
function expandTemplates(
  content: string,
  charName: string,
  userName: string,
): string {
  return content
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName);
}
