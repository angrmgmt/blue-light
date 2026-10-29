# Spec and build

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This
includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification

Assess the task's difficulty, as underestimating it leads to poor outcomes.

- easy: Straightforward implementation, trivial bug fix or feature
- medium: Moderate complexity, some edge cases or caveats to consider
- hard: Complex logic, many caveats, architectural considerations, or high-risk
  changes

Create a technical specification for the task that is appropriate for the
complexity level.

Save to `S:\OneDrive\Documents\Repositories\blue-light\
research\spec.md`.

---

### [x] 1. Project Initialization

- Update `deno.json` with required imports (`deno-dom`, `std/cli`, `std/fs`).
- Create project directory structure (`src/`, `tests/`).

### [x] 2. Implement Core Modules

- **Scraper (`src/scraper.ts`)**: Implement `fetchHtml(url: string)` using
  Deno's native fetch.
- **Parser (`src/parser.ts`)**: Implement
  `parseCollaborativeContent(html: string)` using `deno-dom`. Focus on
  identifying repeating author/text blocks.
- **Formatter (`src/formatter.ts`)**: Implement
  `formatToPlainText(data: CollaborativeContent[])` to generate a clean `.txt`
  structure.

### [x] 3. CLI Entry Point

- **Main (`main.ts`)**: Wire everything together using `std/cli`. Support
  URL/File input and `--output` flag.

### [x] 4. Verification & Testing

- **Unit Tests (`tests/parser_test.ts`)**: Test parsing logic with sample HTML
  snippets.
- **Integration Test**: Verify the full flow from URL to `.txt` output.
- **Linting & Formatting**: Run `deno lint` and `deno fmt`.

### [x] 5. Edge TTS Research (Phase 2 Preparation)

- Create a research spike for Edge TTS WebSocket protocol implementation in
  Deno.

---

### [x] Step: Final Report

- Write a report to
  `S:\OneDrive\Documents\Repositories\blue-light\
research\final-report.md`.
