# search

> One search tool with three modes: `regex` (file contents by regex), `glob` (files/dirs by glob pattern), and `semantic` (behavior by natural-language description, judged).

## Source
- Entry: `packages/coding-agent/src/tools/search.ts` (`SearchTool`, `searchSchema`, `resolveSearchModes`, `searchCallMode`)
- Mode runners (also constructed directly by the Cursor bridge and legacy SDK shims):
  - `packages/coding-agent/src/tools/grep.ts` — `GrepTool` (regex)
  - `packages/coding-agent/src/tools/glob.ts` — `GlobTool` (glob)
  - `packages/coding-agent/src/tools/jfind/index.ts` — `FindTool` (semantic)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search.md` (the runners keep their own per-mode prompts for direct construction)
- Renderers: `packages/tui/src/tools/search.ts` dispatches to the grep/glob/find renderers by call mode and result-details shape.

## Modes and gating

| Mode | Available when | Approval tier |
| --- | --- | --- |
| `regex` | setting `grep.enabled` (default `true`) | `searchPathTier` over the searched paths |
| `glob` | setting `glob.enabled` (default `true`) | `searchPathTier` |
| `semantic` | `find.enabled` (`auto`/`on`/`off`, default `auto`) **and** a resolvable judge (`isFindEnabled`) | `searchPathTier` |

- The advertised schema is composed from the available modes only: a single-mode session sees just that variant (no `mode` field); a multi-mode session sees `mode` plus the available modes' fields.
- `tools.approval.grep` / `.glob` / `.find` user policies keep applying per mode via the approval `policyKey`; `tools.approval.search` applies to all modes as the fallback.
- `grep`, `glob`, and `find` remain legacy name aliases (`normalizeToolName` maps all three to `search`) for agent definitions, explicit tool lists, and historical transcripts.

## Inputs

### `mode: "regex"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Regex (Rust regex, then PCRE2). Whitespace-only is rejected; the pattern is otherwise preserved verbatim. Literal `\n`/`\\n` enables cross-line matching. |
| `path` | `string` | No | File, directory, glob, archive member, external or internal URL, or file line selector (`src/foo.ts:50-100`); `;`-separated lists allowed. Default `.`. |
| `case` | `boolean` | No | Case-sensitive. Default `true`. |
| `gitignore` | `boolean` | No | Respect `.gitignore`. Default `true`. |
| `skip` | `number \| null` | No | File-page offset for multi-file results. |

### `mode: "glob"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | No | Glob pattern or `;`-separated paths/URLs (`local://*.md`, `omp://**/*.md`). Default workspace root. Bare `*.ts` matches any depth; `dir/*.ts` only direct children. |
| `hidden` | `boolean` | No | Include hidden files. Default `true`. |
| `gitignore` | `boolean` | No | Respect `.gitignore`. Default `true`. |
| `limit` | `number` | No | Max results. Default 200. Newest-first by directory; dirs end `/`. |

### `mode: "semantic"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Plain-language behavior description (not regex). |
| `grep_keywords` | `string[]` | Yes (may be `[]`) | Likely verbatim terms. |
| `path` | `string` | No | One directory or file, host path or internal URL. Default workspace root. |

Only the mode-defining fields are cross-checked: regex rejects `query`/`grep_keywords`, glob rejects `pattern`/`query`, and semantic rejects `pattern`, each with a `ToolError`; a mode missing its required field (`pattern` for regex, a non-empty `query` for semantic) or not enabled in the session is also a `ToolError`. Any other field from another mode (`case`, `skip`, `hidden`, `limit`, …) is silently dropped. Modeless calls infer the mode: `query` → semantic, `pattern` → regex, otherwise glob.

## Outputs
Per mode, the result and `details` are exactly what the former tools produced (`GrepToolDetails`, `GlobToolDetails`, `FindToolDetails`); the TUI and collab renderers dispatch on the call's mode, falling back to the details shape (`hits` → semantic, `fileMatches` → regex, else glob).
