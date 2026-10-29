import { assertEquals } from "@std/assert";
import {
  activePath,
  isDreamGenSessionUrl,
  looksUnauthenticated,
  parseSessionList,
  parseSessionTurns,
} from "../src/dreamgen.ts";

// A minimal synthetic DreamGen session document. Turn C1b is a regeneration of
// C1a (created later), so the active path must follow the C1b branch, and the
// abandoned C1a branch (with a deeper but older child) must be excluded.
const SESSION_DOC = [
  // root (opening) — spoken by a named character
  `{id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",parentId:void 0,` +
  `data:$R[1]={header:$R[2]={role:"writer",characters:$R[3]=[$R[4]={` +
  `stableId:"s1",label:"nyx",name:"Nyx"}]},body:$R[5]={content:$R[6]={` +
  `kind:"text",data:"\\"Welcome.\\""}}},createdAt:$R[7]=new Date("2026-01-01T00:00:00.000Z")}`,
  // C1a — first child (older), narration (empty characters)
  `{id:"c1a00000-0000-0000-0000-000000000000",parentId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",` +
  `data:$R[8]={header:$R[9]={role:"writer",characters:$R[10]=[]},` +
  `body:$R[11]={content:$R[12]={kind:"text",data:"Old branch narration."}}},` +
  `createdAt:$R[13]=new Date("2026-01-01T00:05:00.000Z")}`,
  // C1a child (deeper but part of the abandoned branch)
  `{id:"c1a0dead-0000-0000-0000-000000000000",parentId:"c1a00000-0000-0000-0000-000000000000",` +
  `data:$R[14]={header:$R[15]={role:"writer",characters:$R[16]=[]},` +
  `body:$R[17]={content:$R[18]={kind:"text",data:"Should not appear."}}},` +
  `createdAt:$R[19]=new Date("2026-01-01T00:06:00.000Z")}`,
  // C1b — regenerated child (newest overall → the active tip)
  `{id:"c1b00000-0000-0000-0000-000000000000",parentId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",` +
  `data:$R[20]={header:$R[21]={role:"writer",characters:$R[22]=[$R[23]={` +
  `stableId:"s2",label:"scott",name:"Scott"}]},body:$R[24]={content:$R[25]={` +
  `kind:"text",data:"I step inside."}}},createdAt:$R[26]=new Date("2026-01-01T00:10:00.000Z")}`,
].join(",");

Deno.test("parseSessionTurns extracts all nodes with speakers", () => {
  const turns = parseSessionTurns(SESSION_DOC);
  assertEquals(turns.length, 4);
  const root = turns.find((t) => t.parentId === null)!;
  assertEquals(root.author, "Nyx");
  assertEquals(root.text, '"Welcome."');
  const narr = turns.find((t) => t.id.startsWith("c1a00000"))!;
  assertEquals(narr.author, "Narrator");
});

Deno.test("activePath follows the most recent regeneration branch", () => {
  const path = activePath(parseSessionTurns(SESSION_DOC));
  assertEquals(path.map((t) => t.author), ["Nyx", "Scott"]);
  assertEquals(path.map((t) => t.text), ['"Welcome."', "I step inside."]);
});

Deno.test("parseSessionList extracts session summaries", () => {
  const listDoc = `{sessionId:"12345678-1234-1234-1234-123456789abc",` +
    `scenario:$R[1]={name:"My Tale   ",description:"x"},` +
    `definition:$R[2]={format:"role_play"},interactions:$R[3]={count:42},` +
    `updatedAt:$R[4]=new Date("2026-02-02T00:00:00.000Z"),archivedAt:void 0}`;
  const list = parseSessionList(listDoc);
  assertEquals(list.length, 1);
  assertEquals(list[0].title, "My Tale");
  assertEquals(list[0].gameFormat, "role-play");
  assertEquals(list[0].interactionCount, 42);
  assertEquals(
    list[0].url,
    "https://v2.dreamgen.com/app/my/session/12345678-1234-1234-1234-123456789abc",
  );
});

Deno.test("isDreamGenSessionUrl matches session URLs", () => {
  assertEquals(
    isDreamGenSessionUrl(
      "https://v2.dreamgen.com/app/my/session/12345678-1234-1234-1234-123456789abc",
    ),
    true,
  );
  assertEquals(
    isDreamGenSessionUrl("https://v2.dreamgen.com/app/scenarios"),
    false,
  );
});

Deno.test("looksUnauthenticated identifies the login shell", () => {
  assertEquals(
    looksUnauthenticated(
      `<html><body>Sign in to DreamGen.<a href="/login">Login</a></body></html>`,
    ),
    true,
  );
  assertEquals(
    looksUnauthenticated(
      `<html><body>Welcome back. Please log in to continue.</body></html>`,
    ),
    true,
  );
  assertEquals(
    looksUnauthenticated(
      `<html><body>Random marketing page, nothing here.</body></html>`,
    ),
    false,
  );
});

Deno.test("looksUnauthenticated ignores login copy when session markers are present", () => {
  const html = `<html>Sign in — but actually ` +
    `sessionId:"12345678-1234-1234-1234-123456789abc",</html>`;
  assertEquals(looksUnauthenticated(html), false);
});
