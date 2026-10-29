import { assertEquals } from "@std/assert";
import type { StorySegment } from "../src/parser.ts";
import { synthesizeStory } from "../src/tts.ts";

/**
 * Stubbed synthesizer that records how many times each (text, voice) pair
 * was attempted, and returns either resolved bytes or a thrown error
 * on a per-attempt schedule.
 */
function makeStub(
  schedule: Array<
    { kind: "ok"; bytes: Uint8Array } | { kind: "throw"; message: string } | {
      kind: "empty";
    }
  >,
): {
  fn: (text: string, voice: string) => Promise<Uint8Array>;
  attempts: number;
} {
  const state = { idx: 0, attempts: 0 };
  return {
    fn: (_text: string, _voice: string) => {
      state.attempts++;
      const step = schedule[state.idx++];
      if (!step) return Promise.reject(new Error("schedule exhausted"));
      if (step.kind === "ok") return Promise.resolve(step.bytes);
      if (step.kind === "empty") return Promise.resolve(new Uint8Array(0));
      return Promise.reject(new Error(step.message));
    },
    get attempts() {
      return state.attempts;
    },
  } as {
    fn: (text: string, voice: string) => Promise<Uint8Array>;
    attempts: number;
  };
}

const segments = (count: number): StorySegment[] =>
  Array.from({ length: count }, (_, i) => ({
    speaker: "Narrator",
    text: `segment ${i}`,
  }));

Deno.test("synthesizeStory - retries on failed attempts", async () => {
  const stub = makeStub([
    { kind: "throw", message: "Synthesis timed out after 30000ms" },
    { kind: "throw", message: "Synthesis timed out after 30000ms" },
    { kind: "ok", bytes: new Uint8Array([1, 2, 3]) },
  ]);
  const out = await synthesizeStory(
    segments(1),
    { Narrator: "voice-a" },
    1,
    stub.fn,
  );
  assertEquals(stub.attempts, 3);
  assertEquals(out, new Uint8Array([1, 2, 3]));
});

Deno.test("synthesizeStory - gives up after MAX_ATTEMPTS", async () => {
  // Two segments, each retried up to MAX_ATTEMPTS (3) times => 6 total calls.
  const stub = makeStub(
    Array.from({ length: 6 }, () => ({
      kind: "throw",
      message: "boom",
    })),
  );
  const out = await synthesizeStory(
    segments(2),
    { Narrator: "voice-a" },
    1,
    stub.fn,
  );
  assertEquals(stub.attempts, 6);
  // Both segments failed; the output should be empty (zero bytes merged).
  assertEquals(out.length, 0);
});

Deno.test("synthesizeStory - retries on empty buffer too", async () => {
  const stub = makeStub([
    { kind: "empty" },
    { kind: "ok", bytes: new Uint8Array([42]) },
  ]);
  const out = await synthesizeStory(
    segments(1),
    { Narrator: "voice-a" },
    1,
    stub.fn,
  );
  assertEquals(stub.attempts, 2);
  assertEquals(out, new Uint8Array([42]));
});

Deno.test("synthesizeStory - skips without retries when no voice is mapped", async () => {
  // Mapping has no Narrator fallback, so the speaker "Nobody" goes through the
  // "no voice" branch which records an empty placeholder WITHOUT calling
  // synthesize.
  const stub = makeStub(
    Array.from({ length: 6 }, () => ({ kind: "throw", message: "boom" })),
  );
  const out = await synthesizeStory(
    [{ speaker: "Nobody", text: "..." }],
    { Other: "voice-x" },
    1,
    stub.fn,
  );
  assertEquals(stub.attempts, 0);
  assertEquals(out.length, 0);
});

Deno.test("synthesizeStory - preserves segment ordering across retries", async () => {
  // Seg 0 succeeds on first try.
  // Seg 1 fails twice then succeeds (occupies the worker across retries).
  // Seg 2 succeeds first try.
  // Concurrency 1 => queue is processed strictly in order: 0, 1, 2.
  const stub = makeStub([
    { kind: "ok", bytes: new Uint8Array([1, 1, 1]) }, // seg 0 attempt 1
    { kind: "throw", message: "fail" }, // seg 1 attempt 1
    { kind: "throw", message: "fail" }, // seg 1 attempt 2
    { kind: "ok", bytes: new Uint8Array([2]) }, // seg 1 attempt 3
    { kind: "ok", bytes: new Uint8Array([3]) }, // seg 2 attempt 1
  ]);
  const out = await synthesizeStory(
    segments(3),
    { Narrator: "voice-a" },
    1,
    stub.fn,
  );
  assertEquals(stub.attempts, 5);
  assertEquals(out, new Uint8Array([1, 1, 1, 2, 3]));
});
