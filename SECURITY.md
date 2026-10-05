# Security Policy

## Supported versions

| Version | Security fixes |
|---|---|
| 0.1.x | yes |
| anything older | no releases exist yet |

## What this tool touches (privacy facts)

codex-usage is personal, local analytics. Source data is read-only; the web entry creates
its own statistics index and listens on loopback.

| Aspect | Behaviour |
|---|---|
| Source data | Codex, Claude, OMP and DSH local usage logs; existing terminal reports continue to use Codex rollout files |
| Source overrides | Web: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OMP_SESSIONS_DIR` / `PI_CODING_AGENT_DIR`, `DSH_HOME`; legacy Codex report paths retain `CODEX_USAGE_SESSIONS_DIR` / `CODEX_USAGE_ARCHIVE_DIR` |
| Index path | `~/.cache/codex-usage/usage.sqlite3` (`CODEX_USAGE_CACHE_DIR` overrides the directory) |
| Pricing reads | Bundled public prices, the tool's pricing cache and optional user overrides |
| External network | No external access for ordinary analysis; public prices are downloaded only by explicit `--update-pricing` |
| Local HTTP | `--web` starts a loopback server serving bundled assets and statistical JSON |
| Writes | The web entry writes a rebuildable SQLite index; explicit pricing refresh writes the tool's price cache. Source logs, harness settings and user pricing overrides are never modified |
| Stored/output fields | Usage metadata, token counts, price basis, source identities and recorded session relationships; tool statistics are limited to name, identity, status and timestamps. The statistics index and API exclude conversation bodies, prompts, tool arguments, tool result bodies and credentials |
| Charts | Legacy terminal charts are rendered in memory and sent to the terminal |
| Telemetry | None; no analytics, crash reporting or remote usage upload |
| Lifetime | The server runs in the foreground; Ctrl-C stops it and releases the port. Closing a tab leaves it running |

### Local HTTP boundary

The web workbench is intended for one personal machine. It binds to loopback, validates
Host and same-origin Origin values, and rejects cross-site Fetch Metadata requests. It
does not enable CORS. Mutating requests use POST with JSON; GET queries do not initiate
source scanning or pricing downloads.

There is no startup token, login or authentication cookie. Other processes and accounts
on the same machine can query the statistics while the server runs, even when filesystem
permissions prevent them from reading the original source files. This does not provide isolation
between users sharing a host. Keep the service local; publishing it through a proxy or
port forward changes the trust boundary and is outside the supported deployment.

API output includes usage identities and project metadata, which can reveal local work
patterns. Tool names and execution identities can also reveal workflow metadata. It
excludes raw conversation content, tool parameters, result bodies and secrets. Turn
boundaries inferred from source iteration records must retain their inferred status;
they do not establish undocumented causal relationships. Source-root configuration is
local to startup; the API does not offer arbitrary filesystem reads or writes.

### Explicit external download: `--update-pricing`

- The download runs only when the flag is passed; web analysis has no implicit pricing
  refresh or background external requests.
- `--pricing-source models.dev` (default) downloads the public models.dev price dataset;
  `--pricing-source litellm` downloads the public LiteLLM price table. Both are
  unauthenticated HTTPS requests with a 30 s timeout.
- The request carries no local session contents, usage statistics, source paths or
  environment information.
- The result is written to `~/.cache/codex-usage/pricing.json`; `CODEX_USAGE_CACHE_DIR`
  overrides the cache directory.

## Reporting a vulnerability

Please use GitHub's private channel:

1. Open the repository's **Security** tab -> **Report a vulnerability**
   (<https://github.com/stofancy/codex-usage/security/advisories/new>), or
2. Contact the maintainer [@stofancy](https://github.com/stofancy) privately on GitHub.

Do not open a public issue for a security problem, and avoid posting exploit details in
public discussions.

Please include: affected version, reproduction steps or a minimal sample, the impact you
believe it has (information disclosure, arbitrary file read/write, code execution, ...)
and how to reach you. We will acknowledge the report as soon as possible, fix it in a new
release, and credit you in the Security section of [CHANGELOG.md](CHANGELOG.md) unless you
prefer to stay anonymous.

## Out of scope

- Vulnerabilities in third-party dependencies (including Starlette, Uvicorn, React, Recharts, rich, plotext,
  termcharts, matplotlib and textual-image). Report those upstream; we are happy to pick up upgraded versions.
- Attacks that require the local session files to be malicious: they are treated as trusted
  user data. We do, however, welcome reports about **parser robustness** (malformed input
  causing crashes or unbounded resource use).
- Scenarios that require the user to point a `CODEX_USAGE_*` variable at a hostile path.
