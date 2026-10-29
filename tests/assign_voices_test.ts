import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  parsePerchanceAiStoryV1,
  stripPerchanceSummaries,
} from "../src/parser.ts";
import { assignVoices, type Voice } from "../src/tts.ts";

function voice(name: string, gender: string): Voice {
  return {
    Name: name,
    ShortName: name,
    Gender: gender,
    Locale: "en-US",
  } as Voice;
}

const voices: Voice[] = [
  voice("en-US-AvaMultilingualNeural", "Female"),
  voice("en-US-EmmaMultilingualNeural", "Female"),
  voice("en-US-AndrewMultilingualNeural", "Male"),
  voice("en-US-BrianMultilingualNeural", "Male"),
  voice("en-US-JennyNeural", "Female"),
  voice("en-US-GuyNeural", "Male"),
];

Deno.test("assignVoices - only natural voices when available", () => {
  const m = assignVoices(["Narrator", "A", "B", "C"], voices);
  for (const v of Object.values(m)) assert(v.includes("Multilingual"));
});

Deno.test("assignVoices - falls back when no natural voices", () => {
  const m = assignVoices(["Narrator", "A"], voices.slice(4));
  assertEquals(Object.keys(m).length, 2);
});

Deno.test("assignVoices - varies with rng", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    seen.add(assignVoices(["Narrator", "A"], voices)["A"]);
  }
  assert(seen.size > 1);
  const low = assignVoices(["Narrator", "A"], voices, () => 0);
  const high = assignVoices(["Narrator", "A"], voices, () => 0.99);
  assertNotEquals(low, high);
});

Deno.test("stripPerchanceSummaries - removes summary paragraphs", () => {
  const out = stripPerchanceSummaries(
    "One.\n\nSUMMARY^1: blah blah.\n\nTwo.\n\nSUMMARY^2: more.",
  );
  assertEquals(out.trim(), "One.\n\nTwo.");
});

Deno.test("parsePerchanceAiStoryV1 - strips summaries before segmenting", () => {
  const r = parsePerchanceAiStoryV1({
    format: "perchance-ai-story-v1",
    storySoFar: "Hello.\n\nSUMMARY^1: gist.\n\nBye.",
  });
  assert(!r.messages[0].text.includes("SUMMARY"));
});
