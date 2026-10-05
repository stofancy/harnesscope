# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning notes

- The first public release is `0.1.0` (2026-09-21); the project deliberately stays in the
  `0.x` range so that breaking changes are still allowed before `1.0.0`.
- Unreleased work goes under `[Unreleased]`; at release time that section is renamed to
  `[X.Y.Z] - YYYY-MM-DD` and a fresh empty `[Unreleased]` opens.
- The `--json` and `--schema` output shapes are part of the public contract: breaking
  changes there bump MAJOR (while in `0.x`, at least MINOR with a migration note).
- Entries use the Keep a Changelog categories: Added, Changed, Deprecated, Removed,
  Fixed, Security.

## [Unreleased]

### Changed

- Automatic refresh scans immediately on enable, keeps running when the page loses
  visibility, and checks again on foreground return. The controls show active/paused
  state and the latest successful refresh time.
- Source health shows categorized parsing reasons, affected files, statistical impact
  and suggested actions. The rebuildable index preserves diagnostic codes and bounded
  byte locations while excluding arbitrary parser messages.
- Session filters, rankings, usage rows and details show native titles and project names,
  with IDs and full paths in tooltips. Same-name projects and cross-harness session IDs
  retain separate identities; source refresh updates title metadata in the local index.
- Time edits apply on blur, Enter or calendar selection. Refresh, browser reload and
  range return resolve expressions against the actual clock; fixed ranges retain precision.
- Renamed the repository, Python package, CLI, browser UI and tool environment variables
  to Harnesscope / `harnesscope` / `HARNESCOPE_*`. The default cache is now
  `~/.cache/harnesscope`; native harness source variables keep their names.
- Automatic refresh runs only for ranges ending now, with saved preferences restored
  on returning to now. Historical ranges retain manual refresh; future bounds are rejected.
- Overview comparisons show the preceding equal-length window and explain which
  period has unpriced calls. Known cost subtotals remain distinct from complete changes.
- Unified time inputs accept expressions or concrete times independently, with a
  calendar picker on each field. Mixed bounds and second-precision fixed ranges
  persist across reload and page changes; refresh resolves relative expressions again.
- Condensed the daily-use Dashboard around first-screen totals, a consumption trend and
  absolute contributor ranking. A separate usage ledger handles request/session/turn/model/harness
  records with shared time/filter context, visible identities and full-result sorting.
- Saved time/filter/panel preferences in browser local storage. Local panel changes and
  pagination query only their affected data; serialized statistical reads avoid SQLite
  row-conversion contention while refresh/status remain independently available.
- Show recorded tool counts and known per-turn subtotals with their coverage. Strict
  complete-value fields keep their existing meaning; entirely unpriced values stay unknown.
- Inline time inputs, direct interval buttons, an explicit automatic-refresh switch and
  independent collapsible source health simplify frequent operations. Display and bucketing
  use the local timezone; Codex modes display Standard, Fast and Not recorded.

### Added

- Yearly usage calendar with daily Tokens, estimated cost and model-call intensity,
  shared year selection, day drilldown and range return. Empty, partial, unknown and
  future dates retain distinct states.
- Real-window sparklines on cost, token and call cards, plus a four-part Token
  composition bar that preserves missing cache-write coverage.

- Snapshot-consistent `labels` on analytics, usage, turns, session lists and session/turn
  details, sourced from explicit native title fields and existing project metadata.

- Source installer with optional systemd user service, plus the same `start`, `stop`,
  `restart` and `status` commands for service and ordinary background modes.
- Rolling time expressions such as `-18h` and `-2days`, fixed-start-until-now ranges,
  inline absolute-time inputs and optional automatic refresh. Refresh scans source changes before
  updating the view, advances rolling ranges and preserves fixed historical ranges.
- Light and dark themes with persistent selection, coordinated chart/table/control colors
  and a richer data palette.
- Dedicated usage ledger showing uncached input, cache reads, output, cache writes, estimated
  cost and separate response/turn TPS from reliable samples.
- Unified PC Dashboard with a single global range/interval control, parallel
  consumption/rate/cache/timing panels and per-panel area/line/bar views. Usage and turn/tool
  drilldown live in the separate records view. Chart clicks and brush selection update the whole page's window with
  range history; expanded slice values expose the numbers and covered seconds.
- Continuous overview → trend zoom → contribution/filter → turn/tool explanation →
  return journey, with persistent selection context and an expandable top-six tool ranking.

- Fine-grained shared analytics slices (`auto`, second, 5/10/30-second and minute variants)
  and recorded TPM/RPM/average tokens-per-second/RPS rates using actual covered seconds.
  Reliable output timing remains separated by harness and timing kind.
- Turn and tool analytics with window/full-turn recorded accounting, duration percentiles,
  partial tool coverage and metadata-only drilldown through `/api/turns` and
  `/api/turns/detail` query parameters. Inferred boundaries retain labels and recorded
  statistics; missing components, timing and prices retain their unknown states.
- Pinned local browser-test infrastructure using `e2e@0.17.0` and `@e2e-dev/web@0.12.0`,
  isolated four-source inputs and `npm --prefix web run test:e2e`. Cases cover numerical
  accounting, linked analysis, append updates, context persistence, sorting and time/refresh
  controls. This work adds no unit/component tests; recorded runs retain their stated coverage.

- Local browser usage workbench (`harnesscope --web`) for Codex, Claude, OMP and
  DSH, backed by a rebuildable SQLite event index and a shared multi-source query layer.
  React/TypeScript/Recharts assets ship with the Python package; Starlette/Uvicorn serve
  them on loopback without a Node runtime for users.
- Time-window filters, dimension breakdowns and trends, previous equal-window comparison,
  member change contributions, cost-per-call / per-million-token and cache-rate analysis.
  `--analytics --query` emits the same shared analysis JSON for automation.
  Cost displays separate known estimates and unknown coverage; recorded usage provides
  no output-quality evidence. Existing terminal/JSON reports remain Codex-specific.
- DSH compressed-session decoding uses the Python `zstandard` runtime dependency.
  Claude cache writes preserve 5-minute/1-hour TTL subsets and can apply verified
  Anthropic write-price rules when explicit rates are missing. Missing fields or
  unpriced models retain unknown cost coverage.

- TPS in all table views and session/model JSON: time-weighted end-to-end output
  throughput from complete single-model turns, including tool execution and waiting.
  Missing, clipped, in-progress, and mixed-model timing remains unknown (`-` / `null`).
  Existing token and cost fields keep their accounting; `--schema` describes `tps`.

### Changed

- Statistics source files remain read-only; `--web` writes only its own statistics index.
  The local HTTP service uses Host/Origin/Fetch Metadata checks with no CORS or user
  authentication. Other same-machine processes and accounts can read statistics while it runs.
- Contributor documentation reflects blocking pytest, ruff and mypy gates and the frontend
  build required for shipping static assets.

### Fixed

- Cancelling a calendar picker no longer leaves automatic refresh permanently paused
  as if a time edit were still in progress.
- Usage drilldowns preserve prior identities when regrouping and narrowing again.
  Dashboard navigation starts a fresh drill context; stale pagination returns to a valid page.
- Historical turns and tools with missing end records no longer enter every later time
  window. Selection requires observed activity; new requests in old sessions remain visible.
- Relative recent-time presets (24 hours / 7 days / 30 days) advance to the current time
  after source refresh. Custom and chart-zoomed windows stay fixed; range return restores
  the original relative/fixed mode.
- Codex resumed rollout files preserve their logical thread identity when later session
  metadata uses a different ID. Parent, agent label, role and subagent purpose are restored
  from recorded spawn metadata without changing usage or pricing identities; absent roles
  stay unknown. The adapter version triggers rebuilding the affected statistics index.
- Added bundled Standard and Fast API prices for `gpt-6.1-sol`, `gpt-6-sol`, and
  `gpt-6-luna`, verified against OpenAI's model pages on 2026-09-30. Fast now applies
  the published 2× API rate for input, cached input, and output on these models.
- Per-model JSON unit prices and daily model charts now use the same recorded-tier
  costs as tables. Daily cache-hit rates and unit prices are calculated from summed
  tokens and costs, including days with multiple Standard/Fast sessions.
- Tests isolate user pricing files, caches, and Codex configuration so enabling Fast
  locally does not change test expectations.

## [0.4.0] - 2026-09-21

### Added

- Cost per million tokens: tables gained a "per 1M tokens" column and charts accept
  `--metric per_mtok` — cost ÷ total tokens × 1e6, i.e. the blended effective unit price after
  cache discounts (a high-cache model can be expensive per call yet cheap per token).
  Aggregates are **weighted** (Σ cost ÷ Σ tokens) instead of averaging per-row unit prices;
  rows without tokens show `-` and unpriced rows keep the `*` marker. `--json` exposes
  `cost_per_million_tokens` per session and per model. Like the hit rate it is rejected by
  `--chart pie`.

## [0.3.0] - 2026-09-21

### Added

- Cache hit rate: every table gained a hit-rate column and charts accept `--metric hit`. The
  ratio is cache read ÷ gross input (gross input includes cache read), the same definition as
  the API's `cached_tokens / input_tokens`. Aggregates are weighted (Σ cache read ÷ Σ gross
  input) so grouping by day, model or family never degenerates into an average of per-row
  percentages; rows with no input show `-` instead of a misleading 0%. `--json` exposes
  `cache_hit_rate` per session and per model (null when there is no input). `--chart pie`
  rejects the metric because share-of-total is meaningless for a ratio.

## [0.2.1] - 2026-09-21

### Fixed

- `--session <uuid>` now matches any UUID in the rollout file name, so `--raw` picks up
  paginated continuation files (the continuation page's session id is the trailing UUID).
  Paginated sessions account for 7.88% of the window's tokens on the maintainer's data;
  the default (merged) view was always correct.

## [0.2.0] - 2026-09-21

### Changed

- `--json` gained `metering` (`resets` / `fallbacks` / `delta_sum`) and `tiers` (per model ×
  service tier, from `thread_settings_applied`) so metering decisions are auditable; `--schema`
  documents both. `--doctor` additionally reports how much of the pricing table lacks a
  cache-read price.
- Cost estimation is now service-tier aware: `priority` and `fast` are one tier (the official
  rename of priority processing) and are priced with the official per-model Fast rates — 2.0×
  standard for Astra and the 5.6 Sol/Terra/Luna family, 2.5× for `gpt-5.5`, while `flex` is
  0.5×. The rates come from `data/tier_pricing.json` (override with
  `HARNESCOPE_TIER_PRICING_FILE`) and are declared as API-equivalent USD, not the ChatGPT
  subscription credit multipliers. Models without a public Fast price stay at the standard
  price and report `tier_priced: false`.
- Labels that no public source prices now go through an auditable alias table
  (`data/model_aliases.json`, override with `HARNESCOPE_ALIASES_FILE`): `codex-auto-review`
  is priced as `gpt-5.5` and flagged `assumed: true`, while `gpt-reserve` is deliberately left
  unpriced (`$0.00*`) instead of being guessed.

### Fixed

- Token metering now follows the cumulative `total_token_usage` delta instead of summing the
  per-turn `last_token_usage`: 53% of session files repeat a cumulative snapshot, and some
  subagent files start with an inherited parent-history snapshot (the largest at 14,051,760
  tokens with a zero delta), so the old path over-counted and double-counted replayed
  prefixes. The first snapshot is counted at its own delta, a mid-file jump larger than that
  turn's delta is capped by it, and a cumulative drop (context compaction) or a missing
  cumulative field falls back to `last_token_usage`.
- Cross-day long sessions: file admission now also includes rollout files whose path date is
  outside the window but whose mtime is at or after `--since`. Previously those turns were
  dropped — 62,780,912 tokens and $66.75 in the fixed verification window
  (`--since 20260911 --until 20260912`). With the fix the per-(day, model) token ledger
  matches ccusage exactly (both 1,830,205,933 tokens, difference 0).
- Pagination merge: a merged session now accumulates `tiers` alongside `models`, so the tier
  totals agree with the model totals again (the previous mismatch was 4.81M gross input
  tokens).
- `sessions/` and `archived_sessions/` copies of the same session are now de-duplicated
  (`sessions/` wins) instead of being summed into one session.
- Pricing: a missing or explicitly zero `cacheReadCostPerMillion` now falls back to that
  model's input price instead of charging cached reads at $0 (33.6% of the effective table has
  no cache-read price).

### Documentation

- Both READMEs document the cumulative-delta metering rules (including the cross-day file
  admission), the cache-read / service-tier / alias pricing behaviour, and the fixed-window
  reconciliation with ccusage (identical tokens, +$51.40 cost because ccusage does not apply
  the `gpt-6-astra` Fast rate).

## [0.1.0] - 2026-09-21

### Added

- **CLI** `harnesscope`: parses local Codex rollout session files and aggregates token
  usage by session / subagent / day / model, rendered as rich terminal tables and charts.
- **More accurate metering**: per-turn `last_token_usage` deltas instead of the
  `total_token_usage` counters, which context compaction can leave far below the real totals.
- **Flexible aggregation**: combinable `--by-day` / `--by-model` (including day x model),
  family-tree and per-file views, and filters for time range, entry type, model, session,
  parent and archived sessions. `--since` / `--until` accept both explicit and compact
  (`20260912-1610`) time formats.
- **Cost estimation**: per-model cost from a pricing table, with a built-in offline table
  shipped in the package (`src/harnesscope/data/pricing.json`). Unknown models are still
  counted, priced at $0 and flagged in the output.
- **Charts**: `--chart pie|bar|area|line` with `--metric cost|input|cache|output|total`.
  - Real-image rendering (`matplotlib` -> PNG -> terminal) in terminals that support a
    graphics protocol (kitty TGP / Sixel), with a colored half-cell fallback elsewhere.
    Requires the optional `[image]` extra; `textual-image` requires Python >= 3.12.
  - ASCII charts (plotext + termcharts) when `[image]` is not installed, output is
    redirected, or `--ascii` is passed.
- **Chart rendering mode override**: the `HARNESCOPE_IMAGE_MODE` environment variable
  (`auto` (default) | `tgp` | `sixel` | `halfcell` | `ascii`), for terminals whose
  auto-detection misbehaves. Invalid values fall back to `auto`.
- **Table metric columns**: API `calls` and `cost per call`.
- **Self-description and self-check**: expanded `--help` (also `/?`, `-?`, `help`) covering
  examples, semantics, exit codes and data sources; a machine-readable `--schema` contract
  generated from the argparse definition; and `--doctor` for environment diagnostics
  (data sources, pricing, real-image capability, terminal mode, CJK fonts), with `--json`
  for structured output.
- **Optional pricing refresh**: `--update-pricing` (source selectable via
  `--pricing-source models.dev|litellm`) downloads a public pricing table and writes it to
  the user cache (`~/.cache/harnesscope/pricing.json`, override with `HARNESCOPE_CACHE_DIR`).
  This is the only code path that uses the network, and it never runs implicitly.
- **Machine-readable output**: `--json` emits per-session records including per-model
  details. Data is written to stdout only; diagnostics and errors go to stderr.
- **Environment overrides**: `HARNESCOPE_SESSIONS_DIR`, `HARNESCOPE_ARCHIVE_DIR`,
  `HARNESCOPE_PRICING_FILE`, `HARNESCOPE_CACHE_DIR`, `HARNESCOPE_IMAGE_MODE`.
- **Typing**: a `py.typed` marker so downstream type checkers use the bundled annotations.
- **Engineering and community baseline**: GitHub Actions CI (Python 3.10-3.13 matrix plus a
  ruff/mypy job), `ruff.toml`, `mypy.ini`, this changelog, CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, GitHub issue forms, a pull request template and `.editorconfig`.

### Changed

- ASCII chart titles and legends are transliterated to ASCII: plotext lays out one column
  per character, so wide CJK characters used to misalign into garbage. Real-image and
  half-cell modes keep CJK labels.
- Chart raster size now follows the terminal's reported pixel size (avoids upscaling the
  PNG and blurring thin lines), crowded x-axis labels are thinned out, and axis ticks use
  compact forms such as `120K` / `3.4B`.

### Fixed

- Test fixtures no longer hard-code UTC timestamps: they follow the host time zone, so the
  suite passes on runners in any zone (it failed on every CI Python version before).
- Real-image charts: rotated x-axis labels no longer push into the plot area, and legends
  plus edge margins now keep all content inside the canvas on narrow rasters and on hosts
  without a CJK font (both surfaced by the first CI run and covered by
  `test_charts_survive_without_cjk_font`).

### Documentation

- README reworked for the public release (English primary, Chinese translation alongside):
  installation, usage, time-format and table-column semantics, chart rendering modes and
  terminal examples.
