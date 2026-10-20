{{#if search}}{{#if edit}}Structural code search (`mode: "search"`) and codemods (`mode: "edit"`) via ast-grep. Use when syntax shape matters more than text.{{else}}Structural code search via ast-grep. Use when syntax shape matters more than text (calls, declarations, language constructs).{{/if}}{{else}}Structural AST-aware rewrites via ast-grep. Use for codemods where text replace is unsafe.{{/if}}

<instruction>
- `$NAME` captures one node; `$_` matches without binding; `$$$NAME` zero-or-more; `$$$` zero-or-more unbound.
  - Use `$$$NAME`, NOT `$$NAME` (invalid). Names UPPERCASE, whole node — `prefix$VAR` fails.
- Same metavariable twice → MUST match identical code (`$A == $A` matches `x == x`, not `x == y`).
- Patterns MUST parse as single AST node. Non-standalone → wrap: `class $_ { … }`.
- TS: tolerate annotations — `async function $NAME($$$ARGS): $_ { $$$BODY }`.
- Parse issues = malformed query, not absence or a clean no-op: fix the pattern or tighten `path`.
{{#if search}}- Narrow each search to one language. `pat` is ONE AST pattern; separate calls for unrelated patterns.
- Set `lang` when extension inference is ambiguous (for example, `cpp` for `.h`); `.cu` and `.cuh` infer as C++.
- C++ expression-statement calls need trailing `;`: `ns::doThing($ARG);`, `$CALLEE($ARG);`.
- Declaration forms are distinct — `function foo`, method `foo()`, `const foo = () => {}`; search the right form before concluding absence.
- Loosest existence check: `pat: "executeBash"` with narrow `path`.
{{/if}}{{#if edit}}- Metavariables in an op's `pat` substitute into its `out`; 1:1 — no splitting/merging captures. Delete with empty `out`: `{"pat":"console.log($$$)","out":""}`.
- Mixed-language paths are fine: each file is parsed in its own language, and a pattern only rewrites files it parses in.
- Rewrites are STAGED, not applied: finalize by writing a one-sentence reason to `xd://resolve` (apply) or `xd://reject` (discard). For one-off text edits, prefer the Edit tool.
{{/if}}</instruction>
{{#if search}}

<critical>
- AVOID repo-root scans — narrow `path` first.
{{#if eagerDelegation}}- Broad cross-subsystem exploration → {{#if scoutAvailable}}Task tool + scout{{else}}Task tool{{/if}} subagent first.{{/if}}
</critical>{{/if}}
