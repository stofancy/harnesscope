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

## Running the tests

```bash
.venv/bin/python -m pytest tests/ -q
```

- Tests use synthetic fixtures. New adapters must have sanitized examples with accounting
  expectations; tests must not depend on personal source directories or external services.
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
npm test
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

`pytest`, `ruff check .`, and `mypy src` are blocking CI gates. Run all checks affected
by your change before opening a pull request; frontend changes also require typechecking,
format/metric tests and the static build. The exact test count varies with the installed
extras and Python version.

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
2. Add or update tests, and record the change under `[Unreleased]` in `CHANGELOG.md`.
3. Run `pytest`, `ruff` and `mypy`, plus frontend checks/build when affected.
4. Open the pull request and fill in the template. All required CI checks must pass.

## Reporting issues

- Use the [issue forms](.github/ISSUE_TEMPLATE) for bugs and feature requests.
- Do **not** open a public issue for a security vulnerability; follow
  [SECURITY.md](SECURITY.md) instead.
