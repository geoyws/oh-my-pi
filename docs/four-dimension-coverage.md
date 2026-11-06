# Four-dimension coverage

`bun test --coverage` reports lines and functions only. Its lcov output has
`DA`/`LF`/`LH` and `FNF`/`FNH` records and no `BRDA` branch records, so branch
and statement coverage cannot be read from it. A file that Bun reports at 100%
lines may still have untaken branches; treat Bun-only branch and statement
coverage as unmeasured, not as zero and not as a pass.

`scripts/four-dimension-coverage/four-dimension.ts` measures all four
dimensions (lines, functions, branches, statements) for an explicit list of
tracked source files.

## How it measures

The scope manifest names the tracked files and the suites (a working directory
plus test globs). For every suite the runner runs the same resolved test files
twice with `bun test --parallel=1`:

1. `--coverage --coverage-reporter=lcov`: Bun's native line and function
   numbers, kept so results stay comparable with earlier Bun-only receipts.
2. `--preload scripts/four-dimension-coverage/istanbul-preload.ts`: a Bun
   runtime plugin instruments only the tracked files with
   `istanbul-lib-instrument` as they load. Each test process writes its
   counters on exit.

Istanbul counters from all suites are merged per file. Every tracked file is
seeded with its zero-hit map first, so a file that no test loads is reported
at 0%, never omitted. A tracked file containing a coverage-suppression comment
(`istanbul ignore`, `c8 ignore`, `v8 ignore`, `node:coverage ignore`) is
refused: no exclusions, pragmas or thresholds participate in the result.

Bun (JavaScriptCore basic blocks) and istanbul (statement start lines) do not
count the same lines as executable. For every file the summary lists the
lines only one tool counts as executable and the lines only one tool reports
as uncovered (`lineDiff`), so every line-count difference between the two is
enumerated rather than estimated.

## Running it

Suites need the same setup as the normal test run (`bun install`,
`bun run build:native`). Run it under the host's gate slot and container rules,
never as a bare local test runner:

```sh
bun scripts/four-dimension-coverage/four-dimension.ts \
  --scope scripts/four-dimension-coverage/renderer-scope.json \
  --out /tmp/four-dim [--root <other checkout>] [--require-full]
```

`--root` measures another checkout (for example an older commit that predates
this script) with this checkout's tooling, so two commits are compared with
the same runner, manifest and flags.

Exit codes: `0` measured; `1` `--require-full` and some dimension is below
100%; `2` a suite failed (the report is still written); `64` usage error.

## Output

Under `--out`:

| Path | Content |
| --- | --- |
| `summary.json` | HEAD, Bun version, per-suite resolved file lists, exit codes and pass/fail counts, and per file the four istanbul metrics, Bun's per-suite and union line/function numbers, and `lineDiff` |
| `summary.md` | The same per-file table in Markdown |
| `istanbul/lcov.info` | Istanbul lcov including `BRDA` branch records |
| `istanbul/coverage-final.json`, `istanbul/coverage-summary.json`, `istanbul/report.txt` | Merged istanbul map, summary and text table |
| `suites/<name>/` | `files.txt` (resolved tests), `bun.log`, `istanbul.log`, Bun's `bun/lcov.info` and raw istanbul dumps |

## Negative control

`scripts/four-dimension-coverage/four-dimension.test.ts` (run by
`bun run test:scripts`) proves detection: a fixture with an untaken `if` and an
untaken ternary arm reports 2/4 branches and missing statements, the same
fixture with both arms taken reports 100% on all four dimensions, an unloaded
tracked file reports 0%, and an ignore hint is refused.

## Scopes

`renderer-scope.json` tracks the renderer files `packages/tui/src/tui.ts`,
`packages/tui/src/prompt/composer.ts`, `packages/tui/src/components/editor.ts`,
`packages/coding-agent/src/modes/controllers/session-focus-controller.ts` and
`packages/coding-agent/src/modes/interactive-mode.ts`, measured with the full
`packages/tui` suite plus the coding-agent renderer, welcome, report and
interactive-mode tests.
