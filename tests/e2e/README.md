# Dashboard browser acceptance

These tests use [TesterArmy e2e](https://github.com/tester-army/e2e), its Chromium
Playwright engine, and exact assertions. No agents, models, credentials, or login
are configured. Telemetry is disabled by the npm script. Only synthetic usage
records enter the browser/report/trace.

Requirements: Node >=24.8 (or >=22.22.3 on Node 22), uv, npm, and Chromium's OS
libraries. The npm lock fixes `e2e` at 0.17.0 and `@e2e-dev/web` at 0.12.0.

From the repository root:

```bash
npm --prefix web ci
E2E_TELEMETRY_DISABLED=1 npm --prefix web exec -- e2e-web install chromium
npm --prefix web run build
npm --prefix web run test:e2e
```

Optional visible browser: `npm --prefix web run test:e2e:headed`.
The sole configuration is `e2e.config.ts` in the repository root; dependencies
remain in `web/node_modules`, shared by the config and test file imports.
The runner allocates a fresh loopback port, starts the actual Python HTTP service
through `uv run`, and stops it after the suite. It never reuses the personal
workbench server. `serve_fixture.py` creates a temporary source directory and
explicitly overrides all four harness roots, both Codex archive/session paths,
configuration, pricing, and cache. The temporary directory is removed at exit.
`.e2e/fixture-state.json` identifies only this temporary source for the refresh
scenario. Every mutation is a synthetic source append; tests use the UI refresh
control to update the application. Tests do not call business functions or
substitute responses.

Results: `.e2e/report.json`, `.e2e/summary.md`, screenshots and Playwright traces
under `.e2e/artifacts/`, and fixture server logs under `.e2e/logs/`. The directory
is ignored by Git. `npm --prefix web run test:e2e -- --grep 'scenario name'`
selects one scenario; fixture state starts fresh on each invocation.

## Hand-counted fixture ledger

Window: **2026-10-01T00:00:00Z through 00:01:30Z**, end excluded. Model
`e2e-known`: input $2/M, cache read $0.5/M, cache write $3/M, output $8/M.

| Source / turn | Net input | Cache read | Cache write | Output | Tokens | Calls | Cost USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Codex completed turn | 240 | 60 | 0 | 100 | 400 | 2 | 0.001310 |
| Claude turn | 100 | 100 | 100 | 100 | 400 | 1 | 0.001350 |
| OMP turn | 50 | 50 | 0 | 100 | 200 | 1 | 0.000925 |
| DSH turn | 100 | 0 | 0 | 100 | 200 | 1 | 0.001000 |
| Codex ongoing turn | 50 | 0 | 0 | 50 | 100 | 1 | 0.000500 |
| **Total** | **540** | **210** | **100** | **450** | **1300** | **6** | **0.005085** |

Minute buckets intersect the selected window for **60 seconds** and **30 seconds**:

| Bucket | Tokens | Calls | TPM | RPM | throughput TPS | RPS | Cache hit rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 00:00 | 800 | 3 | 800 | 3 | 800/60 | 3/60 | 160/600 |
| 00:01 | 500 | 3 | 1000 | 6 | 500/30 | 3/30 | 50/250 |

The global cache rate is 210/850. The three closed, wholly in-window turns
have 1000/3 = 333.3 recorded tokens and $0.003660/3 = $0.001220 mean cost;
the inferred Claude boundary participates, while running turns do not.
Codex boundary payloads use Unix seconds, matching native source logs.
Actual timed output speed stays separate:
Codex's first completed turn is 100 output/20 seconds = 5 TPS;
OMP has 100 output/10 seconds = 10 model TPS;
DSH has 100 output/10 seconds = 10 end-to-end TPS. Claude has no authoritative
model-duration sample. The ongoing Codex turn contributes no completed timing.

A late Claude turn at 00:01:35–00:01:40 uses `e2e-unpriced` and omits cache write.
A narrow late window must show missing price/write and unknown cost/speed/cache
rate. Empty buckets have zero recorded rates and unknown timed speed.

The refresh append repeats `response-codex-live` unchanged, adds one new 100-token
call costing $0.000500, finishes the existing tool, then closes the existing turn
at 00:01:29. Counts become **1400 tokens / 7 calls / $0.005585**, while turn count
stays 5 and the row/tool status and completed-turn speed update. Repeating the
same append and refresh keeps these counts stable.

## Acceptance scope

Four browser scenarios cover the single shared time/timezone/slice/filter context,
all dashboard panels and the ledger, chart type/slice changes and zoom, hand-counted
rates/cache/turn summaries, tool names/statuses and turn details, missing values,
and append/replay refresh. A passed old-page smoke test cannot satisfy this suite.


1. A continuous user journey: overview → chart period zoom → contribution
   source → turn/tool explanation → clear filters and restore the original
   range. Includes chart types/composition, time intervals/timezone, partial
   bucket rates, cache ratios and separately labelled timed speeds.
2. Completed-turn details and a narrower global window: costs, model calls,
   tool success/error and the distinction between window and recorded calls.
3. Historical refresh: one new call, same-key replay, existing running turn/tool
   completion, unchanged totals after repeat, missing source fields/price and
   empty buckets.
4. Relative-window refresh: append a synthetic current-time 100-token call
   after the saved cutoff, scan to advance the preset, zoom to fixed history,
   append another call and preserve the fixed range, then return and scan to
   recover the relative mode (200 tokens / 2 calls). These two dynamic calls
   remain outside the fixed October 1 hand-counted window.
