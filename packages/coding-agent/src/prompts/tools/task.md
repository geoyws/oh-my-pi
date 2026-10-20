{{#if asyncEnabled}}{{#if batchEnabled}}Spawn background subagents from one `tasks[]` batch; IDs return immediately.{{else}}Spawn ONE background subagent per call; its ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents run inline and return in this call; other batch items still run in background.{{/if}}{{else}}{{#if batchEnabled}}Run a `tasks[]` batch of subagents synchronously; blocks until all finish.{{else}}Run ONE subagent synchronously; blocks until it finishes.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
- Results auto-deliver; a settled `hub jobs`/`hub wait` snapshot counts as delivery.
- Job IDs are process-local, expiring ~30s after delivery (unconsumed: 5 min); later use `hub send`, `agent://<id>`, `history://<id>`.
- `outputSchema` payload, even invalid, at `agent://<id>` (fields `?q=.<field>`); invalid also previews inline.
- `completed` ≠ accepted; verify claimed changes.
{{/if}}

# Delegation
- Pick each item's most specific agent.{{#if scoutAvailable}} Read-only research MUST use `scout`, only when affected files are unknown.{{/if}} Omit `agent` when the spawn-policy default is the best fit; otherwise pass the specialist. Prefer one agent that investigates AND edits.
- Same-file edits are not guaranteed to merge.{{#if ircEnabled}} Siblings coordinate through `hub` before editing shared files.{{/if}} Name one integration owner; decide shared contracts up front in {{#if batchEnabled}}`context`{{else}}the task{{/if}}.
- Every task MUST skip build/lint/tests/formatters; run them once at the end.
- Subagents start blank.{{#if ircEnabled}} Parent IRC steers immediately.{{/if}} Pass large payloads as `local://<path>`, NEVER inline.

# Inputs
{{#if batchEnabled}}
`context`: shared state, constraints, contracts; never repeat per task. Each `tasks[]` item:
{{/if}}
- `name`: CamelCase ≤32, addresses the agent; auto-generated if omitted.
- `agent`: agent type. Omitting it selects the spawn-policy default (`{{defaultAgent}}`); NEVER pass that default explicitly.{{#if allowedAgentsText}} Spawn policy allows: {{allowedAgentsText}}.{{/if}}
- `task`: complete, self-contained, with acceptance criteria; one-liners PROHIBITED.
{{#if evalToolsEnabled}}- `tools`: eval-defined tool names (`@tool` / `tool(fn)`); calls run in your kernel.
{{/if}}
{{#if effortEnabled}}- `effort`: `"lo"`|`"med"`|`"hi"`, by task complexity.
{{/if}}
- `outputSchema`: per-spawn JSON Schema; overrides agent/session schemas.
- `schemaMode`: `"permissive"` (default) accepts retry-exhausted invalid output with a warning; `"strict"` fails it.
{{#if isolationEnabled}}
- `isolated`: run in a worktree; {{#if applyIsolatedChanges}}successful changes auto-apply to the parent checkout{{else}}changes kept as patch/branch artifacts, parent untouched{{/if}}.
{{/if}}

# Format
{{#if batchEnabled}}`context`: `# Goal`, `# Constraints`, `# Contract`.
{{/if}}
`task`: `# Target` (files, symbols, non-goals), `# Change` (steps, APIs), `# Acceptance` (observable result; no project-wide commands).

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
{{#if hasModelMentions}}
`m<N>` agents are models the user tagged (`<model agent="m<N>" name="…"/>`): the task agent pinned to that model. Spawn one only when the user's request names it; never in place of a specialist.
{{/if}}
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY){{/if}}{{#if blocking}} (BLOCKING: inline result){{/if}}
{{description}}
{{#if readOnly}}Investigation only; edits go to you or a writing agent.{{/if}}
{{/list}}
{{/if}}
