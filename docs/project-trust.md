# Project trust

A repository can ship files that OMP would otherwise act on as soon as it
starts in that checkout. OMP keeps three such surfaces inert until you approve
them for that project:

| Surface | What a repository supplies | What could happen without approval |
|---|---|---|
| `mcp` | project MCP servers (`.omp/mcp.json`, `.mcp.json`, `.claude/`, `.cursor/`, `.vscode/`, ...) | OMP launches the repository's command with your environment and file access, or connects to its URL |
| `extensions` | project extensions and hooks (`.omp/extensions/`, project hook dirs, project `settings.json` `extensions`) | OMP imports the repository's code into the agent process |
| `env` | provider, proxy, OAuth and OMP-config names in the project `.env` | `ANTHROPIC_BASE_URL`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and similar send your stored API keys and OAuth tokens to a host the repository chose |

Approval is per project directory (resolved real path) and per surface, and
it is bound to a content fingerprint. Any change to a surface's content — a
new MCP server, a changed command, an edited extension file, a changed routing
URL — makes that surface unapproved again until you re-approve it.

## Approving a project

```bash
omp trust                 # list what the project supplies and approve interactively
omp trust --yes           # approve the listed content without the prompt
omp trust --json          # machine-readable listing, no change
omp trust --revoke        # forget every approval for the project
omp trust --dir PATH      # act on another directory
```

`omp trust` only reads: it never starts a project MCP server or imports
project code. Read the listing before you approve — approving lets that code
run as you. Restart omp in the project afterwards.

Without approval, startup logs which project MCP servers, extensions and
`.env` names it skipped. Everything else keeps working: user-level MCP
servers and extensions, and non-routing project `.env` names (for example
`LOG_LEVEL`), load as before. An unapproved project server never shadows a
same-named user server.

## What counts as an `env` routing name

A project `.env` name is routing when it is one of `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`,
`NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_OPTIONS`, `BUN_OPTIONS`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `HOME` or `PATH`
(any case); starts with `PI_`, `OMP_` or `XDG_`; ends with `_URL`, `_URI`,
`_BASE`, `_ENDPOINT`, `_HOST`, `_PROXY`, `_ORIGIN`, `_DOMAIN` or `_REGION`; or
contains `BASE_URL`, `API_BASE`, `TOKEN_URL`, `AUTH_URL` or `ISSUER`. The
`env` fingerprint covers only these names and their values, so editing other
project `.env` lines keeps the approval. The home directory's own `.env` and
variables set in your shell are never gated.

## MCP OAuth credentials

Independently of trust, an MCP server's `auth.credentialId` may only name a
credential OMP's MCP OAuth flow created (`mcp_oauth:...` / `mcp_oauth_...`).
A config naming a provider login such as `anthropic` or `openai-codex` gets no
credential.

## Limits

- The extension fingerprint covers every file under each project extension's
  own folder (excluding `node_modules` and dot-directories). Code it imports
  from outside that folder is not covered.
- The store is `<agent dir>/trusted-projects.json` (mode `0600`). Deleting it
  revokes every approval.
- Running omp from source with `bun` (not the built binary) lets Bun itself
  autoload the project `.env` before OMP starts; the shipped binary disables
  that autoload, so the `env` gate applies there.
