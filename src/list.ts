/**
 * `list <site>` subcommand — browse a user's chats/sessions for a supported
 * site and print their titles alongside the URL you can feed back into the
 * extractor.
 *
 * Sites:
 *   gptgf     → gptgirlfriend.online chats
 *   dreamgen  → v2.dreamgen.com role-play / story sessions
 *
 * Session cookies go through `withCookieRetry`, which draws from a disk
 * cache, falls back to CDP on an existing browser, and finally auto-launches
 * Edge/Chrome itself if no browser is listening. Once a cookie is cached the
 * browser dependency effectively disappears.
 *
 * For gptgirlfriend, a short-lived Clerk JWT is also required; we fetch it
 * live from any open gptgirlfriend tab via CDP each time, including any
 * 401-triggered retry, since Clerk tokens cannot be meaningfully cached.
 */

import { pollForClerkToken, withCookieRetry } from "./cookies.ts";
import { listGptGfChats } from "./gptgf.ts";
import { listDreamGenSessions } from "./dreamgen.ts";

/** Mirrors `cookies.ts`'s default Clerk wait timeout (BL_LOGIN_TIMEOUT_MS). */
const CLERK_POLL_TIMEOUT_MS = 3 * 60_000;

interface ListOptions {
  site?: string;
  cookie?: string;
  port: number;
  refresh?: boolean;
}

const COOKIE_HOST: Record<string, string> = {
  gptgf: "https://www.gptgirlfriend.online",
  dreamgen: "https://v2.dreamgen.com",
};

export async function runListCommand(opts: ListOptions): Promise<void> {
  const site = opts.site?.toLowerCase();
  if (!site || !(site in COOKIE_HOST)) {
    console.error(
      `Usage: list <site>\n  site: ${Object.keys(COOKIE_HOST).join(" | ")}`,
    );
    Deno.exit(1);
  }

  const host = COOKIE_HOST[site];

  if (site === "gptgf") {
    const chats = await withCookieRetry(
      site,
      host,
      opts.port,
      async (cookie) => {
        const token = await resolveClerkToken(opts.port);
        return await listGptGfChats(cookie, token);
      },
      { explicit: opts.cookie, forceRefresh: opts.refresh },
    );
    printRows(
      `${chats.length} GirlfriendGPT chat(s):`,
      chats.map((c) => [
        `${c.title}${c.messageCount ? ` (${c.messageCount} msgs)` : ""}`,
        c.url,
      ]),
    );
    return;
  }

  const sessions = await withCookieRetry(
    site,
    host,
    opts.port,
    (cookie) => listDreamGenSessions(cookie),
    { explicit: opts.cookie, forceRefresh: opts.refresh },
  );
  printRows(
    `${sessions.length} DreamGen session(s):`,
    sessions.map((s) => [
      `${s.title}${s.gameFormat ? ` [${s.gameFormat}]` : ""}`,
      s.url,
    ]),
  );
}

/** Best-effort Clerk bearer token from an open gptgirlfriend.online tab. */
async function resolveClerkToken(port: number): Promise<string | undefined> {
  try {
    return (await pollForClerkToken(
      "gptgirlfriend",
      port,
      CLERK_POLL_TIMEOUT_MS,
    )) ||
      undefined;
  } catch (error) {
    console.warn(
      `Warning: could not retrieve Clerk token: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

function printRows(header: string, rows: Array<[string, string]>) {
  console.log(`\n${header}\n`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  const width = Math.min(50, Math.max(...rows.map(([t]) => t.length)));
  for (const [title, url] of rows) {
    console.log(`  ${title.padEnd(width)}  ${url}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
