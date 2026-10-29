/**
 * Auto-launch Edge (preferred) or Chrome with a remote-debugging port.
 *
 * `fetchCookiesViaCDP` cannot read cookies from a browser that wasn't started
 * with `--remote-debugging-port=<port>`. When the user has a normal Edge open
 * but didn't launch it with that flag (the common case), we spawn a separate
 * Edge instance ourselves with the flag and a dedicated profile directory
 * under our cache, so we never trample on the user's normal browsing. After
 * that instance is started, the cookie cache takes over and we never need to
 * launch a browser again until the cookie is invalidated.
 */

export type BrowserKind = "edge" | "chrome";

interface BrowserCandidate {
  kind: BrowserKind;
  path: string;
}

const LAUNCH_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

/**
 * Launches a browser with --remote-debugging-port=`port`, waits for the CDP
 * /json endpoint to come up, and returns the browser kind actually launched.
 *
 * `host` is opened as the initial page so the freshly-launched Edge window
 * lands directly on the site we need cookies for — without this, the
 * browser opens to its default home page and `Network.getCookies` returns
 * an empty array, since the user hasn't visited the target origin yet.
 *
 * Targets Edge first, then Chrome. Returns undefined if neither is found or
 * the launched browser fails to expose CDP within `LAUNCH_TIMEOUT_MS`.
 */
export async function launchBrowserWithCdp(
  port: number,
  host = "about:blank",
): Promise<BrowserKind | undefined> {
  const profileDir = await browserProfileDir();
  const candidates = await findBrowserCandidates();

  for (const candidate of candidates) {
    console.error(
      `Launching ${candidate.kind} with --remote-debugging-port=${port}...`,
    );
    try {
      const cmd = new Deno.Command(candidate.path, {
        args: [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          host,
        ],
        stdout: "null",
        stderr: "null",
      });
      // Detach: let the browser outlive this CLI run.
      cmd.spawn();
    } catch (error) {
      console.warn(
        `Warning: failed to launch ${candidate.kind} at ${candidate.path}: ${
          errorMessage(error)
        }`,
      );
      continue;
    }

    if (await waitForCdp(port, LAUNCH_TIMEOUT_MS)) {
      console.error(
        `Browser is open. Log in to ${host} if prompted; Blue Light will ` +
          `pick up your session automatically.`,
      );
      return candidate.kind;
    }
    console.warn(
      `Warning: ${candidate.kind} was launched but CDP never came up on port ${port}.`,
    );
  }
  return undefined;
}

/** Polls `http://127.0.0.1:<port>/json/version` until 2xx or timeout. */
export async function waitForCdp(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) return true;
    } catch {
      // Not up yet; keep polling.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

/** Per-browser profile directory under our cache root. */
async function browserProfileDir(): Promise<string> {
  const cookieDir = Deno.env.get("BL_COOKIE_DIR");
  const cacheRoot = cookieDir
    ? cookieDir.replace(/[\\/]+$/, "") + "/.."
    : Deno.build.os === "windows"
    ? joinPath(
      Deno.env.get("LOCALAPPDATA") ?? userHome(),
      "blue-light",
    )
    : joinPath(
      Deno.env.get("XDG_CACHE_HOME") ?? joinPath(userHome(), ".cache"),
      "blue-light",
    );
  const dir = joinPath(cacheRoot, "browser-profile");
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

function userHome(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
}

function joinPath(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/");
}

/**
 * Returns ordered browser launch candidates (Edge preferred, then Chrome).
 * Looks first at well-known install paths, then falls back to a PATH search.
 */
async function findBrowserCandidates(): Promise<BrowserCandidate[]> {
  const candidates: BrowserCandidate[] = [];

  const executables = Deno.build.os === "windows"
    ? { edge: ["msedge.exe"], chrome: ["chrome.exe"] }
    : Deno.build.os === "darwin"
    ? { edge: ["Microsoft Edge"], chrome: ["Google Chrome"] }
    : {
      edge: ["microsoft-edge", "msedge"],
      chrome: ["google-chrome", "chrome"],
    };

  const knownPaths = Deno.build.os === "windows"
    ? [
      "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
    : Deno.build.os === "darwin"
    ? [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    : [];

  for (const tpl of knownPaths) {
    const resolved = expandEnv(tpl);
    if (await exists(resolved)) {
      candidates.push(classify(resolved, executables));
    }
  }

  for (const name of executables.edge) {
    const found = await which(name);
    if (found && !candidates.some((c) => c.path === found)) {
      candidates.push({ kind: "edge", path: found });
    }
  }
  for (const name of executables.chrome) {
    const found = await which(name);
    if (found && !candidates.some((c) => c.path === found)) {
      candidates.push({ kind: "chrome", path: found });
    }
  }

  return candidates;
}

function classify(path: string, execs: {
  edge: string[];
  chrome: string[];
}): BrowserCandidate {
  const lower = path.toLowerCase();
  if (execs.edge.some((e) => lower.includes(e.toLowerCase()))) {
    return { kind: "edge", path };
  }
  return { kind: "chrome", path };
}

function expandEnv(template: string): string {
  return template.replace(/%([^%]+)%/g, (_, name) => Deno.env.get(name) ?? "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH search for an executable. On Windows, appends standard PATHEXT
 * extensions if the name has none.
 */
async function which(name: string): Promise<string | undefined> {
  const pathEnv = Deno.env.get("PATH");
  if (!pathEnv) return undefined;
  const dirs = pathEnv.split(Deno.build.os === "windows" ? ";" : ":");
  const candidates = Deno.build.os === "windows" && !/\.[a-z0-9]+$/i.test(name)
    ? pathext().map((ext) => name + ext)
    : [name];
  for (const dir of dirs) {
    for (const c of candidates) {
      const full = joinPath(dir, c);
      if (await exists(full)) return full;
    }
  }
  return undefined;
}

function pathext(): string[] {
  const raw = Deno.env.get("PATHEXT") ?? ".EXE;.BAT;.CMD";
  return raw.split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
