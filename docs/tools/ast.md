# ast

> Structural code search (`mode: "search"`) and preview-first structural rewrites (`mode: "edit"`) over source files via native ast-grep.

## Source
- Entry: `packages/coding-agent/src/tools/ast.ts` (`AstTool`, `astSchema`, `resolveAstModes`)
- Mode runners:
  - `packages/coding-agent/src/tools/ast-grep.ts` — `runAstSearch(...)`
  - `packages/coding-agent/src/tools/ast-edit.ts` — `runAstEdit(...)`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ast.md`
- Key collaborators:
  - `crates/pi-natives/src/ast.rs` — native scan, parse, match, rewrite planning and file mutation (`astGrep` / `astEdit` bindings)
  - `crates/pi-ast/src/language/mod.rs` — language aliases and extension inference used by the native wrapper.
  - `packages/coding-agent/src/tools/path-utils.ts` — path/glob parsing and multi-path resolution
  - `packages/coding-agent/src/tools/resolve.ts` — edit preview/apply queueing
  - `packages/tui/src/render/render-utils.ts` — parse-error dedupe and display caps
  - `packages/coding-agent/src/tools/match-line-format.ts` — hashline match rendering
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline vs line-number output mode
  - `packages/hashline/src/format.ts` — stable hashline header formatting for edit preview anchors
  - `packages/tui/src/tools/ast.ts` — `astToolRenderer`
  - `packages/natives/native/index.d.ts` — JS-visible native binding contract

## Modes and gating

| Mode | Available when | Approval tier |
| --- | --- | --- |
| `search` | setting `astGrep.enabled` (default `false`) | `read` |
| `edit` | setting `astEdit.enabled` (default `true`) **and** the session grants `edit` (`session.isToolActive("edit")`, default true) | `read` only when every `;`/`,`/whitespace-delimited `path` entry is an internal URL; otherwise `write` |

- `resolveAstModes(session)` computes the usable modes; `AstTool.createIf(session)` returns `null` when neither is available. Read-only tool sets (no `edit` grant) therefore only get `search`.
- The tool is `discoverable` (not in the essential set) and `strict`.
- `deferrable` is true only when `edit` mode is available; that is what makes `createTools(...)` / `createAgentSession(...)` keep `write` registered for the `xd://resolve` / `xd://reject` devices.
- The registry allows `ast` when either setting is on. Non-restricted explicit tool lists auto-include `ast` when they hold `grep` (with `astGrep.enabled`) or `edit` (with `astEdit.enabled`).
- The advertised schema is narrowed per session: with only one mode usable the model sees just that variant.

## Inputs

### `mode: "search"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | `"search"` | Yes | |
| `pat` | `string` | Yes | Single AST pattern. Trimmed; empty strings are rejected. |
| `path` | `string` | No | One file, directory, glob, internal URL with a backing file, or fetched web URL — or several as a semicolon-delimited list (`"src; tests"`). Omitted or empty defaults to `.`. Empty entries and internal-URL globs are rejected. |
| `lang` | `string` | No | Force the language instead of per-file extension inference. |
| `skip` | `number` | No | Match offset. Defaults to `0`, then `Math.floor(...)`; negatives and non-finite values fail. |

### `mode: "edit"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | `"edit"` | Yes | |
| `ops` | `{ pat: string; out: string }[]` | Yes (min 1) | Rewrite rules. `pat` must be non-empty; duplicate `pat` values fail before native execution. Empty `out` deletes the matched node. |
| `path` | `string` | Yes | One file, directory, glob, or path-backed internal URL — or several as a semicolon-delimited list (`"src/a.ts; src/b.ts"`). Internal-URL globs are rejected; fetched external URLs are read-only and cannot be rewritten. |

Sending a field from the other mode is a `ToolError` (e.g. `pat`, `lang`, `skip` with `mode: "edit"` — "`pat`, `lang`, and `skip` are search-only; ...").

### Pattern grammar
- `$NAME` — capture one AST node.
- `$_` — match one AST node without binding.
- `$$$NAME` — capture zero or more AST nodes; ast-grep stops lazily at the next satisfiable node.
- `$$$` — match zero or more AST nodes without binding.
- Metavariable names must be uppercase and must stand for whole AST nodes, not partial tokens or string fragments.
- Reusing the same metavariable requires identical code at each occurrence.
- Patterns must parse as one valid AST node for the inferred target language.
- Edit mode: captures from `pat` are substituted into `out`; each rewrite is a 1:1 structural substitution — one capture cannot expand into multiple sibling nodes unless the grammar permits that expansion at that position.
- Supported canonical languages come from `SupportLang::all_langs()` in `crates/pi-ast/src/language/mod.rs`: `astro`, `bash`, `c`, `cmake`, `cpp`, `csharp`, `dart`, `clojure`, `css`, `diff`, `dockerfile`, `emacs-lisp`, `elixir`, `erlang`, `fortran`, `go`, `graphql`, `haskell`, `hcl`, `html`, `ini`, `java`, `javascript`, `json`, `just`, `julia`, `kotlin`, `lua`, `make`, `markdown`, `nix`, `objc`, `ocaml`, `odin`, `php`, `powershell`, `protobuf`, `python`, `r`, `regex`, `ruby`, `rust`, `scala`, `solidity`, `sql`, `starlark`, `svelte`, `swift`, `toml`, `tlaplus`, `tsx`, `typescript`, `verilog`, `vue`, `xml`, `yaml`, `zig`.

## Outputs

### Search
- Single-shot tool result; one text block:
  - grouped by file for directory/multi-file searches,
  - match lines rendered under `[PATH#HASH]` as `*LINE:text` in hashline mode or `*LINE|text` otherwise,
  - continuation lines for multi-line matches rendered with a leading space,
  - an optional `meta: NAME=value, …` line per match when metavariables were captured.
- No matches: `No matches found` or `No matches found. Parse issues mean the query may be mis-scoped; narrow \`path\` before concluding absence.` plus formatted parse issues.
- Truncated results end with `Result limit reached; narrow path or increase limit.`
- `details` (`AstGrepToolDetails`): `matchCount`, `fileCount`, `filesSearched`, `limitReached`; optional `parseErrors`, `parseErrorsTotal`, `scopePath`, `searchPath`, `cwd`, `files`, `fileMatches`, `displayContent`, `meta`. Native ranges stay inside the native result.

### Edit
- Always a preview (`applied: false`). A non-empty proposal begins with `Staged as a proposal — files NOT modified yet...` and names the resolve/reject device paths.
- Each change renders as two lines. Hashline mode uses `-LINE:before` / `+LINE:after` under a `[PATH#TAG]` header; plain mode uses `-LINE:COLUMN before` / `+LINE:COLUMN after`. Only the first line of each snippet is shown, truncated to 120 characters.
- `Limit reached; narrow paths.` and formatted parse issues are appended when applicable; no matches yields `No replacements made`.
- `details` (`AstEditToolDetails`): `totalReplacements`, `filesTouched`, `filesSearched`, `applied`, `limitReached`; optional `parseErrors`, `parseErrorsTotal`, `scopePath`, `files`, `fileReplacements`, `displayContent`, `searchPath`, `cwd`, `meta`.
- File writes happen only through a plain-text `write` to `xd://resolve` (body = reason); `xd://reject` discards. Apply returns a separate resolve dispatch result on the `write` call. The staged action's label is `AST Edit: N replacements in M files`, with `sourceToolName: "ast"`.

## Flow
1. `AstTool.execute()` validates the mode against `resolveAstModes(session)` and rejects fields belonging to the other mode, then dispatches to `runAstSearch(session, { pat, path, lang, skip }, signal)` or `runAstEdit(session, { ops, path }, "ast", signal)`.
2. Both runners resolve paths with `resolveToolSearchScope()` in `path-utils.ts`: normalize entries, expand semicolon-delimited lists (plus conditional comma/whitespace splits), reject empty entries. Internal URLs resolve through the shared router; entries without `sourcePath` and internal-URL globs fail. Search materializes readable external URLs to immutable local files.
3. For multiple inputs, `partitionExistingPaths()` drops missing bases only when at least one base survives; all-missing fails. `parseSearchPathPreferringLiteral()` splits a path into `basePath` plus optional `glob`; `resolveExplicitSearchPaths()` collapses multiple inputs into a common base plus brace-union glob, or separate `targets` when the common ancestor is not itself a requested path. The scope's `isDirectory` flag decides grouped directory output.
4. Search: one native `astGrep(...)` call for a single base, or `runMultiTargetAstGrep(...)` per target, rebasing paths to the common root, sorting globally, then applying `skip` and the wrapper limit. Native search normalizes/dedupes patterns, uses `smart` strictness, scans candidates (file or gitignore-aware directory), infers language per file unless `lang` is set, compiles the pattern per language, reports syntax-error trees as parse issues, runs `find_all`, captures bindings, sorts by path/position and pages by `offset`/`limit`.
5. Edit: ops become a `Record<pattern, replacement>`; `PI_MAX_AST_FILES` (`$envpos(..., 1000)`) is the native `maxFiles` cap. `runAstEditOnce(...)` runs native `astEdit(...)` with `dryRun: true`, `failOnParseError: false`. Native edit sorts rules by pattern string, compiles each rule per discovered language, skips files with syntax-error trees, collects `replace_by(...)` edits, enforces caps, and returns before/after slices plus ranges.
6. If the preview has replacements, `queueResolveHandler(...)` registers a non-forcing pending resolve invoker. While pending, the session surfaces a `SoftToolRequirement` (`toolName: "write"`, satisfied by `xd://resolve` / `xd://reject`); the runtime forces `write` only if the model declines that turn.
7. On `write xd://resolve`, the callback reruns the same rewrite set with `dryRun: false` and compares replacement totals and per-file counts with the preview; a mismatch returns an error (`stalePreview`). Success returns `Applied N replacements in M files.` (hashline mode adds fresh `[path#tag]` headers). `write xd://reject` returns a discard message without mutating files.

## Side Effects
- Search stats inputs and reads files/scans directories through `fs_cache`; no session state beyond the transcript.
- Edit apply stages every changed file in memory, verifies the full pass, then writes; a later compute/overlap failure cannot partially mutate earlier files. Preview registers the pending resolve invoker and `SoftToolRequirement`.
- Native work runs on a blocking worker via `task::blocking(...)`; cancellation and timeout are cooperative through `CancelToken::heartbeat()`.

## Limits & Caps
- Search result cap: `DEFAULT_AST_LIMIT = 50` in `ast-grep.ts`; single-target calls use the native default of 50, multi-target calls fetch `skip + 50 + 1` per target and re-page after the global sort.
- Edit file cap: `PI_MAX_AST_FILES`, default `1000`. Native `maxFiles`/`maxReplacements`/`limit` are clamped to at least `1`; the wrapper never sets `maxReplacements`.
- Parse issues are deduplicated and capped at `PARSE_ERRORS_LIMIT = 20` via `capParseErrors(...)`; `details.parseErrorsTotal` holds the pre-cap count.
- Directory scans use `include_hidden: true`, `use_gitignore: true`, and skip `node_modules` unless the glob mentions it.
- No glob-expansion count cap; search has no file-count cap at all.

## Errors
- `ToolError` for an unavailable mode, cross-mode fields, empty patterns, duplicate rewrite patterns, invalid `skip`, empty path entries, internal-URL globs, internal URLs without `sourcePath`, and missing paths.
- Native hard errors: unreadable roots, bad globs, overlapping computed edits (`Overlapping replacements detected; refine pattern to avoid ambiguous edits`), out-of-bounds ranges or non-UTF-8 replacement text, apply write failures, cancellation (`Aborted: Signal`) or timeout (`Aborted: Timeout`).
- Parse policy: per-language pattern compile failures and file parse failures are non-fatal and accumulate in `parseErrors`. Search still searches files with error nodes (warning is additive); edit skips them for rewriting. If every rewrite pattern fails to compile, edit returns a successful zero-replacement result with `parseErrors`. "No matches" is never an error.

## Notes
- Search wraps `pat` into a one-element `patterns` array; the model cannot send multiple search patterns even though the native binding supports it.
- Edit does not expose native `lang`, `strictness`, `selector`, `maxReplacements`, `failOnParseError`, or `timeoutMs`.
- Mixed-language scopes work in both modes because compilation is per discovered language; incompatible languages produce parse issues.
- Native rewrite order is by pattern-string sort, not `ops` order. Rewrites are applied per file from the end backward after an overlap check. Idempotency is not enforced.
- Glob semantics: `*.ts` matches direct children, `**/*.ts` recurses.
- Hashline anchors require the edit tool in hashline mode and a successful whole-file snapshot; otherwise output falls back to plain line numbers.
- `ast_grep` and `ast_edit` are temporary name aliases (`normalizeToolName` maps both to `ast`) kept only for the cutover; they will be removed.
