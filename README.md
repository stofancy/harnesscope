# codex-usage

[![CI](https://github.com/stofancy/codex-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/stofancy/codex-usage/actions/workflows/ci.yml)
[![Python](https://img.shields.io/badge/python-3.10%2B-blue)](pyproject.toml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**English** · [中文](README.zh-CN.md)

Local personal usage analytics for **Codex, Claude, OMP (oh my pi), and DSH (deepseek harness)**. Run `codex-usage --web` on a PC to explore usage, estimated costs, time trends, and contributing dimensions in a browser. Existing Codex terminal reports, charts, and JSON remain available.

Charts default to **native images**: [matplotlib](https://matplotlib.org/) renders a PNG and [textual-image](https://github.com/lnqs/textual-image) puts it into the terminal. Terminals with a graphics protocol (kitty / Sixel) show the image itself, others show colored half-blocks; this needs the optional image dependencies and a terminal on stdout. Without the extra, when stdout is redirected to a pipe, or with `--ascii`, charts fall back to ASCII art ([plotext](https://github.com/piccolomo/plotext) + [termcharts](https://github.com/zvovcahovo/termcharts)).

Source files remain read-only. The web workbench maintains its own rebuildable SQLite statistics index and serves bundled assets on loopback; ordinary queries need no external network access. `codex-usage --update-pricing` explicitly downloads public prices. Cost estimates use the built-in table, local price cache, and `CODEX_USAGE_PRICING_FILE` overrides — see [Pricing](#pricing). The web workbench displays known estimated cost and unpriced coverage separately. Actual bills are unavailable. Legacy Codex reports retain their `$0*` display convention for unpriced models; that marker means unknown cost.

> The human-readable CLI output (table headers, chart titles, `--help`, `--doctor`) is currently Chinese; the screenshots below are real output. The machine-readable surface (`--json`, `--schema`, `--doctor --json`) has a language-neutral, documented contract.

## Why codex-usage

- **One local web workbench for four harnesses.** Compare sources, models, projects, sessions, purposes, and other recorded dimensions; source coverage exposes missing or malformed data.
- **Dashboard and usage records.** Explore aggregated consumption, rates, cache, timing and contributors; open a separate ledger for requests, sessions, turns, models or harnesses. Both share the time/filter context and support light and dark themes.
- **Cost and efficiency with explicit limits.** Known estimated cost, missing prices, cache rates, cost per call, and cost per million tokens carry their accounting scope. Logged usage provides no evidence of output quality or model value for money.
- **Existing Codex CLI retained.** Session/subagent/family reports, filters, charts, TPS, and JSON continue to serve command-line workflows. `--schema` describes the command contract and `--doctor` diagnoses its environment, including four-source path discovery. Path existence alone does not establish parsing coverage.
- **Local data stays local.** No telemetry or source-file writes; the web server and statistics index stay on this machine. See [SECURITY.md](SECURITY.md) for the HTTP and local-process boundary.

The [2026-09-27 research](docs/research/2026-09-27-harness-usage-proposal.md) preserves the earlier competitor comparison and the current implementation baseline. CodeBurn and New API informed the dimensions, filters, and timelines; the browser interface has its own design.

## Install

Requires **Python ≥ 3.10**.

```bash
uv tool install codex-usage                                          # latest published package
uv tool install "git+https://github.com/stofancy/codex-usage[image]" # + native image charts
```

The workbench is currently in the **Unreleased** source version. To install this checkout,
build its bundled frontend before installing the Python package:

```bash
cd web
npm ci
npm run build
cd ..
uv tool install --force .
codex-usage --web
```

For the development and browser-validation workflow, use Node.js 22.x >=22.22.3 or >=24.8.0 and npm. The installed workbench runs with Python only.

The optional `[image]` extra pulls in matplotlib and textual-image, and `textual-image` requires **Python ≥ 3.12**; on 3.10/3.11 charts stay in ASCII mode and everything else keeps working. Without the extra, when stdout is not a terminal, or with `--ascii`, charts automatically fall back to ASCII art.

## Web workbench

```bash
codex-usage --web
codex-usage --web --port 8766   # choose a local port
```

Open the local address printed by the command (default `http://127.0.0.1:8765`). Startup begins a background source scan; use the workbench refresh control to scan subsequent changes. Keep the foreground process running while browsing; stop it with Ctrl-C to release the port. Closing a browser tab leaves the process running.

The web entry uses a shared multi-source event query layer and its own statistics index. The existing report flags below continue to read Codex sessions. The CLI reports have not been migrated to a four-source output contract.

The Dashboard starts with estimated cost, tokens, model calls and turns. The main
consumption trend sits beside a model/project/harness ranking; rate, cache, timing and
aggregated tool panels offer additional analysis. Panel menus hold metric, grouping,
area/line/bar and member choices. Chart selection narrows the shared window; the
range-return control restores it. Choose light or dark mode in the header; the browser
remembers the selection.

Inline time fields support relative expressions such as `-18h` and `-2days`, a fixed
start **until now**, and fixed historical start/end times. Each field accepts an
expression or a concrete time and has a calendar picker with second precision;
mix them freely, then apply the range. Display and bucketing use
the local timezone; future bounds are rejected. Segmented buttons select the chart interval directly. Rolling
ranges resolve again after refresh; fixed historical ranges and chart zooms remain fixed.
An explicit automatic-refresh switch and interval control scan source changes before
updating the view. Refresh is off by default, does not overlap, and pauses in background
tabs or while editing the time range. It runs only when the end expression is **now**;
fixed or past-relative ends disable it, while keeping the saved preference for returning
to now. Manual refresh remains available for late historical records. Scans check file
metadata and skip unchanged files; appendable logs resume at the saved offset, while
changed DSH files and replaced/truncated logs are reread. The resulting index is queried
again for the selected window. Time expressions, refresh interval, filters and panel
choices survive reloads. Source health expands in its own section at the bottom.

Overview changes compare the immediately preceding **equal-length window** with the
same filters; the comparison dates are shown above the totals. A 48-hour range ending
now compares against the previous 48 hours. Missing estimates in either window are
shown with their request counts; known subtotals do not imply a complete cost change.

All panels and usage records share the range, chart interval and global filters.
Combine harness/model/project/provider/purpose filters; additional conditions cover
agent type, run mode and session. Codex modes display Standard, Fast or Not recorded.
Local chart changes and ledger pagination reload their own data.

The separate **用量明细** view lists individual requests or groups them by session,
turn, model or harness. It shows uncached input, cache hits, output, cache writes,
estimated cost and reliable timing. Response and turn TPS remain separate; missing
timing stays unknown. Request timestamps determine membership before grouping;
sorting applies to all matching rows before pagination. Harness, project and visible
short IDs distinguish sessions, and drilldown preserves the filter context. Missing
end records remain unknown; historical open turns require evidence of activity within
the selected window. Missing prices and components retain their indicators.

### Source discovery and coverage

| Harness | Default source | Override |
|---|---|---|
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions` | `CODEX_HOME` sets the web source root |
| Claude | `~/.claude/projects/**/*.jsonl` | `CLAUDE_CONFIG_DIR` |
| OMP | `~/.omp/agent/sessions/**/*.jsonl` | `OMP_SESSIONS_DIR`, or `PI_CODING_AGENT_DIR` followed by `/sessions` |
| DSH | `~/.dsh/sessions` | `DSH_HOME` sets the DSH root |

The web statistics index is `~/.cache/codex-usage/usage.sqlite3`; `CODEX_USAGE_CACHE_DIR`
changes that directory. Legacy Codex reports retain their `CODEX_USAGE_SESSIONS_DIR` and
`CODEX_USAGE_ARCHIVE_DIR` overrides.

Claude reads assistant usage and advisor iterations, including recorded cache read/write
components. Provider and per-call timing are unavailable when absent from the logs;
Claude's session-level cost summary is not added to event costs. OMP includes assistant
and `model_usage` records with their recorded purposes and model timing. DSH reads the
highest session generation, including current compact v4 streams, and usage-bearing
assistant attempts; title/search request logs with no settled usage cannot contribute tokens.
The bundled Python `zstandard` dependency reads compressed DSH sources; no separate
system decompression package is required. An unsupported latest generation appears as
a source read failure; an older generation is not silently substituted.

Coverage shows scan state, parsing warnings/errors, and missing prices. Partial coverage
keeps usable statistics available and identifies the excluded records. DSH interrupted or
error turns retain recorded tokens while being excluded from complete-turn TPS; Claude
local all-zero `<synthetic>` messages are excluded from API-call counts. Usage cost recorded
by a source is an estimate; it is not a provider invoice. Parent relationships and copied
history are used only where the source supplies evidence. The index and API exclude
conversation bodies, prompts and credentials.

### Shared analytics JSON

```bash
codex-usage --analytics --query 'harness=codex&group_by=model&metric=tokens'
```

`--analytics` refreshes the statistics index, queries the same multi-source layer as the
browser and emits JSON. Specify its filters through `--query`; legacy `--since`,
`--model`, and report/layout flags are rejected with this entry.

| Query parameter | Accepted values / meaning |
|---|---|
| `start`, `end` | Both required together; ISO 8601 with UTC offset; start inclusive, end exclusive |
| `timezone` | IANA timezone for buckets; default `UTC` |
| `bucket` | `auto`, `second`, `5second`, `10second`, `30second`, `minute`, `5minute`, `15minute`, `hour`, `day`, `week`, `month` |
| `group_by` | One to three comma-separated dimensions |
| Dimensions / filters | `harness`, `model`, `provider`, `project`, `agent_type`, `purpose`, `service_tier`, `session`; repeated values select alternatives within a dimension |
| `metric` | `cost_usd`, `tokens`, `calls`, `input`, `output`, `cache_read`, `cache_write`, `cache_hit_rate`, `cost_per_call`, `cost_per_mtok`, `tpm`, `rpm`, `throughput_tps`, `rps` |
| `member` | Repeat to select trend members from the current grouping |

Eight dimensions include agent type and service tier. Source-reported totals and their
coverage are listed separately from the sum of recorded token components; extra components
and TTL/reasoning subsets are not added twice.

Cost-per-call and cost-per-million-token ratios are unknown if any selected call is
unpriced. Cache hit rate is unknown when cache-write accounting is incomplete. Counts
use recorded components; zero-event buckets and missing data remain distinct. TPS samples
are separated by harness and timing definition. Complete response semantics and comparison
rules are documented in [the workbench API](docs/workbench-api.md).

The local API exposes GET `/api/status`, `/api/analytics`, `/api/sessions`,
`/api/sessions/{harness}/{sid}`, and `/api/turns`. A turn is located through
`/api/turns/detail?harness=...&session_id=...&turn_id=...`; URL-encode each parameter value. Session and turn lists accept `offset` and `limit` (1–200). Turn lists also accept
`sort=start|cost_usd|tokens|duration|calls|tool_calls` and `order=asc|desc`;
missing values sort last, and sorting happens before pagination.
POST `/api/refresh` with `Content-Type: application/json` starts an explicit background
scan. Query responses identify their snapshot; reading them does not rescan source files.

### Rates, timing, turns and tools

| Metric | Denominator and scope |
|---|---|
| TPM / RPM | Recorded tokens / model-call counts divided by covered seconds, multiplied by 60 |
| Average tokens/s / RPS | Recorded tokens / model-call counts divided by covered seconds, including idle time |
| Timed output TPS | Output tokens divided by reliable recorded sample durations, separated by harness and timing kind |
| Turn P50 / P95 | Duration percentiles from closed turns fully inside the window with recorded start/end times; exact/inferred sample counts are retained |

Rate buckets use the actual intersection with the global time window, including partial
first/last slices. `auto` resolves to roughly 120 or fewer points, with minute as its
finest automatic slice; explicit fine slices are limited to 2000 buckets. Rate charts
show averages of persisted usage records. Provider limits and instantaneous token streams
are unavailable from these records. Reliable timing samples retain their complete duration and enter their completion
bucket; missing timing stays unknown.

Turn lists distinguish sessions, turns, model calls and tool calls. A turn may contain
multiple models and tools. Window metrics retain the matching events within the selected
range. Closed turns fully inside the window with recorded calls provide full-turn recorded
subtotals and per-turn averages. Iteration-derived boundaries remain marked `inferred` and
retain their data, with exact/inferred sample counts shown. Known-subtotal averages use these same eligible turns as their denominator and expose
component/price coverage; complete-value averages remain unknown when components or
prices are missing. An entirely unpriced cost remains unknown. Running, failed, interrupted and
truncated turns retain their recorded identity and window subtotal. Full-turn recorded
metrics remain within the active model-call filters and cannot establish that omitted
provider calls or charges were fully captured.

Tools expose only name, call identity, status and timestamps. Counts are deduplicated;
partial/unknown tool coverage keeps the known subtotal and leaves total counts and
per-turn ratios unknown. Model/provider/purpose/tier filters select matching model calls
and their turns; tools still describe all recorded tool calls of those selected turns.
Turn details label calls inside/outside the global window and preserve missing prices.
No tool arguments, result bodies, conversation text or credentials enter the index/API.

## Codex CLI usage

```bash
codex-usage                                          # today's sessions (incl. subagents, one row per session)
codex-usage --by-model                               # aggregate by model (one row per model, with session count)
codex-usage --by-day --since 2026-09-04              # aggregate by day
codex-usage --by-day --by-model --since 2026-09-04   # day × model
codex-usage --family --parent 01a083b7 --since 2026-09-09     # family tree: main thread + its subagents
codex-usage --family --by-model --since 2026-09-09            # family × model
codex-usage --raw --type subagent                    # file granularity: one subagent file per row
codex-usage --since "2026-09-11 09:00" --until "2026-09-11 14:00"   # minute-precision window
codex-usage --by-model --since 20260912-161023       # compact time: same as 2026-09-12 16:10:23
codex-usage --by-model --since 20260912-16           # compact time: same as 2026-09-12 16:00
codex-usage --chart pie                              # pie: cost share per model
codex-usage --chart bar --by-day --by-model --metric total   # stacked bars
codex-usage --chart area --by-day --metric cache     # area: daily cache reads
codex-usage --chart bar --by-day --ascii             # force ASCII art (native image is preferred in a terminal)
codex-usage --json                                   # machine-readable output (per-model details included)
codex-usage --help                                   # self-documenting help (/? , -? , help are equivalent)
codex-usage --schema                                 # machine-readable contract (JSON)
codex-usage --doctor                                 # environment self-check (data source / pricing / image support)
codex-usage --update-pricing                         # explicit external price download
```

### Time formats

`--since` / `--until` accept two forms, and you can mix them:

| Form | Example | Meaning |
|---|---|---|
| Explicit | `2026-09-12`, `2026-09-12 16:10`, `2026-09-12T16:10:23` | conventional format |
| Compact | `20260912`, `20260912-16`, `20260912-1610`, `20260912-161023` | `YYYYMMDD[-HH[MM[SS]]]`; the separator may also be a space, `.` or `T`, and the time part may be written `16:10:23` |

Missing parts are filled with 0 for `--since` (`20260912-16` → 16:00:00) and with the maximum for `--until` (→ 16:59:59; a bare date → 23:59:59).

### Table columns

| Column | Meaning |
|---|---|
| Net input / Cache read / Output | token counts; net input = gross input − cache read |
| Hit rate | cache read ÷ gross input (gross input includes cache read) — the API's `cached_tokens / input_tokens` ratio; aggregates are **weighted** (Σ cache read ÷ Σ gross input), never an average of per-row percentages; shows `-` when there is no input at all |
| Total tokens | net input + cache read + output |
| TPS | End-to-end output tokens/second: summed output (including reasoning) divided by summed duration of complete single-model turns, including tools and waiting. Requires matching `task_started` / `task_complete` within the selected window. Missing timing shows `-`; session and model JSON `tps` is `null`. In-progress and mixed-model turns are excluded from TPS. |
| Calls | number of API calls (`token_count` turns, attributed to the model in effect at that time) |
| Cost/call | cost ÷ calls; `-` when there are no calls |
| Per 1M tokens | cost ÷ total tokens × 1e6 — the blended effective unit price after cache discounts; aggregates are **weighted** (Σ cost ÷ Σ tokens), `-` when there are no tokens, `*` when a model is unpriced |
| Cost | converted with the pricing table; a model with no price counts as $0 and is marked `*` |

### Metering

Token counts are derived from the rollout's cumulative `token_count.total_token_usage` snapshots, not from the per-turn `last_token_usage` values:

- A turn adds the **delta of the cumulative counters** (current snapshot − previous snapshot), attributed to the model that the turn's `turn_context` reported.
- A **repeated snapshot** (no advance) adds nothing, so replayed events are not counted twice.
- The **first snapshot of a file** may be an inherited parent-thread history; only its own `last_token_usage` is counted, so an inherited prefix whose `last` is 0 contributes nothing.
- If the cumulative counters **drop** (context compaction resets them) or a snapshot carries no cumulative value, that turn falls back to `last_token_usage`.
- File admission is not limited to the date directories inside the window: files whose path date is older but whose **mtime is at or after `--since`** are scanned as well, so a long session that keeps writing past midnight is not dropped; turns are then filtered by their event timestamps.

`--json` exposes this for auditing: a per-session `metering` object (`resets`, `fallbacks`, `delta_sum`) and a per-model `tiers` breakdown.

### Semantics

| Kind | Options | Notes |
|---|---|---|
| Aggregation | `--by-day` `--by-model` | row granularity; can be combined into day × model |
| Structure | `--family` `--raw` | family tree / file-granularity entities |
| Filters | `--since` `--until` `--type` `--model` `--session` `--parent` `--archived` | only narrow the range, never change row granularity |
| Charts | `--chart pie\|bar\|area\|line` `--metric cost\|input\|cache\|hit\|output\|total\|per_mtok` `--ascii` | data comes from the aggregation dimension; `--ascii` forces ASCII art; `--metric hit` is the cache hit rate (a 0–1 ratio) and cannot be combined with `--chart pie` |
| Output | `--json` | session-level JSON Lines with per-model details (including call counts), compatible with the other options |
| Self-description | `--schema` `--doctor` | machine-readable contract / environment self-check, taking precedence over other options |

In legacy Codex reports, an unpriced model keeps its tokens, displays `$0*`, and is listed below the table. This is an unknown-cost marker. The web workbench uses explicit unknown/partial cost states.

## Pricing

Token counting is always local; only the cost column needs prices. `codex-usage` ships a **built-in public price snapshot** (2089 priced models, including official OpenAI Sol/Luna rates verified on 2026-09-30), so cost estimation works offline right after install. Three layers are merged by `modelId`, with higher-priority entries overriding lower ones:

| Priority | Source | Role |
|---|---|---|
| Low | built-in table (`src/codex_usage/data/pricing.json`) | baseline coverage of public models |
| Middle | user cache `~/.cache/codex-usage/pricing.json` (`CODEX_USAGE_CACHE_DIR` overrides the directory) | written by `--update-pricing` |
| High | `CODEX_USAGE_PRICING_FILE` (defaults to `~/.cc-switch/model-pricing.json`) | your own/private prices |

A layer that is missing, empty or corrupt is simply skipped; if all three are unusable, tokens are still counted and the cost shows `$0.00*`. The format is cc-switch compatible — `{"models":[{"modelId": …, "inputCostPerMillion": …, "cacheReadCostPerMillion": …, "outputCostPerMillion": …}]}` — so an existing cc-switch table keeps working and only overrides the entries it defines.

Refresh the cache from a public channel with an explicit external download:

```bash
codex-usage --update-pricing                         # models.dev (default)
codex-usage --update-pricing --pricing-source litellm
```

Model names found in sessions are matched exactly, then normalized (case, provider prefix, date and `-latest` suffixes, common aliases), then by longest prefix — so `gpt-5.1-codex-2025-11-13` and `openrouter/openai/GPT-5.1-Codex` both resolve to `gpt-5.1-codex`.

Three details shape the resulting numbers:

- **Cache reads without a price.** About a third of the effective table (33.6%) has no `cacheReadCostPerMillion`. For those models, cached reads are charged at the model's **input price** instead of $0 — a deliberate upper bound (real cache-read prices are around 10% of input), so the estimate can over-count but not silently under-count.
- **Service tiers.** Codex records which tier a turn ran under. `priority` and `fast` are the same tier (OpenAI renamed priority processing to Fast) and are priced with the official per-model Fast rates — 2.0× standard for `gpt-6.1-sol`, GPT-6 Sol/Luna/Astra, and the 5.6 Sol/Terra/Luna family, 2.5× for `gpt-5.5` — while `flex` is 0.5×. Prices are **API-equivalent USD**, not the ChatGPT subscription credit multipliers (a different rate card). Models without a public Fast price (for example `gpt-5-codex`) stay at the standard price and report `tier_priced: false`.
- **Labels with no public price.** `codex-auto-review` has no price fields in any public source, so it goes through an auditable alias table (`src/codex_usage/data/model_aliases.json`) that maps it to `gpt-5.5` and flags the mapping `assumed: true` (following ccusage's dated fallback table and a three-way token reconciliation). `gpt-reserve` has no public price from any source, so it stays `$0.00*` instead of being guessed. The alias table and the tier price table can be replaced with `CODEX_USAGE_ALIASES_FILE` and `CODEX_USAGE_TIER_PRICING_FILE`.

The web workbench accounts for cache writes, including Claude 5-minute and 1-hour TTL subsets. Explicit write prices take precedence; verified Claude models can use the official 1.25× / 2× input-price rules when those prices are absent. Missing required components or rates keep that event cost unknown. See [cache-write pricing](docs/pricing.md#11-多源工作台缓存写计价) for the verified model scope and assumptions.

Legacy CLI caveats: the built-in table is a snapshot (with an `updated` timestamp); context-tier prices (`>200k`), cache-write pricing and per-reseller markups are not modelled in those reports. Unpriced models display `$0.00*`. `CODEX_USAGE_PRICING_FILE` can align estimates with custom rates; it does not supply actual invoices. Sources, field mapping and licenses are documented in [docs/pricing.md](docs/pricing.md).

### Reconciliation with ccusage

Recomputed on 2026-09-21 for the fixed window `--since 20260911 --until 20260912`:

| | codex-usage | ccusage | Difference |
|---|---|---|---|
| Tokens, per (day, model) | 1,830,205,933 | 1,830,205,933 | **0** |
| Cost | $1,116.04 | $1,064.64 | **+$51.40** |

The token ledgers match entry by entry once cross-day files are included (without the backfill described in [Metering](#metering) we were missing 62,780,912 tokens and $66.75 in this window). The cost difference is entirely `gpt-6-astra`'s Fast-tier add-on, which ccusage does not apply to its 292 priority turns; our standard-price total for the same window is $1,061.45, and `ccusage − our standard price = +$3.19` is exactly the Fast add-on for `gpt-5.6-luna` and `codex-auto-review`, which ccusage does apply. 09-11, which has no priority turns, is identical to the cent ($210.75). Method, per-file recomputation and the full ledger: [docs/metering-verification.md](docs/metering-verification.md).

## Self-describing and self-checking (for humans and agents)

The tool explains itself: how to use it, what it can output, and whether the current environment is healthy — no external documentation required.

`codex-usage --help` (`/?`, `-?` and `help` are equivalent) closes with a structured guide: the help entry points, followed by four parts — examples, semantics, output & exit codes, and data sources & environment variables. `codex-usage --schema` is the JSON version of the same contract; its option list is generated directly from the argparse definition, so it cannot drift from the implementation:

```bash
codex-usage --schema | jq '.options[] | select(.flags | index("--chart"))'
codex-usage --schema | jq '.json_output.fields'   # meaning and unit of every --json record field
codex-usage --json --since 20260910 | jq -c '{id:.session_id,total:.total_tokens,calls}' | head -3
```

`codex-usage --doctor` (add `--json` for the structured form) inspects the environment: whether the session and archive directories exist and how many rollout files they hold, which pricing source is in effect, how many models it provides and what share of them lacks a cache-read price, whether image rendering is available and which tier is active, and whether a CJK font is installed. Actionable hints are listed separately, and `ok` says whether everything is fine.

![codex-usage --doctor](docs/shots/doctor.png)

```text
$ codex-usage --doctor
codex-usage 0.1.0  |  Python 3.14.7  |  Linux-...

会话数据   /tmp/codex-usage-doc-fixture/sessions  存在，32 个 rollout 文件（最近 2026-09-13 23:36）
归档数据   /tmp/codex-usage-doc-fixture/archived_sessions  存在，0 个 rollout 文件
定价       内置表+自定义文件 /tmp/codex-usage-doc-fixture/model-pricing.json，2086 个模型（数据 2026-09-13），其中 33.6% 缺缓存读价（按 input 价回退）
图表渲染   彩色半块（matplotlib 3.11.2 + textual-image 0.13.2，光栅 119×84，档位 auto（探测为 彩色半块））
中文字体   Noto Sans CJK SC

结论: 一切正常
```

Convention: data goes to stdout only and messages/errors go to stderr only, so `codex-usage --json … | jq` is never interrupted by noise. Exit codes are `0` success, `1` usage or runtime error, `2` argument parsing error, and `141` when the consumer of the pipe closes early.

## Charts

`--chart` draws from the aggregation dimension: a pie is per model; a bar chart is per day / model / day × model (day × model stacks automatically); area and line charts are daily trends (add `--by-model` for multiple series with a legend). `--chart` does not combine with `--family`, and `--chart pie` does not combine with `--by-day` (a pie is per model). `--json` takes precedence over `--chart`.

Rendering picks one of three tiers from the environment:

| Environment | Rendering |
|---|---|
| Terminal supports a graphics protocol (kitty / Ghostty / WezTerm / Konsole / foot / xterm-sixel, …) and `[image]` is installed | matplotlib renders a PNG and the terminal shows it natively (CJK labels render correctly) |
| No graphics protocol, but `[image]` is installed | the same PNG is converted to colored half-blocks (shapes and colors recognizable, text coarse) |
| `[image]` missing, stdout redirected, or `--ascii` | plotext / termcharts ASCII art |

The image resolution follows the raster size the terminal can display, so thin lines are not washed out by upscaling a PNG tenfold; x-axis labels are thinned out when there are too many, and axis ticks use short forms such as `120K` or `3.4B`.

All three tiers on the same window (`--since 2026-09-04 --until 2026-09-13 --chart bar --by-day`):

| Tier | Result |
|---|---|
| Native image (kitty TGP / Sixel) | ![kitty native image](docs/shots/chart-bar-kitty.png) |
| Colored half-blocks (terminal without a graphics protocol) | ![colored half-blocks](docs/shots/chart-bar-halfcell.png) |
| ASCII art (`--ascii`, no `[image]`, or redirected stdout) | ![ASCII art](docs/shots/chart-bar-ascii.png) |

The native image is matplotlib's original figure with crisp text. Half-blocks squeeze two pixels into one character cell: the shape and the palette survive, the text is coarse. ASCII art is the smallest and the most portable. In the ASCII tier the title and the legend are automatically transliterated to ASCII (plotext lays out 1 column = 1 character, so wide CJK characters would be garbled); the native-image and half-block tiers keep the original labels.

### Forcing a tier

Auto-detection occasionally gets it wrong (for example a terminal claims graphics-protocol support but renders badly), so an environment variable can override it:

```bash
CODEX_USAGE_IMAGE_MODE=halfcell codex-usage --chart bar --by-model   # fall back to colored half-blocks
CODEX_USAGE_IMAGE_MODE=tgp      codex-usage --chart bar --by-model   # force the kitty graphics protocol
CODEX_USAGE_IMAGE_MODE=ascii    codex-usage --chart bar --by-model   # same as --ascii
```

Values are `auto` (default, auto-detect) | `tgp` | `sixel` | `halfcell` | `ascii`; an invalid value is treated as `auto`. Both the active tier and the auto-detected one are reported by `codex-usage --doctor`, and agents can read them from `chart_rendering.env` in `codex-usage --schema`.

Other views (per-model cost table, day × model stacked bars, cost-share pie, daily cost area chart):

| Table (per model) | Stacked bars (day × model) |
|---|---|
| ![per-model table](docs/shots/table-bymodel.png) | ![day x model stacked bars](docs/shots/chart-bar-stacked-kitty.png) |

| Pie (native image) | Area (native image) |
|---|---|
| ![cost share pie](docs/shots/chart-pie-kitty.png) | ![daily cost area](docs/shots/chart-area-kitty.png) |

| Chart | Data | Notes |
|---|---|---|
| `pie` | by model | share of each model (cost by default, change with `--metric`) |
| `bar` | day / model / day × model | day × model stacks automatically |
| `area` / `line` | daily trend | add `--by-model` for multiple series with a legend |

## Development

```bash
uv venv && uv pip install -e ".[image,test]"   # optional native images + Python test dependencies
.venv/bin/python -m pytest tests/ -q             # unit + CLI end-to-end (synthetic fixtures, no local data)
```

The unified Dashboard iteration uses local browser scenarios in [`tests/e2e`](tests/e2e/README.md).
Existing unit tests retain their prior coverage. New interactions and their numbers are
validated against isolated four-source fixtures through the application service.

```bash
npm --prefix web ci
E2E_TELEMETRY_DISABLED=1 npm --prefix web exec -- e2e-web install chromium
npm --prefix web run build
npm --prefix web run test:e2e
# optional visible browser
npm --prefix web run test:e2e:headed
```

The pinned runner is `e2e@0.17.0` with `@e2e-dev/web@0.12.0`; configuration lives in
[`e2e.config.ts`](e2e.config.ts). It launches an isolated service on a random loopback port,
with temporary source roots, index and pricing. Runs use no agent, model, account login or
personal logs. Telemetry is disabled. Ignored `.e2e/` output contains `report.json`,
`summary.md`, traces and screenshots; review it locally and keep private identifiers out
of public evidence. The current iteration's acceptance status is recorded in the
[proposal](docs/research/2026-09-27-harness-usage-proposal.md).

The final second-round browser run passed **4/4 scenarios** in **14.99 s** on desktop
Chromium (1600×1100), run `01a10b08-e11f-7763-9de5-f9d51c1a2e58`. It covers the continuous
journey, partial-bucket rates/cache/timing and per-turn values, details plus append/dedup
updates, and relative refresh / fixed history / range-mode restoration. These results
apply to the isolated fixtures and scenarios above; the iteration added no unit/component
tests. They do not establish complete historical or personal-source coverage.

Data paths can be overridden with environment variables: `CODEX_USAGE_SESSIONS_DIR`, `CODEX_USAGE_ARCHIVE_DIR`, `CODEX_USAGE_PRICING_FILE`, `CODEX_USAGE_CACHE_DIR`, `CODEX_USAGE_TIER_PRICING_FILE`, `CODEX_USAGE_ALIASES_FILE`.

The screenshots in `docs/shots/` are generated from synthetic fixtures (public model names and public prices) by [`tools/make_doc_shots.py`](tools/make_doc_shots.py); no real session data is involved:

```bash
.venv/bin/python tools/make_doc_shots.py --clean
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute and [CHANGELOG.md](CHANGELOG.md) for released changes.

## Known limitations

- Multi-source analysis is available through `--web`; the existing terminal/JSON report path remains Codex-specific.
- Source logs only expose recorded usage. Missing provider, project, agent, tier, or timing fields remain unknown; local estimates do not establish actual charges or output quality.
- The local web server has no user authentication. Other processes and accounts on the same machine can read its statistics while it runs. It is intended for one personal machine.

- The legacy CLI consumes Codex rollout files; usage absent from those files cannot be recovered by that report path.
- Legacy CLI time filtering uses each event's timestamp (UTC → local time): a session spanning the window only contributes the turns inside it, and legacy day grouping uses the session's activity start. The web query layer buckets by usage-event time.
- Legacy CLI daily totals can still differ from other tools' day bucketing (it groups by the session's activity start and filters turns by their event timestamps), but on a fixed window the per-(day, model) token ledger matches ccusage exactly — see [Reconciliation with ccusage](#reconciliation-with-ccusage); the cost difference there comes from Fast-tier handling, not from tokens.
- Native image charts depend on textual-image probing the terminal's graphics support: tmux needs passthrough enabled, and a few terminals don't report their cell pixel size, in which case a default raster is used and the displayed size may differ slightly. Use `--ascii` if you don't want native images.
- The human-readable output is Chinese-only; the JSON contracts are language-neutral.

## License

[MIT](LICENSE)
