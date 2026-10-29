import { assertEquals } from "@std/assert";
import { decomposeContent, parsePlainTextContent } from "../src/parser.ts";

Deno.test("parsePlainTextContent - does not split on mid-sentence colon", () => {
  const text = [
    "Narrator: I think for a while, my world is falling apart in front of",
    "my face: there are tiny people here.",
  ].join("\n");
  const result = parsePlainTextContent(text);
  assertEquals(result.length, 1);
  assertEquals(result[0].author, "Narrator");
  assertEquals(
    result[0].text,
    "I think for a while, my world is falling apart in front of my face: there are tiny people here.",
  );
});

Deno.test("parsePlainTextContent - appends continuation lines without header", () => {
  const text = [
    "Alice: Hello there.",
    "How are you doing?",
    "Bob: Fine, thanks.",
  ].join("\n");
  const result = parsePlainTextContent(text);
  assertEquals(result.length, 2);
  assertEquals(result[0].author, "Alice");
  assertEquals(result[0].text, "Hello there. How are you doing?");
  assertEquals(result[1].author, "Bob");
});

Deno.test("parsePlainTextContent - rejects asterisk-prefixed line as header", () => {
  // Lines beginning with "*" or containing commas/periods prior to the ":"
  // must NOT be taken as headers even if a colon is present.
  const text = [
    "*She turns. The motion is abrupt, graceless...a terror simultaneously",
    "neither traumatic nor unnatural.",
    "Scott: I stare.",
  ].join("\n");
  const result = parsePlainTextContent(text);
  assertEquals(result.length, 1);
  assertEquals(result[0].author, "Scott");
  assertEquals(result[0].text.startsWith("I stare"), true);
});

Deno.test("decomposeContent - does not crash on authors with regex specials", () => {
  // Prior to fixing the author-prefix regex (Bug #1), lines beginning with "*"
  // were accidentally classified as headers. Even with such garbage headers in
  // the input, decomposeContent must not throw a SyntaxError (Bug #2).
  const content = [
    { author: "Scott", text: "I stare at the woman." },
    {
      author: "*She turns. The motion is abrupt",
      text: 'I watch the shadow. "Hello."',
    },
    { author: "Jeanette", text: "I look back." },
  ];
  let threw = false;
  let segments: ReturnType<typeof decomposeContent> = [];
  try {
    segments = decomposeContent(content);
  } catch {
    threw = true;
  }
  assertEquals(threw, false);
  assertEquals(segments.length > 0, true);
});

Deno.test("decomposeContent - inline emphasis is not its own segment", () => {
  // Inline emphasis like *present* or *up* must be stripped before the
  // asterisk splitter runs (Bug #3).
  const content = [
    { author: "Scott", text: "I *present* my findings, and *offered* them." },
  ];
  const segments = decomposeContent(content);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].speaker, "Scott");
  assertEquals(segments[0].text, "I present my findings, and offered them.");
});

Deno.test("decomposeContent - actor-direction brackets are a separate segment", () => {
  const content = [
    { author: "Scott", text: "*She turns slowly.* I watch her." },
  ];
  const segments = decomposeContent(content);
  assertEquals(segments.length, 2);
  assertEquals(segments[0].speaker, "Narrator");
  assertEquals(segments[0].text, "She turns slowly.");
  assertEquals(segments[1].speaker, "Scott");
  assertEquals(segments[1].text, "I watch her.");
});

Deno.test("decomposeContent - dialogue attributed to block's primary author", () => {
  // Even if a 3rd-person narration mentions the next speaker (Bug #4), the
  // quoted dialogue in a block must be attributed to the block's primary
  // author, not leaked from a previous block's mention.
  const content = [
    { author: "Jeanette", text: 'I looked at Scott. "Jeanette says hi."' },
  ];
  const segments = decomposeContent(content);
  assertEquals(segments.length, 2);
  assertEquals(segments[0].speaker, "Jeanette");
  assertEquals(segments[1].speaker, "Jeanette");
  assertEquals(segments[1].text, "Jeanette says hi.");
});

Deno.test("decomposeContent - quoted dialogue across blocks stays with each block", () => {
  // Stress check: Scott narration then Jeanette dialogue. Cited dialogue must
  // belong to its own block author, never re-attributed by a stray name match
  // in a prior block's narration.
  const content = [
    { author: "Scott", text: "Jeanette walks up. I watch her approach." },
    { author: "Jeanette", text: '"Hello, Scott."' },
  ];
  const segments = decomposeContent(content);
  assertEquals(segments.length, 2);
  assertEquals(segments[0].speaker, "Scott");
  assertEquals(segments[1].speaker, "Jeanette");
  assertEquals(segments[1].text, "Hello, Scott.");
});

Deno.test("decomposeContent - 1st-person narration belongs to primary author", () => {
  const content = [
    { author: "Narrator", text: "I look around." }, // unusual but valid header
  ];
  const segments = decomposeContent(content);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].speaker, "Narrator");
  assertEquals(segments[0].text, "I look around.");
});

Deno.test("stripInlineEmphasis - **bold** strips both pairs, leaves no stray *", () => {
  // Regression: previously `**him**` was processed as `*him*` (inner pair)
  // because `him` short + no-punct triggered emphasis-strip. The outer `*`
  // then survived in a gap and opened a mega-bracket that swallowed any
  // later action brackets in the same item.
  const content = [
    {
      author: "Narrator",
      text:
        "*She hands him something.* **him**, *and the fact that he is small* never changes. *But for* her.",
    },
  ];
  const segments = decomposeContent(content);
  // Expect 4 segments: 2 distinctly-bracketed action brackets + 2 narration
  // spans. The fact that we get 4 (rather than the previous single
  // mega-bracket) is the regression we are guarding.
  assertEquals(segments.length, 4);
  assertEquals(segments[0].text, "She hands him something.");
  assertEquals(segments[1].text, "him,");
  assertEquals(segments[2].text, "and the fact that he is small");
  assertEquals(segments[3].text, "never changes. But for her.");
});

Deno.test("stripInlineEmphasis - inline *word* emphasis stripped, **bold** stripped", () => {
  const content = [
    {
      author: "Scott",
      text:
        'I *present* **my** findings, and "*offered*", she said. *She turns slowly.*',
    },
  ];
  const segments = decomposeContent(content);
  // Inline *...* and **...** are flattened; *She turns slowly.* remains as an
  // action bracket; "*offered*" stays as dialogue (with the asterisks ripped
  // out from inside the quotes by the strip pass).
  const texts = segments.map((s) => s.text);
  assertEquals(texts.includes("She turns slowly."), true);
  assertEquals(texts.includes("offered"), true);
  assertEquals(texts.some((t) => t.includes("I present")), true);
  // No stray asterisk contamination: every segment should have NO "*".
  for (const s of segments) {
    assertEquals(s.text.includes("*"), false);
  }
});
