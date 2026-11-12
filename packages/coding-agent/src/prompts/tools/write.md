SHOULD `edit` existing files; `write` for required new files or whole-file replacement. NEVER create docs or emojis unless requested.
Appending a line: `write` when the file does not exist yet, `edit` (insert after its last line) when it does; NEVER shell redirection (`>>`, `printf`, `tee`).
`archive.ext:member`: ZIP/tar families and `.asar` writable, others read-only. `db.sqlite:table`: insert; `db.sqlite:table:key`: JSON update, empty content deletes.
