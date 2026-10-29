/**
 * On-disk cookie cache.
 *
 * Once we successfully resolve a session cookie for a site (via CDP), we
 * persist it under the user's cache directory so subsequent runs don't need
 * a browser at all. Cookies are not given a time-based TTL here — they live
 * until either the user explicitly invalidates them or the server rejects
 * them with a 401, at which point the calling code asks us to re-resolve.
 *
 * Cache location:
 *   1. $BL_COOKIE_DIR                      (override)
 *   2. %LOCALAPPDATA%\blue-light\cookies   (Windows)
 *   3. $XDG_CACHE_HOME/blue-light/cookies  (Linux)
 *   4. ~/.cache/blue-light/cookies         (POSIX fallback)
 *
 * File layout: `<site>.json` → `{cookie, fetchedAt, source}`
 */

export interface CachedCookie {
  site: string;
  cookie: string;
  fetchedAt: string;
  source: "cdp" | "cdp-launch" | "explicit";
}

/** Returns the cache directory, creating it if missing. */
export async function cacheDir(): Promise<string> {
  const override = Deno.env.get("BL_COOKIE_DIR");
  const dir = override ? override : Deno.build.os === "windows"
    ? joinPath(
      Deno.env.get("LOCALAPPDATA") ?? userHome(),
      "blue-light",
      "cookies",
    )
    : Deno.build.os === "darwin"
    ? joinPath(userHome(), "Library", "Caches", "blue-light", "cookies")
    : joinPath(
      Deno.env.get("XDG_CACHE_HOME") ?? joinPath(userHome(), ".cache"),
      "blue-light",
      "cookies",
    );
  await ensureDir(dir);
  return dir;
}

/** Returns the file path for the cached cookie of `site`. */
export async function cookieFilePath(site: string): Promise<string> {
  return joinPath(await cacheDir(), `${sanitize(site)}.json`);
}

/** Reads the cached cookie for `site`, if any. */
export async function getCachedCookie(
  site: string,
): Promise<CachedCookie | undefined> {
  try {
    const text = await Deno.readTextFile(await cookieFilePath(site));
    const parsed = JSON.parse(text);
    if (
      typeof parsed?.cookie === "string" &&
      typeof parsed?.fetchedAt === "string" &&
      parsed.cookie.length > 0
    ) {
      return {
        site,
        cookie: parsed.cookie,
        fetchedAt: parsed.fetchedAt,
        source: parsed.source ?? "cdp",
      } satisfies CachedCookie;
    }
    return undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    // Corrupt cache file — treat as missing rather than crashing.
    console.warn(
      `Warning: cookie cache for "${site}" is unreadable; ignoring.`,
    );
    return undefined;
  }
}

/** Writes the cookie for `site` to disk. Overwrites any prior entry. */
export async function saveCookie(
  site: string,
  cookie: string,
  source: CachedCookie["source"],
): Promise<void> {
  const entry: CachedCookie = {
    site,
    cookie,
    fetchedAt: new Date().toISOString(),
    source,
  };
  await Deno.writeTextFile(
    await cookieFilePath(site),
    JSON.stringify(entry, null, 2),
  );
}

/** Removes the cached cookie for `site`. No-op if absent. */
export async function invalidateCookie(site: string): Promise<void> {
  try {
    await Deno.remove(await cookieFilePath(site));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function sanitize(site: string): string {
  return site.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function userHome(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
}

function joinPath(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/");
}

async function ensureDir(path: string): Promise<void> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isDirectory) {
      throw new Error(`Cache path is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.mkdir(path, { recursive: true });
      return;
    }
    throw error;
  }
}
