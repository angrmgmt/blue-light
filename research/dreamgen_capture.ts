/**
 * DreamGen API capture spike.
 *
 * Attaches to a running Edge/Chrome (launched with --remote-debugging-port),
 * opens a new tab (same profile → already logged in), navigates to a DreamGen
 * session URL, and records every `/_serverFn/<id>` request + response body.
 *
 * Usage:
 *   deno run -A research/dreamgen_capture.ts <session-url> [--port 9222]
 *
 * Output: prints each captured serverFn call (id, request payload, response
 * preview) so we can identify which function returns a session's messages.
 */

interface CdpMsg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

class Cdp {
  private ws: WebSocket;
  private msgId = 0;
  private pending = new Map<number, (r: unknown) => void>();
  private handlers = new Map<string, (p: unknown) => void>();
  ready: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("CDP WebSocket failed"));
    });
    this.ws.onmessage = (ev) => {
      const msg: CdpMsg = JSON.parse(ev.data as string);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg.result);
        this.pending.delete(msg.id);
      }
      if (msg.method) this.handlers.get(msg.method)?.(msg.params);
    };
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = ++this.msgId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((res) => {
      this.pending.set(id, (r: unknown) => res(r as T));
    });
  }

  on(event: string, handler: (p: unknown) => void) {
    this.handlers.set(event, handler);
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  const args = Deno.args.filter((a) => !a.startsWith("--"));
  const url = args[0];
  const portFlag = Deno.args.indexOf("--port");
  const port = portFlag >= 0 ? Number(Deno.args[portFlag + 1]) : 9222;

  if (!url) {
    console.error(
      "Usage: deno run -A research/dreamgen_capture.ts <session-url> [--port 9222]",
    );
    Deno.exit(1);
  }

  const version = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  const browserWs = version.webSocketDebuggerUrl.replace(
    "localhost",
    "127.0.0.1",
  );
  const browser = new Cdp(browserWs);
  await browser.ready;

  const { targetId } = await browser.send<{ targetId: string }>(
    "Target.createTarget",
    { url: "about:blank" },
  );

  const targets = await (await fetch(`http://127.0.0.1:${port}/json`))
    .json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((t) => t.id === targetId)!;
  const tab = new Cdp(
    target.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"),
  );
  await tab.ready;

  // Record request metadata keyed by requestId, then pair with responses.
  const reqBody = new Map<string, string>();
  const reqUrl = new Map<string, string>();
  const reqType = new Map<string, string>();
  const captured: Array<
    { url: string; type: string; req: string; resp: string }
  > = [];

  // Capture documents, XHR and fetch — this is where TanStack Start streams
  // its router-loader data (inline in the document) or client server-fn calls.
  const WANT = new Set(["Document", "XHR", "Fetch"]);

  await tab.send("Network.enable");

  tab.on("Network.requestWillBeSent", (p) => {
    const params = p as {
      requestId: string;
      request?: { url?: string; postData?: string };
      type?: string;
    };
    reqUrl.set(params.requestId, params.request?.url ?? "");
    reqType.set(params.requestId, params.type ?? "");
    if (params.request?.postData) {
      reqBody.set(params.requestId, params.request.postData);
    }
  });

  tab.on("Network.loadingFinished", async (p) => {
    const params = p as { requestId: string };
    const u = reqUrl.get(params.requestId) ?? "";
    const type = reqType.get(params.requestId) ?? "";
    if (!WANT.has(type)) return;
    try {
      const body = await tab.send<{ body: string; base64Encoded: boolean }>(
        "Network.getResponseBody",
        { requestId: params.requestId },
      );
      const text = body.base64Encoded ? atob(body.body) : body.body;
      captured.push({
        url: u,
        type,
        req: reqBody.get(params.requestId) ?? "(no body)",
        resp: text,
      });
      console.error(
        `captured ${type} ${u.slice(0, 70)} (${text.length} bytes)`,
      );
    } catch (e) {
      console.error(`could not read body for ${u}: ${(e as Error).message}`);
    }
  });

  await tab.send("Page.enable");
  await tab.send("Page.navigate", { url });

  // Give the SPA time to hydrate, stream, and fire any data calls.
  await new Promise((r) => setTimeout(r, 14000));

  const outPath = new URL("./dreamgen_capture_output.json", import.meta.url);
  await Deno.writeTextFile(
    outPath.pathname.replace(/^\//, ""),
    JSON.stringify(captured, null, 2),
  );
  console.error(`\nWrote ${captured.length} calls to ${outPath.pathname}`);

  tab.close();
  await browser.send("Target.closeTarget", { targetId }).catch(() => {});
  browser.close();
}

if (import.meta.main) main();
