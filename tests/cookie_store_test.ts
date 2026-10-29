import { assertEquals } from "@std/assert";
import {
  cacheDir,
  getCachedCookie,
  invalidateCookie,
  saveCookie,
} from "../src/cookie_store.ts";

const ORIGINAL_ENV = Deno.env.get("BL_COOKIE_DIR") ?? "";

function withTempCacheDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = Deno.makeTempDirSync({ prefix: "blue-light-test-" });
  Deno.env.set("BL_COOKIE_DIR", dir);
  return fn().finally(() => {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // ignore
    }
    if (ORIGINAL_ENV.length === 0) Deno.env.delete("BL_COOKIE_DIR");
    else Deno.env.set("BL_COOKIE_DIR", ORIGINAL_ENV);
  });
}

Deno.test("cacheDir honors BL_COOKIE_DIR override", async () => {
  await withTempCacheDir(async () => {
    const dir = await cacheDir();
    const env = Deno.env.get("BL_COOKIE_DIR")!;
    assertEquals(dir, env);
  });
});

Deno.test("saveCookie round-trips through getCachedCookie", async () => {
  await withTempCacheDir(async () => {
    assertEquals(await getCachedCookie("dreamgen"), undefined);

    await saveCookie("dreamgen", "session=abc123; token=xyz", "cdp");

    const cached = await getCachedCookie("dreamgen");
    assertEquals(cached?.site, "dreamgen");
    assertEquals(cached?.cookie, "session=abc123; token=xyz");
    assertEquals(cached?.source, "cdp");
    assertEquals(typeof cached?.fetchedAt, "string");
  });
});

Deno.test("invalidateCookie removes an existing entry", async () => {
  await withTempCacheDir(async () => {
    await saveCookie("gptgf", "auth=foo", "cdp-launch");
    assertEquals((await getCachedCookie("gptgf"))?.cookie, "auth=foo");

    await invalidateCookie("gptgf");
    assertEquals(await getCachedCookie("gptgf"), undefined);
  });
});

Deno.test("invalidateCookie on a missing entry is a no-op", async () => {
  await withTempCacheDir(async () => {
    await invalidateCookie("nothing-here"); // must not throw
    assertEquals(await getCachedCookie("nothing-here"), undefined);
  });
});

Deno.test("getCachedCookie returns undefined for malformed entries", async () => {
  await withTempCacheDir(async () => {
    const dir = await cacheDir();
    Deno.writeTextFileSync(`${dir}/broken.json`, "not json at all");
    assertEquals(await getCachedCookie("broken"), undefined);
  });
});

Deno.test("getCachedCookie rejects entries missing required fields", async () => {
  await withTempCacheDir(async () => {
    const dir = await cacheDir();
    Deno.writeTextFileSync(
      `${dir}/incomplete.json`,
      JSON.stringify({ cookie: "", fetchedAt: "2026-01-01" }),
    );
    assertEquals(await getCachedCookie("incomplete"), undefined);
  });
});
