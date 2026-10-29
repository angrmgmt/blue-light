# Agent Instructions

Avoid third-party dependencies when the needed functionality can be implemented
in 100 lines of code or fewer (counting non-blank lines in the new module). Use
a third-party dependency when reimplementing it would exceed 100 lines or would
be error-prone (for example, cryptography, date/time zone handling, or parsing
standards), even if only one or two of its functions are needed. When adding a
third-party dependency, prefer a JSR package (`jsr:@scope/name`) and add it with
`deno add`. If no JSR package exists, use an `npm:` specifier. Declare the
import in the imports map of `deno.json` with an explicit version. If
`deno.json` does not exist or `deno add` fails, stop, report the exact error
output, and do not edit import maps by hand. There is a difference between
avoiding reinventing the wheel and buying a car so you can have the hubcaps.
Deno is very capable. Do not use dependency injection containers or frameworks.
Import Deno standard library and built-in APIs directly in the module that uses
them. The results are leaner, easier to maintain, and typically feel better
overall.

## Housekeeping

Always run

```shell
deno fmt --check
deno lint
deno check **/*.ts
deno task test
```

after edits to prevent regressions.

If any of these commands fail, fix the reported issues in the files you changed
and rerun the failed command. If a failure is unrelated to your edits or cannot
be fixed, stop and report the exact error output instead of continuing.

If `deno fmt --check` reports formatting differences, run `deno fmt` to apply
them, then rerun `deno fmt --check`. If the `**/*.ts` glob does not expand, run
`deno check` on the TypeScript files directly, for example
`deno check $(find . -name '*.ts' -not -path './node_modules/*')`.

## Test Authoring

For each new function or feature, write at least one smoke test that checks it
runs without error for one representative valid input that exercises the
function's main code path (not an empty, zero, or error case) and asserts the
expected result: the return value if the function returns one, or the observable
side effect (e.g., file written, state changed) if it does not. Add more
detailed unit tests only when the user asks for them.

## Version Control

Synchronization with remote repo to be handled exclusively by Owner. Create a
local commit only after all housekeeping commands pass for a completed task.
Each commit message must follow the Conventional Commits format, for example:
`feat(parser): add token scanner`.
