# ast

> Structural code search (`mode: "search"`) and preview-first structural rewrites (`mode: "edit"`) over source files via native ast-grep.

## Source
- Entry: `packages/coding-agent/src/tools/ast.ts` (`AstTool`, `astSchema`, `resolveAstModes`, `astCallMode`)
- Mode runners:
  - `packages/coding-agent/src/tools/ast-grep.ts` — `runAstSearch(...)`
  - `packages/coding-agent/src/tools/ast-edit.ts` — `runAstEdit(...)`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ast.md`
- Key collaborators:
  - `crates/pi-natives/src/ast.rs` — native scan, parse, match, rewrite planning and file mutation (`astGrep` / `astEdit` bindings)
  - `crates/pi-ast/src/language/mod.rs` — language aliases and extension inference used by the native wrapper.
  - `crates/pi-ast/src/ops.rs` — pattern compilation, JSON member-fragment fallback, and edit overlap validation
  - `packages/coding-agent/src/tools/path-utils.ts` — path/glob parsing (host paths and internal URLs) and multi-path resolution
  - `packages/coding-agent/src/internal-urls/url-filesystem.ts` — `InternalUrlFilesystem`, the URL filesystem the native runners read and write through
  - `packages/coding-agent/src/tools/resolve.ts` — edit preview/apply queueing
  - `packages/tui/src/render/render-utils.ts` — parse-error dedupe and display caps
  - `packages/tui/src/tools/match-line-format.ts` — hashline match rendering
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline vs line-number output mode
  - `packages/tui/src/tools/hashline-format.ts` — stable hashline header formatting for edit preview anchors
  - `packages/tui/src/tools/ast.ts` — `astToolRenderer` (dispatches to the search/edit renderers)
  - `packages/natives/native/index.d.ts` — JS-visible native binding contract

## Modes and gating

| Mode | Available when | Approval tier |
| --- | --- | --- |
| `search` | setting `astGrep.enabled` (default `false`) | the searched paths' tier (`searchPathTier`) |
| `edit` | setting `astEdit.enabled` (default `true`) **and** the session grants `edit` (`session.isToolActive("edit")`, default true) | strictest `InternalUrlRouter.writeTier()` over every path; `write` when none is given |

- `resolveAstModes(session)` computes the usable modes; `AstTool.createIf(session)` returns `null` when neither is available. Read-only tool sets (no `edit` grant) therefore only get `search`.
- The tool is `discoverable` (not in the essential set) and `strict`.
- `deferrable` is true only when `edit` mode is available; that is what makes `createTools(...)` / `createAgentSession(...)` keep `write` registered for the `xd://resolve` / `xd://reject` devices.
- The registry allows `ast` when either setting is on. Non-restricted explicit tool lists auto-include `ast` when they hold `grep` (with `astGrep.enabled`) or `edit` (with `astEdit.enabled`).
- The advertised schema is narrowed per session: with only one mode usable the model sees just that variant (and no `mode` field).

## Inputs

### `mode: "search"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | `"search"` | When both modes are advertised | |
| `pat` | `string` | Yes | Single AST pattern. Trimmed; empty strings are rejected. |
| `path` | `string` | No | One file, directory, glob, internal URL, or fetched web URL — or several as a semicolon-delimited list (`"src; tests"`). Omitted or empty defaults to `.`. |
| `lang` | `string` | No | Force the language instead of per-file extension inference. |
| `skip` | `number` | No | Match offset. Defaults to `0`, then `Math.floor(...)`; negatives and non-finite values fail. |

### `mode: "edit"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | `"edit"` | When both modes are advertised | |
| `ops` | `{ pat: string; out: string }[]` | Yes (min 1) | Rewrite rules. `pat` must be non-empty; duplicate `pat` values fail before native execution. Empty `out` deletes the matched node. |
| `path` | `string` | Yes | One file, directory, glob, or file-writable internal URL (`local://`) — or several as a semicolon-delimited list. Fetched external URLs are read-only and cannot be rewritten. |

Sending a field from the other mode is a `ToolError` (e.g. `pat`, `lang`, `skip` with `mode: "edit"`).

### Pattern grammar
- `$NAME` — capture one AST node.
- `$_` — match one AST node without binding.
- `$$$NAME` — capture zero or more AST nodes; ast-grep stops lazily at the next satisfiable node.
- `$$$` — match zero or more AST nodes without binding.
- Metavariable names must be uppercase and must stand for whole AST nodes, not partial tokens or string fragments.
- Reusing the same metavariable requires identical code at each occurrence.
- Patterns must parse as one valid AST node for the inferred target language.
- Edit mode: captures from `pat` are substituted into `out`; each rewrite is a 1:1 structural substitution.
- Supported canonical languages come from `SupportLang::all_langs()` in `crates/pi-ast/src/language/mod.rs`.

## Outputs

### Search
- Single-shot tool result; one text block grouped by file, with an optional `meta: NAME=value, …` line per match when metavariables were captured.
- No matches: `No matches found` (plus parse-issue guidance when present).
- Truncated results end with `Result limit reached; narrow path or use skip to page through results.`
- `details` (`AstGrepToolDetails`): `matchCount`, `fileCount`, `filesSearched`, `limitReached`; optional `parseErrors`, `parseErrorsTotal`, `scopePath`, `searchPath`, `cwd`, `files`, `fileMatches`, `displayContent`.

### Edit
- Always a preview (`applied: false`) staged behind `xd://resolve` / `xd://reject` under `sourceToolName: "ast"`; the result opens with the preview-pending notice.
- No replacements yields `No replacements made`.
- `details` (`AstEditToolDetails`): `totalReplacements`, `filesTouched`, `filesSearched`, `applied`, `limitReached`; optional `parseErrors`, `parseErrorsTotal`, `scopePath`, `searchPath`, `cwd`, `files`, `fileReplacements`, `displayContent`.
- On apply, replacement totals and per-file counts are compared with the preview; a mismatch returns a stale-preview error. Success returns `Applied N replacements in M files.`

## Flow
1. `AstTool.execute()` validates the mode against `resolveAstModes(session)` and rejects fields belonging to the other mode, then dispatches to `runAstSearch(session, { pat, path, lang, skip }, signal)` or `runAstEdit(session, { ops, paths: toPathList(path) }, "ast", signal)`.
2. Both runners resolve paths with `resolveToolSearchScope()` in `path-utils.ts`. Internal URLs resolve through the shared router and the call's `InternalUrlFilesystem` (bounded by the approved tier); edit requires file-writable URLs (`fileWritableOnly`). Search materializes readable external URLs to immutable local files.
3. Search: one native `astGrep(...)` call for a single base, or `runMultiTargetAstGrep(...)` per target, applying `skip` and the wrapper limit (50).
4. Edit: ops become a `Record<pattern, replacement>`; `PI_MAX_AST_FILES` (default `1000`) caps files. The preview runs native `astEdit(...)` with `dryRun: true`; the apply reruns with `dryRun: false`.

## Notes
- `ast_grep` and `ast_edit` are legacy name aliases (`normalizeToolName` maps both to `ast`) kept for the cutover; old sessions and agent definitions keep resolving.
- Search wraps `pat` into a one-element `patterns` array; the model cannot send multiple search patterns even though the native binding supports it.
- Mixed-language scopes work in both modes because compilation is per discovered language; incompatible languages produce parse issues.
