import { assertEquals, assertThrows } from "@std/assert";
import {
  decomposePerchanceStory,
  parseCollaborativeContent,
  parseLocalInput,
} from "../src/parser.ts";

Deno.test("parseLocalInput - Perchance V1 dispatch preserves story and title", () => {
  const story =
    'Opening paragraph.\n\nAlice said, "A complete line of dialogue."\nEnding paragraph.';
  const parsed = parseLocalInput(
    "story.ai-story.json",
    JSON.stringify({
      format: "perchance-ai-story-v1",
      title: "  A Story: At Home?  ",
      storySoFar: story,
      storyOverview: "Metadata is not dialogue.",
      imageGuidance: "More metadata.",
    }),
  );

  assertEquals(parsed.title, "A Story: At Home?");
  assertEquals(parsed.messages, [{ author: "Narrator", text: story }]);
  assertEquals(parsed.messages[0].text, story);
  assertEquals(parsed.ttsSegments?.map((segment) => segment.speaker), [
    "Narrator",
    "Alice",
    "Narrator",
  ]);
});

Deno.test("parseLocalInput - preserves plain-text and HTML dispatch", () => {
  assertEquals(parseLocalInput("chat.txt", "Alice: Hello").messages, [
    { author: "Alice", text: "Hello" },
  ]);
  assertEquals(
    parseLocalInput(
      "chat.html",
      '<div class="message"><b>Alice</b><p>Hello</p></div>',
    )
      .messages,
    [{ author: "Alice", text: "Hello" }],
  );
});

Deno.test("parseLocalInput - reports malformed, unsupported, and incomplete JSON", () => {
  assertThrows(
    () => parseLocalInput("story.json", "{"),
    Error,
    "Malformed JSON input",
  );
  assertThrows(
    () => parseLocalInput("story.json", '{"format":"other"}'),
    Error,
    "Unsupported JSON input",
  );
  assertThrows(
    () => parseLocalInput("story.json", '{"format":"perchance-ai-story-v1"}'),
    Error,
    "storySoFar must be a string",
  );
});

Deno.test("decomposePerchanceStory - attributes only explicitly named speakers", () => {
  const segments = decomposePerchanceStory(
    'Alice said, "Hello." “I am not sure who said this.”',
  );
  assertEquals(segments, [
    { speaker: "Narrator", text: "Alice said," },
    { speaker: "Alice", text: "Hello." },
    { speaker: "Narrator", text: "I am not sure who said this." },
  ]);
});

Deno.test("parseCollaborativeContent - simple chat bubble structure", () => {
  const html = `
    <div class="message">
      <span class="author">Alice</span>
      <div class="content">Hello world!</div>
    </div>
    <div class="message">
      <span class="author">Bob</span>
      <div class="content">Hi Alice!</div>
    </div>
  `;
  const result = parseCollaborativeContent(html);
  assertEquals(result, [
    { author: "Alice", text: "Hello world!" },
    { author: "Bob", text: "Hi Alice!" },
  ]);
});

Deno.test("parseCollaborativeContent - Next.js RSC payload", () => {
  const html = `
    <script>
      self.__next_f.push([1, "some data"]);
      self.__next_f.push([1, '{"name":"Alice","text":"Hello from RSC"}']);
      self.__next_f.push([1, '{"name":"Bob","text":"Hi from RSC"}']);
    </script>
  `;
  const result = parseCollaborativeContent(html);
  assertEquals(result, [
    { author: "Alice", text: "Hello from RSC" },
    { author: "Bob", text: "Hi from RSC" },
  ]);
});

Deno.test("parseCollaborativeContent - God Simulator style pattern", () => {
  const html = `
    <script>
      self.__next_f.push([1, '{"name":"God","description":"The creator of the universe"}']);
    </script>
  `;
  const result = parseCollaborativeContent(html);
  assertEquals(result, [
    {
      author: "God",
      text: "The creator of the universe",
      metadata: { type: "description" },
    },
  ]);
});

Deno.test("parseCollaborativeContent - mixed content", () => {
  const html = `
    <div class="chat-bubble">
      <strong class="name">User</strong>
      <p class="body">What is the meaning of life?</p>
    </div>
    <script>
      self.__next_f.push([1, '{"name":"AI","text":"42"}']);
    </script>
  `;
  const result = parseCollaborativeContent(html);
  // Note: Current implementation might return both if they exist
  assertEquals(result, [
    { author: "User", text: "What is the meaning of life?" },
    { author: "AI", text: "42" },
  ]);
});

Deno.test("parseCollaborativeContent - empty input", () => {
  const result = parseCollaborativeContent("");
  assertEquals(result, []);
});

Deno.test("parseCollaborativeContent - no matches", () => {
  const html = "<div>Just some random text</div>";
  const result = parseCollaborativeContent(html);
  assertEquals(result, []);
});
