Run one step of code in a persistent kernel; state persists across calls and `task` subagents.{{#if spawns}} Eval `agent()` children use independent kernels.{{/if}}

Work incrementally (imports → define → test → use), one step per cell; re-run setup ONLY after `reset` or a kernel crash. On error, re-run only the failing step.
{{#if spawns}}{{#if eagerDelegation}}2+ independent items → named `workpool()` + `.push(…)`, polled outside eval via `hub wait` on the pool name; handles + `wait()` only for dependency-coupled results.{{/if}}{{/if}}
{{#if py}}Python: top-level `await` works; `asyncio.run(…)` raises.{{/if}}
{{#if js}}JS runs under **Bun** (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`); top-level `await`/`return` work.{{/if}}

<prelude>
{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}} Full reference: `read omp://tools/eval.md`.
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
{{#if js}}await {{/if}}tool.<name>(args) → unknown
    Any session tool; `args` = its parameter object.{{#if py}} Async: `await tool.read({...})`.{{/if}}
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → CompletionHandle
    Stateless one-shot (no history/tools); `.wait()` → str, parsed object with `schema`.
await judge(state, questions) → `{id: answer}`
    Cheap typed judgment of one `state` (str | JSON); batch independent questions. Prefer over `completion()` to classify/rank.
    q: `{type: "choice", instructions, criteria: {label: rubric | None, …}}` | `{type: "bool", instructions, criteria?: {true?, false?}}` | `{type: "score", instructions, criteria: [lowest, …, highest]}`
{{#if py}}judge_batch(states, questions, concurrency?=32, retries?=1, min_ok?=1) → JudgmentBatch{{else}}judgeBatch(states, questions, { concurrency?, retries?, minOk? }) → JudgmentBatch{{/if}}
    Same `questions` over many states; host-owned async job, never a `judge()` loop. `await b.drain(timeout?)`, `b.status()`, `b.results()`, `b.close()`.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None{{#if evalTools}}, tools?=None{{/if}}) → AgentHandle
    Background subagent, returns at once.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} `.handle` ("agent://<id>"), `.wait(timeout?)` → final text, `.send(message)`, `.cancel()`; unwaited results auto-deliver.{{#if evalTools}} `tools`: your @tool names the child may call.{{/if}}
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge{{#if evalTools}}, tools{{/if}} }).{{/if}}
workpool(agent?=None, name?=None, context?=None{{#if evalTools}}, tools?=None{{/if}}) → WorkPool
    {{#unless eagerDelegation}}Keep-alive pool for independent items. {{/unless}}`.push(*items)`, `.status()`, `.peek()`, `.close()`. Pool name = async job id; results auto-deliver.
{{/if}}
wait(handles, timeout?=None, raise_errors?=True) → list
    Barrier over agent/completion handles, input order; `raise_errors=False` keeps errors in their slots.{{#if js}} JS: wait(handles, { timeout, raiseErrors }).{{/if}}
{{#if evalTools}}{{#if py}}@tool / tool(fn, name=None, description=None){{/if}}{{#if js}}tool(fn, { name?, description?, parameters? }){{/if}}
    Kernel-run tool{{#if py}} (schema from type hints){{/if}}; pass its name in `task` items' `tools`{{#if spawns}}, `agent(tools=…)`, `workpool(tools=…)`{{/if}}.
{{/if}}
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
```
</prelude>
{{#if preludeDocumentation}}

{{{preludeDocumentation}}}
{{/if}}
{{#if spawns}}
<dag>
Acyclic waves: put upstream `.wait()` results or `.handle`s in downstream prompts (bulk via `local://`); `wait(hs)` = barrier; `raise_errors=False` confines a failure to its subtree. No node waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>

{{#if autoBackgroundEnabled}}Long-running cells may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
