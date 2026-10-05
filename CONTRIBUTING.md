# Contributing

Thanks for taking the time to improve codex-usage. This document explains how to set up
the project, run the tests and get a change merged.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Requirements

- Python >= 3.10 (CI covers 3.10, 3.11, 3.12 and 3.13)
- git
- Node.js >= 22.12 and npm for rebuilding the React/TypeScript frontend; the installed Python
  package serves prebuilt static assets without a Node runtime
- Optional, for real-image chart development: a terminal that supports a graphics protocol
  (kitty, Ghostty, WezTerm, Konsole, foot, xterm-sixel, ...) plus the `[image]` extra

## Local setup

```bash
git clone https://github.com/stofancy/codex-usage
cd codex-usage

python3 -m venv .venv
.venv/bin/python -m pip install -e ".[image,test]" ruff mypy   # drop [image] if you don't need charts
```

## Browser acceptance for dashboard changes

The current dashboard work uses browser automation for functional acceptance. Do not
add or expand unit or component tests for this work. Preserve the existing historical
suites; their results do not establish acceptance of the new dashboard behavior.

Reusable cases use the local `tester-army/e2e` Web engine with deterministic browser
actions and assertions. Commit the cases, sanitized source-log fixtures and their run
instructions together. Exercise the running Python application, its index and the web
UI; do not mock analytics responses or derive expected numbers from the implementation.
Fixture servers must isolate all four source roots, cache and pricing from personal data.

Cover the single global time range and slice, linked filters, chart forms, throughput
metrics, and turn/tool drilldown with a small set of end-to-end user scenarios. Disable
e2e telemetry and use no-model execution by default. Keep generated reports and browser
artifacts out of version control. Static checks and production builds remain applicable.

## Historical test suites

```bash
.venv/bin/python -m pytest tests/ -q
```

- Tests use synthetic fixtures. Source examples and acceptance cases must not depend on
  personal source directories or external services.
- Base installation excludes optional native terminal image dependencies; tests requiring
  those dependencies can be skipped on unsupported Python versions.
- HTTP tests use the application test client; include `httpx` in the development setup.

## Frontend development and packaging

The React/TypeScript/Recharts source lives in `web/`. Its build writes distributable
assets to `src/codex_usage/web_static/`.

```bash
cd web
npm ci
npm run typecheck
npm run build
```

For UI development, `npm run dev` starts the loopback Vite server. Synthetic demo data
is available only in development with `?demo=1`; production never falls back to demo
fixtures on API failure.

Return to the repository root before Python checks and packaging. Rebuild assets after
frontend edits; verify the wheel includes both pricing data and `web_static` resources.
Users launching `codex-usage --web` from the installed package need no Node process or
Vite development server.

## Static checks

```bash
.venv/bin/ruff check .   # ruff.toml
.venv/bin/mypy src       # mypy.ini
```

The existing CI includes historical Python tests, `ruff check .`, and `mypy src`.
For the current dashboard work, use the browser cases above for functional verification,
plus typechecking and the static build. The historical test count varies with installed
extras and Python version; it is not the acceptance measure for the new functionality.

## Code and commit conventions

- Commit messages follow the existing style `<area>: <summary>`; keep one change per commit.
- Style: 4-space indentation, lines <= 100 columns, UTF-8, LF (see `.editorconfig`).
  No formatter is enforced - please do not reformat the whole codebase in a feature PR.
- Typing: annotate new functions in `src/` where practical. Type checking is currently
  non-strict.
- Dependencies: explain the concrete need and maintenance cost of additions. Starlette
  and Uvicorn support the local web runtime; React, TypeScript and Recharts build its
  bundled UI. Keep native terminal image dependencies in the optional `[image]` extra;
  `plotext` is intentionally pinned.
- Behaviour boundaries that every pull request must preserve (see
  [SECURITY.md](SECURITY.md) for the full statement):
  - Ordinary analysis requires no external network. `--web` serves loopback HTTP;
    external pricing download is explicit.
  - Source logs, harness configuration and user pricing overrides stay read-only. Writes
    are limited to the tool's rebuildable statistics index and explicit price cache.
  - Statistical storage and API output exclude conversation bodies, prompts, tool
    arguments and credentials. Missing fields, prices and timing remain unknown.
  - Charts are rendered in memory and sent straight to the terminal - never written to disk.
  - Data goes to stdout only; diagnostics and errors go to stderr.
  - `--json` and `--schema` are public contracts; note compatibility impact for changes.

## Pull request process

1. Fork the repository and create a branch (for example `fix/until-boundary`).
2. Add or update reusable browser cases for dashboard behavior, and record the change
   under `[Unreleased]` in `CHANGELOG.md`.
3. Run the applicable browser cases, static checks and production build.
4. Open the pull request and fill in the template. All required CI checks must pass.

## Reporting issues

- Use the [issue forms](.github/ISSUE_TEMPLATE) for bugs and feature requests.
- Do **not** open a public issue for a security vulnerability; follow
  [SECURITY.md](SECURITY.md) instead.
