Line-anchored patches for existing files: name original lines or gaps, then give the new content. `:` headers take `+` body rows; colonless `PUT` (paste), `CUT`, `REM`, `MV` take none; worked examples: `read omp://tools/edit.md`.

<headers>
Section: `[PATH#TAG]`; `TAG`: 4-hex snapshot from latest `read`/`search`, REQUIRED each section. New files: `write`.
</headers>

<ops>
`PUT N.=M:` replace original inclusive lines N–M.
`PUT N*:` replace the syntactic block starting at N (closer resolved).
`PUT <N:` / `PUT >N:` insert before/after line N (`PUT <1:` file head, `PUT >$:` tail).
`PUT >N*:` insert after block N's end at sibling depth; inside a block use `PUT >M:` at its closer.
`CUT N.=M` / `CUT N*`: delete and capture lines/block, anonymous or `@name`.
`PUT <N @name` / `PUT >N @name`: paste at the gap; omit `@name` for the anonymous register.
`PUT N.=M @name` / `PUT N* @name`: paste over range/block; `@name` required.
`REM`: delete section file. `MV DEST`: move/rename (quote spaced paths); prior edits apply, final content lands at `DEST`.
Single line: `PUT N.=N:` / `CUT N.=N`.
</ops>

<body-rows>
Only under `:` headers. Row: verbatim `+TEXT` (indent kept); lone `+` = blank. NEVER `-old`, bare, or context rows: the range deletes, the body is final content, and body length is independent of the range. Keep a line: exclude it from every range. Literal leading `-`/`+`: `+- item`, `++ item`.
</body-rows>

<rules>
- Numbers and `#TAG` come from the latest `read`/`search` `LINE:TEXT`; original numbers, never shifted by hunks. Each edit renumbers and changes `#TAG`: take next numbers from the edit response or a fresh `read`.
- Touch displayed lines only (others REJECTED); far from the read window, re-`read` and confirm the construct. Elisions (`…`, `..`, collapsed `N-M:`) are UNSEEN: never hunk in/across one.
- Ranges cover changed lines only: never widened over keepers, never starting/ending mid-expression or mid-block; non-adjacent changes get separate hunks. Pure addition: `PUT <N:` / `PUT >N:`.
- Whole construct: `PUT N*:`; internal lines: `PUT N.=M:`. Block ops target the opener of a multi-line construct, NEVER its closer, last line, or a bare inner statement; one statement uses plain range/gap ops.
- Decorator/doc-comment separate block: point N at the first decorator to include both. Standalone line comments are never swept: use `PUT N.=M:`.
- Markdown headings are block openers: a `##`/`###` block runs through deeper headings to the next same/higher heading. After a section `PUT >N*:`, end the body with a blank line.
- Move: `CUT 5.=9 @fn`, then `PUT >40 @fn`; a single-call move may use the anonymous register. Named registers persist across sections and calls.
- NEVER format/restyle with this tool; run the project formatter.
</rules>

<anti-patterns>
- Empty `PUT 4.=4:` to delete → `CUT 4.=4`.
- Range sized to the new content → range names the original lines; body length is irrelevant.
- `-` or bare context rows → the range deletes; the body holds only new `+` rows.
- Pure insertion as a widened `PUT 2.=4:` (retyped keepers get dropped) → `PUT >2:`.
- `PUT >3*:` on a closer or last visible line → `PUT >3:`.
- Body rows under a register paste (`PUT >20 @fn:`) → bodyless `PUT >20 @fn`.
</anti-patterns>

<critical>
1. RE-GROUND AFTER EVERY EDIT: edits renumber and change `#TAG`. Stale tag/surprise: STOP; re-`read`.
2. RANGES TIGHT: changed lines only. Whole construct: `PUT N*:`.
3. BODY FINAL CONTENT: every row starts `+`; Markdown bullet: `+- item`, not `- item`.
</critical>
