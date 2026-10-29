/**
 * Cookie extraction via the Chrome DevTools Protocol (CDP), with a disk
 * cache and auto-launch fallback so callers don't need to manually start a
 * browser in debug mode.
 *
 * Resolution priority for a request to `resolveCookie(site, host, port)`:
 *   1. `explicit` cookie passed in       — used as-is, not cached
 *   2. disk cache for `site`             — used as-is, no browser needed
 *   3. CDP from a running browser        — saved to cache on success
 *   4. auto-launch Edge / Chrome + CDP   — saved to cache on success
 *
 * When CDP is reachable but returns no cookies (the user just launched a
 * fresh browser and hasn't yet logged in, or their existing browser has no
 * session for `host`), we poll for cookies for up to `BL_LOGIN_TIMEOUT_MS`
 * ms (default 60s) so the user has time to authenticate before we give up.
 *
 * Once a cookie is cached, subsequent runs typically hit step 2 and skip the
 * browser entirely. If the server later rejects with 401, callers can use
 * `resolveCookie(..., { forceRefresh: true })` to clear the cache and walk
 * the chain again.
 */

import { type BrowserKind, launchBrowserWithCdp } from "./browser_launcher.ts";
import {
  type CachedCookie,
  getCachedCookie,
  invalidateCookie,
  saveCookie,
} from "./cookie_store.ts";

interface CdpTarget {
  webSocketDebuggerUrl?: string;
}

interface CdpCookie {
  name: string;
  value: string;
}

/**
 * Fetches cookies for the given URL from a running Chrome/Edge instance via CDP.
 *
 * @param url The URL to fetch cookies for.
 * @param debugPort The remote debugging port (default: 9222).
 * @returns A cookie header string, e.g. "name1=val1; name2=val2".
 * @throws Error if the browser debug port is unreachable or times out.
 */
export async function fetchCookiesViaCDP(
  url: string,
  debugPort = 9222,
): Promise<string> {
  let targets: CdpTarget[];
  try {
    // Use 127.0.0.1 explicitly — on Windows, 'localhost' may resolve to ::1
    // (IPv6) while Edge binds only to 127.0.0.1 (IPv4), causing ECONNREFUSED.
    const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
    targets = await response.json();
  } catch {
    throw new Error(
      `Could not reach browser debug port ${debugPort}. ` +
        `Launch Chrome/Edge with: --remote-debugging-port=${debugPort}`,
    );
  }

  const target = targets.find((t) => t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(
      `No debuggable browser target found on port ${debugPort}.`,
    );
  }

  // CDP returns webSocketDebuggerUrl with 'localhost'; replace with 127.0.0.1
  // for the same reason as above.
  const wsUrl = target.webSocketDebuggerUrl.replace(
    "localhost",
    "127.0.0.1",
  );

  return await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP timed out waiting for cookies."));
    }, 5000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Network.getCookies",
        params: { urls: [url] },
      }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data as string);
      if (data.id === 1) {
        clearTimeout(timeout);
        const cookies: CdpCookie[] = data.result?.cookies ?? [];
        ws.close();
        resolve(cookies.map((c) => `${c.name}=${c.value}`).join("; "));
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error communicating with browser."));
    };
  });
}

/**
 * Retrieves a Clerk session JWT from a live tab via CDP.
 *
 * gptgirlfriend.online authenticates its API with a short-lived Clerk bearer
 * token (not just cookies), which the page mints through `window.Clerk`. This
 * evaluates `window.Clerk.session.getToken()` in an open tab on the matching
 * domain and returns the JWT.
 *
 * @param domainMatch A substring the target tab's URL must contain.
 * @param debugPort The remote debugging port (default: 9222).
 * @returns The JWT string, or null if no matching tab / no active session.
 */
export async function fetchClerkTokenViaCDP(
  domainMatch: string,
  debugPort = 9222,
): Promise<string | null> {
  let targets: Array<
    { type?: string; url?: string; webSocketDebuggerUrl?: string }
  >;
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json`);
    targets = await resp.json();
  } catch {
    throw new Error(
      `Could not reach browser debug port ${debugPort}. ` +
        `Launch Chrome/Edge with: --remote-debugging-port=${debugPort}`,
    );
  }

  const tab = targets.find(
    (t) =>
      t.type === "page" && t.url?.includes(domainMatch) &&
      t.webSocketDebuggerUrl,
  );
  if (!tab?.webSocketDebuggerUrl) return null;

  const wsUrl = tab.webSocketDebuggerUrl.replace("localhost", "127.0.0.1");

  return await new Promise<string | null>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP timed out retrieving Clerk token."));
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: "window.Clerk && window.Clerk.session " +
            "? window.Clerk.session.getToken() : null",
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data as string);
      if (data.id === 1) {
        clearTimeout(timeout);
        ws.close();
        resolve(data.result?.result?.value ?? null);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error retrieving Clerk token."));
    };
  });
}

/**
 * Public result of a cookie resolution.
 *
 * `source` tells the caller where the cookie came from, so we can surface a
 * useful status line in CLI output ("using cached cookie", "auto-launched
 * Edge", etc).
 */
export interface ResolvedCookie {
  cookie: string;
  source: "explicit" | "cache" | "cdp" | "cdp-launch";
}

/**
 * Default timeout, in milliseconds, for waiting on the user to log in to
 * `host` after we either auto-launched a browser or connected to one with
 * no cookies yet. Settable via the `BL_LOGIN_TIMEOUT_MS` env var.
 */
const DEFAULT_LOGIN_TIMEOUT_MS = 3 * 60_000;

interface ResolverDeps {
  /** Reads cookies via CDP once. Returns undefined if CDP isn't usable. */
  readCdpCookie: (host: string, port: number) => Promise<string | undefined>;
  /** Polls until a non-empty cookie appears, or times out. */
  pollCdpCookie: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<string | undefined>;
  /** True if a browser's CDP endpoint is already listening. */
  isCdpUp: (port: number) => Promise<boolean>;
  /** Launches a browser with the debug port and returns its kind. */
  launchCdp: (port: number, host: string) => Promise<BrowserKind | undefined>;
}

const DEFAULTS: ResolverDeps = {
  readCdpCookie: readCdpCookieOnce,
  pollCdpCookie: pollForNonEmptyCookie,
  isCdpUp: isPortListening,
  launchCdp: launchBrowserWithCdp,
};

// Tests override these to avoid spinning up real browsers / port listeners.
let deps: ResolverDeps = DEFAULTS;

/** @internal Test-only seam to swap in fake implementations of CDP steps. */
export function _setResolverDepsForTests(overrides: Partial<ResolverDeps>) {
  const prev = deps;
  deps = { ...prev, ...overrides };
  return () => {
    deps = prev;
  };
}

/**
 * Resolves a session cookie for `site`, drawing from the disk cache first
 * and otherwise walking the CDP chain (existing browser → auto-launched
 * browser, with a poll for the user to log in). Returns `undefined` only
 * if every option has been tried and all failed.
 *
 * @param site        Stable identifier used as the cache key (e.g. "dreamgen").
 *                    Must match across runs for caching to be effective.
 * @param host        Origin URL passed to `Network.getCookies` (e.g.
 *                    "https://v2.dreamgen.com"). Must be reachable by the
 *                    browser whose cookies we're reading.
 * @param port        Chrome / Edge remote debugging port (default 9222).
 * @param opts.explicit      A cookie string the user passed on the command
 *                           line — short-circuits every other source and is
 *                           not written to the cache.
 * @param opts.forceRefresh  When true, ignore the cache and invalidate any
 *                           existing entry after a fresh fetch.
 */
export async function resolveCookie(
  site: string,
  host: string,
  port = 9222,
  opts: { explicit?: string; forceRefresh?: boolean } = {},
): Promise<ResolvedCookie | undefined> {
  if (opts.explicit) {
    return { cookie: opts.explicit, source: "explicit" };
  }

  if (opts.forceRefresh) {
    await invalidateCookie(site);
  } else {
    const cached = await getCachedCookie(site);
    if (cached) return { cookie: cached.cookie, source: "cache" };
  }

  // Try the existing browser once — if it's already up and has cookies,
  // we don't waste time launching a new one.
  const fast = await deps.readCdpCookie(host, port);
  if (fast) {
    await saveCookie(site, fast, "cdp");
    return { cookie: fast, source: "cdp" };
  }

  // No cookies yet. Make sure some CDP endpoint is up — otherwise launch.
  let launched: BrowserKind | undefined;
  if (!(await deps.isCdpUp(port))) {
    launched = await deps.launchCdp(port, host);
    if (!launched) return undefined;
  }
  // Cookies not found: the user is most likely being asked to log in by
  // either the existing browser or the one we just spawned. Wait for them.
  const timeoutMs = loginTimeoutMs();
  console.error(
    `No cookie for ${host} yet — log in if prompted. ` +
      `Waiting up to ${Math.round(timeoutMs / 1000)}s...`,
  );
  const cookie = await deps.pollCdpCookie(host, port, timeoutMs);
  if (!cookie) return undefined;

  const source: ResolvedCookie["source"] = launched ? "cdp-launch" : "cdp";
  await saveCookie(site, cookie, source);
  return { cookie, source };
}

/** Reads `BL_LOGIN_TIMEOUT_MS` (ms), falling back to the default. */
function loginTimeoutMs(): number {
  const raw = Deno.env.get("BL_LOGIN_TIMEOUT_MS");
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_LOGIN_TIMEOUT_MS;
}

/** Returns the CDP cookie for `host`, or undefined on failure/empty. */
async function readCdpCookieOnce(
  host: string,
  port: number,
): Promise<string | undefined> {
  try {
    return (await fetchCookiesViaCDP(host, port)) || undefined;
  } catch {
    return undefined;
  }
}

/** True if the CDP HTTP endpoint is reachable within ~1 second. */
async function isPortListening(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
    return resp.ok;
  } catch {
    return false;
  }
}

const COOKIE_POLL_INTERVAL_MS = 2_000;

/**
 * Maps a Clerk-token domainMatch string (e.g. "gptgirlfriend") to a full
 * URL we can open in an auto-launched browser when there is no CDP
 * endpoint already listening. The browser lands directly on the site so
 * a Clerk-bearing tab exists for `fetchClerkTokenViaCDP` to find.
 */
const CLERK_LAUNCH_HOSTS: Record<string, string> = {
  gptgirlfriend: "https://www.gptgirlfriend.online",
};

/**
 * Polls `reader(host, port)` until it returns a non-empty string or
 * `timeoutMs` elapses. Exported so tests can drive the loop with a
 * deterministic reader; the production reader is `readCdpCookieOnce`.
 */
export async function pollUntilNonEmpty(
  reader: () => Promise<string | undefined>,
  timeoutMs: number,
  intervalMs: number = COOKIE_POLL_INTERVAL_MS,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cookie = await reader();
    if (cookie) return cookie;
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(intervalMs, deadline - Date.now()));
  }
}

/**
 * Polls `fetchCookiesViaCDP(host, port)` until it returns a non-empty cookie
 * header or `timeoutMs` elapses. The first probe is taken immediately, so
 * the typical "user is already logged in" case returns straight away.
 */
async function pollForNonEmptyCookie(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<string | undefined> {
  return await pollUntilNonEmpty(
    () => readCdpCookieOnce(host, port),
    timeoutMs,
  );
}

/**
 * Polls a gptgirlfriend.online tab for a Clerk session JWT and returns the
 * result.
 *
 * Clerk only mints a bearer token once the user has actually signed in
 * (the page's `window.Clerk.session` is undefined or unauthenticated up
 * until that point). Polling gives the user a real chance to complete the
 * sign-in flow after the page loads — without it, the cookie poll below
 * will hand back a stale, pre-auth Clerk session within a second, the API
 * will reject it with 401, and the script will fail before the user can
 * do anything about it.
 *
 * Polling itself runs inside the page via `Runtime.evaluate`, spinning on
 * a 250ms cadence until `window.Clerk.session.getToken()` mints a token.
 * That keeps detection latency to a few hundred ms after the user signs
 * in, instead of having to wait for the next outer-loop tick (which would
 * add several seconds of dead time after Clerk pops its session cookie).
 *
 * If no browser is listening on `debugPort` (e.g. because the session
 * cookie was served from the disk cache and no browser was launched
 * during cookie resolution), this helper auto-launches one pointed at
 * the matching site so a Clerk-bearing tab exists at all.
 *
 * Returns null on timeout, persistent CDP errors, when the browser cannot
 * be launched, or when no tab matches `domainMatch`.
 */
export async function pollForClerkToken(
  domainMatch: string,
  debugPort: number,
  timeoutMs: number,
): Promise<string | null> {
  if (!await isPortListening(debugPort)) {
    const host = CLERK_LAUNCH_HOSTS[domainMatch] ?? `https://${domainMatch}`;
    const launched = await launchBrowserWithCdp(debugPort, host);
    if (!launched) return null;
  }

  let targets: Array<
    { type?: string; url?: string; webSocketDebuggerUrl?: string }
  >;
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json`);
    targets = await resp.json();
  } catch {
    throw new Error(
      `Could not reach browser debug port ${debugPort}. ` +
        `Launch Chrome/Edge with: --remote-debugging-port=${debugPort}`,
    );
  }
  const tab = targets.find(
    (t) =>
      t.type === "page" && t.url?.includes(domainMatch) &&
      t.webSocketDebuggerUrl,
  );
  if (!tab?.webSocketDebuggerUrl) {
    console.error(
      `No open tab on a page matching "${domainMatch}" — open the ` +
        `site in your browser and try again.`,
    );
    return null;
  }
  const wsUrl = tab.webSocketDebuggerUrl.replace("localhost", "127.0.0.1");

  console.error(
    `No Clerk session token for ${domainMatch} yet — log in if prompted. ` +
      `Waiting up to ${Math.round(timeoutMs / 1000)}s...`,
  );

  const POLL_MS = 250;
  const expression = "(async () => {" +
    "  const deadline = Date.now() + " + timeoutMs + ";" +
    "  while (Date.now() < deadline) {" +
    "    try {" +
    "      const s = (window.Clerk && window.Clerk.session) || null;" +
    "      if (s) {" +
    "        const t = await s.getToken();" +
    "        if (t) return t;" +
    "      }" +
    "    } catch (e) {}" +
    "    await new Promise(r => setTimeout(r, " + POLL_MS + "));" +
    "  }" +
    "  return null;" +
    "})()";

  return await new Promise<string | null>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const wsTimeout = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP timed out polling Clerk token.`));
    }, timeoutMs + 5_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data as string);
      if (data.id !== 1) return;
      clearTimeout(wsTimeout);
      ws.close();
      resolve(data.result?.result?.value ?? null);
    };

    ws.onerror = () => {
      clearTimeout(wsTimeout);
      reject(new Error("WebSocket error polling Clerk token."));
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Re-export so callers can invalidate the cache programmatically. */
export async function refreshCookieCache(site: string): Promise<void> {
  await invalidateCookie(site);
}

/** Re-export the cache entry type for callers that want to display it. */
export type { CachedCookie };

/**
 * Wraps an API call with cookie resolution + self-repair on 401.
 *
 * On a 401 response (detected by the substring "401" in the thrown error
 * message), the disk cache for `site` is invalidated and the cookie is
 * re-resolved from scratch — which will, if necessary, auto-launch a browser
 * via `launchBrowserWithCdp` so the user can re-authenticate. The wrapped
 * `call` is then retried once with the fresh cookie.
 *
 * If the fresh cookie is *also* rejected with 401 (the user's actual session
 * has expired in the browser), the second 401 bubbles up unchanged so the
 * caller can present a clean session-expired message.
 */
export async function withCookieRetry<T>(
  site: string,
  host: string,
  port: number,
  call: (cookie: string) => Promise<T>,
  opts: { explicit?: string; forceRefresh?: boolean } = {},
): Promise<T> {
  const initial = await resolveCookie(site, host, port, {
    explicit: opts.explicit,
    forceRefresh: opts.forceRefresh,
  });
  if (!initial) {
    throw unableToResolveError(site, host, port);
  }
  maybeAnnounceSource(site, initial.source);
  try {
    return await call(initial.cookie);
  } catch (firstError) {
    if (!looksLikeAuthFailure(firstError)) throw firstError;

    console.warn(
      `Cookie for "${site}" was rejected (looks like the session expired); ` +
        `invalidating cache and re-resolving.`,
    );
    const refreshed = await resolveCookie(site, host, port, {
      explicit: opts.explicit,
      forceRefresh: true,
    });
    if (!refreshed) throw firstError;
    maybeAnnounceSource(site, refreshed.source);
    return await call(refreshed.cookie);
  }
}

/** Detects 401s across call sites without depending on a custom error class. */
function looksLikeAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b/.test(message) || /unauthor/i.test(message);
}

function maybeAnnounceSource(site: string, source: ResolvedCookie["source"]) {
  switch (source) {
    case "cache":
      console.error(`Using cached cookie for "${site}".`);
      return;
    case "cdp":
      console.error(`Fetched cookie for "${site}" from a running browser.`);
      return;
    case "cdp-launch":
      console.error(`Auto-launched a browser to fetch cookie for "${site}".`);
      return;
    case "explicit":
      // Don't announce — caller passed it explicitly.
      return;
  }
}

function unableToResolveError(site: string, host: string, port: number): Error {
  return new Error(
    `Timed out waiting for cookies for "${site}" at ${host}.\n` +
      `Blue Light looked for a session cookie in:\n` +
      `  1. disk cache\n` +
      `  2. existing browser on 127.0.0.1:${port}\n` +
      `  3. auto-launched Edge / Chrome\n` +
      `and then waited for the user to log in, but none appeared within ` +
      `the configured timeout.\n` +
      `Re-run after logging in to ${host}, or pass ` +
      `--cookie "<session-cookie>" to bypass the browser entirely.`,
  );
}
