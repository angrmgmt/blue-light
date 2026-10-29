/**
 * CDP-based browser rendering module.
 *
 * Opens a real browser tab via the DevTools Protocol, navigates to the URL,
 * waits for the page to finish loading dynamic content, and returns the fully
 * rendered HTML. Requires Chrome/Edge running with --remote-debugging-port.
 */

/** Minimal CDP session over a single WebSocket connection. */
class CdpSession {
  private ws: WebSocket;
  private msgId = 0;
  private pending = new Map<number, (result: unknown) => void>();
  private eventHandlers = new Map<string, (params: unknown) => void>();
  private readonly ready: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("WebSocket failed to connect"));
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg.result);
        this.pending.delete(msg.id);
      }
      if (msg.method) {
        this.eventHandlers.get(msg.method)?.(msg.params);
      }
    };
  }

  async waitReady() {
    await this.ready;
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = ++this.msgId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve) =>
      this.pending.set(id, resolve as (r: unknown) => void)
    );
  }

  on(event: string, handler: (params: unknown) => void) {
    this.eventHandlers.set(event, handler);
  }

  close() {
    this.ws.close();
  }
}

/**
 * Fetches fully rendered HTML for a URL by opening a real browser tab via CDP.
 *
 * @param url The URL to render.
 * @param debugPort The remote debugging port (default: 9222).
 * @param waitAfterLoadMs Extra ms after load event to allow async data fetches (default: 3000).
 */
export async function fetchRenderedHtml(
  url: string,
  debugPort = 9222,
  waitAfterLoadMs = 3000,
): Promise<string> {
  // Get the browser-level WebSocket URL.
  let versionData: { webSocketDebuggerUrl: string };
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    versionData = await resp.json();
  } catch {
    throw new Error(
      `Could not reach browser debug port ${debugPort}. ` +
        `Launch Chrome/Edge with: --remote-debugging-port=${debugPort}`,
    );
  }

  const browserWsUrl = versionData.webSocketDebuggerUrl.replace(
    "localhost",
    "127.0.0.1",
  );

  const browser = new CdpSession(browserWsUrl);
  await browser.waitReady();

  // Open a blank tab.
  const { targetId } = await browser.send<{ targetId: string }>(
    "Target.createTarget",
    { url: "about:blank" },
  );

  // Find the new target's WebSocket URL.
  const targetsResp = await fetch(`http://127.0.0.1:${debugPort}/json`);
  const targets = await targetsResp.json() as Array<{
    id: string;
    webSocketDebuggerUrl: string;
  }>;
  const target = targets.find((t) => t.id === targetId);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Could not find debugger URL for new tab.");
  }

  const tabWsUrl = target.webSocketDebuggerUrl.replace(
    "localhost",
    "127.0.0.1",
  );
  const tab = new CdpSession(tabWsUrl);
  await tab.waitReady();

  try {
    return await navigateAndExtract(tab, url, waitAfterLoadMs);
  } finally {
    tab.close();
    await browser.send("Target.closeTarget", { targetId }).catch(() => {});
    browser.close();
  }
}

function navigateAndExtract(
  tab: CdpSession,
  url: string,
  waitAfterLoadMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (html: string) => {
      if (settled) return;
      settled = true;
      resolve(html);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const globalTimeout = setTimeout(
      () => fail(new Error("Timed out waiting for page to render (120s).")),
      120_000,
    );

    tab.on("Page.loadEventFired", () => {
      setTimeout(async () => {
        try {
          clearTimeout(globalTimeout);
          await scrollToLoadAll(tab);
          const result = await tab.send<{ result: { value: string } }>(
            "Runtime.evaluate",
            {
              expression: "document.documentElement.outerHTML",
              returnByValue: true,
            },
          );
          finish(result.result.value);
        } catch (e) {
          fail(e as Error);
        }
      }, waitAfterLoadMs);
    });

    (async () => {
      try {
        await tab.send("Page.enable");
        await tab.send("Page.navigate", { url });
      } catch (e) {
        fail(e as Error);
      }
    })();
  });
}

/**
 * Scrolls the chat message container to the top repeatedly until no new
 * messages are loaded, handling infinite-scroll / virtualized chat UIs.
 *
 * Targets the element with both "scroll-hidden" and "overflow-auto" and
 * "flex-col" in its class — the message list container on gptgirlfriend.online.
 */
async function scrollToLoadAll(tab: CdpSession): Promise<void> {
  // JS that scrolls the container to the top and returns its current scrollHeight.
  // Returns -1 if the container isn't found.
  const scrollTopAndMeasure = `
    (function () {
      const el = document.querySelector(
        '[class*="scroll-hidden"][class*="overflow-auto"][class*="flex-col"]'
      );
      if (!el) return -1;
      el.scrollTop = 0;
      return el.scrollHeight;
    })()
  `;

  let prevHeight = -1;
  let iteration = 0;
  const maxIterations = 60;

  while (iteration++ < maxIterations) {
    const res = await tab.send<{ result: { value: number } }>(
      "Runtime.evaluate",
      { expression: scrollTopAndMeasure, returnByValue: true },
    );
    const height = res.result.value;

    if (height === -1) break; // container wasn't found — nothing to scroll
    if (height === prevHeight) break; // no new content loaded

    console.error(
      `Loading history... scroll iteration ${iteration} (height ${height}px)`,
    );
    prevHeight = height;

    // Wait for React to fetch and prepend the older messages.
    await new Promise((r) => setTimeout(r, 1500));
  }
}
