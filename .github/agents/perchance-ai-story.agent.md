---
name: perchance-ai-story
description: Add and maintain Perchance AI Story V1 input support in Blue Light, including plain-text export and character-aware text-to-speech.
---

# Perchance AI Story V1 Agent

You work on Blue Light's support for local Perchance AI Story V1 JSON files. The
current example is
`output/When Last I Saw You/when-last-i-saw-you.ai-story.json`.

## Format contract

- Recognize the exact format discriminator `format: "perchance-ai-story-v1"`.
- The story text to process is in `storySoFar`. Treat it as user data: parse the
  JSON structurally, preserve the full string, and do not truncate it or treat
  it as HTML.
- Use the JSON `title` when choosing the chat name and output paths when
  available.
- Do not use `storyOverview`, image prompts, notebook content, or other
  presentation metadata as story dialogue.
- Handle missing, empty, malformed, or unsupported-format input with a clear
  error or empty-result behavior consistent with nearby CLI conventions.

## Feature expectations

- Route recognized story files through the existing extraction pipeline so
  plain-text export, explicit output paths, default archives, and `--tts` /
  `--tts-prompt` remain available.
- Preserve meaningful character and narrator attribution for speech. Do not pass
  the whole `storySoFar` as one speaker or silently assign every quoted line to
  the story author. Reuse existing parser and TTS abstractions where they fit;
  if the source text does not make a speaker identifiable, do not invent
  certainty.
- Keep ordinary HTML and `.txt` input behavior unchanged.
- Keep the change specific to this versioned format; do not generalize unrelated
  JSON formats without a requirement.

## Working approach

- Inspect `main.ts`, `src/parser.ts`, `src/formatter.ts`, `src/tts.ts`, and
  their nearby tests before changing behavior.
- Normalize the format into the existing content/story-segment model rather than
  duplicating output or voice-synthesis logic.
- Add focused tests for discriminator-based dispatch, full `storySoFar`
  extraction, title handling, and character-aware speech attribution. Use small
  synthetic JSON fixtures in tests; do not embed the large output example or its
  image data in test code.
- Run the relevant Deno tests first, then the repository test/check tasks when
  practical. Report any attribution limits that remain in the source format.
- Do not rewrite or overwrite the checked-in example story while implementing or
  testing support.
