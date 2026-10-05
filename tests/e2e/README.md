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

Nine browser scenarios use one shared inline time/filter context, the machine's
actual timezone, aggregate-only Dashboard panels and the separate usage page:

1. Overview → chart zoom → contribution ranking → requests → restore the range.
   Checks hand-counted rates with 60/30-second denominators, cache ratio,
   separately labelled measured TPS, bar/line/area, composition, direct
   5/10/30-second and 1/15-minute intervals, filtering and chart/brush zoom.
2. Request/session/turn/model/harness groups preserve all four component totals.
   Request timing is reliable only where recorded; turn timing stays on its own
   definition. Nested drill after regrouping retains the prior identity and returning
   restores group context. Dashboard navigation clears the earlier local drill.
3. Old open metadata contributes only with actual window activity. New requests
   in old sessions remain; unassociated-turn requests survive all groups/drill.
   Long-project sessions with the same eight-character prefix have visible,
   distinct suffixes at 1024 pixels. Missing components/price stay explicit.
4. Saved filters, panel settings, usage page/group/page and theme survive reload.
   Browser requests prove local panel changes and usage sorting/paging load only
   their own data. Twenty-row pagination and full-result sorting use 25 turns.
   A saved page beyond the remaining result count recovers to a valid page.
   Both pages and chart tooltips are captured in light/dark palettes at 1600 and
   1024 pixels; document overflow is checked after chart resize.
5. Synthetic append adds one call; same-key replay stays stable. Completion
   updates recorded turn means and timing. Missing/empty windows and relative
   refresh → fixed zoom → restore live range are exercised through the UI.
6. Inline `-18h`, `-2days`, fixed-start-to-now and fixed history produce correct
   bounds. Explicit auto-refresh switch/period persist; editing pauses it and
   a refresh held across another interval never overlaps a second refresh.
   Manual historical refresh remains available.
7. Each time field accepts expressions, concrete times and calendar selections.
   Both-relative and mixed bounds resolve correctly; second-precision fixed bounds
   persist through page changes, reload and refresh. Invalid bounds keep the current
   data; future bounds are rejected and calendars have a current-time maximum.
   Both desktop widths and themes remain usable.
8. An October 4 daily window compares with October 3 using the same filters. The
   current $0.001025 is complete; the previous $0.000500 has one unpriced call.
   The page shows the previous dates and missing-estimate reason. Moving to October 3
   instead shows current-period missing coverage and the known subtotal label.
9. Fixed ends and past-relative ends issue no automatic scans across a full interval;
   returning to now restores the saved switch.

## Daily-dashboard fixtures

Additional dates are separate from the October 1 ledger:

- October 2 00:00–01:00 UTC, project `/synthetic/ranking`: 25 completed Codex turns, 2539 recorded output
  tokens / 25 calls / $0.020312. The oldest `ranking-turn-00` costs $0.016
  (2000 output tokens); the next `ranking-turn-01` lasts 90 seconds. With
  descending start-time order and a 20-row page, both are on the second page.
  Sorting by cost brings turn 00 to the first row; descending and ascending
  turn TPS put turn 00 and turn 01 first, proving sorting precedes pagination.
- October 3 00:00–00:01 UTC: two completed Claude turns. One records 100 tokens
  and costs $0.000500; the other records 30 tokens with missing price/cache-write.
  The window contains 130 recorded tokens and a $0.000500 known cost subtotal.
  The mean over two recorded turns is 65 known tokens and $0.000250 known cost;
  incomplete price/input coverage must remain visible.

Network assertions observe actual browser requests and continue them unchanged.
No assertion calls an API directly or imports query/parser/adapter functions.

Time controls are exercised through the UI using the real 15-second timer
(the e2e browser facade has no public clock control). One POST is temporarily
delayed, then continued unchanged to the real service. All assertions inspect
rendered pages or observe their actual network traffic.

A real background-tab visibility change is not emulated by the e2e browser
facade. Editing pause is browser-verified; background pause remains outside this
automated evidence. Artifacts contain synthetic source data only.

## Historical-open activity fixture

October 4 00:00–00:01 UTC, project `/synthetic/company/platform/products/usage-workbench/feature-branches/extremely-long-project-path/activity`, has two real requests:

| Fixture session ID | Window activity | Net input | Cache read | Cache write | Output | Tokens | Cost USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 44444444…111111 | New request in a September 30 open turn; one new completed tool | 80 | 20 | 0 | 30 | 130 | 0.000410 |
| 44444444…222222 | New request with no associated turn | 70 | 30 | 20 | 50 | 170 | 0.000615 |
| **Total** | **2 calls** | **150** | **50** | **20** | **80** | **300** | **0.001025** |

Session 555555 has only a September 30 open turn/tool and no October 4 activity.
The old pending tool in 44444444…111111 also has no October 4 activity. Neither stale
metadata item belongs in October 4 counts. The real new request from the old
44444444…111111 session must remain visible. Turn grouping must retain the unassociated
170-token request; all grouping modes preserve the same four component totals.
Both requests lack reliable completed timing, so TPS remains unknown.

Fixed fixture windows are specified in UTC. Browser interactions convert their
bounds to the browser's actual system-local time; the app's query zone must match
`Intl.DateTimeFormat().resolvedOptions().timeZone`. No timezone selector is used.

The two active sessions deliberately share their first eight ID characters
(`44444444`). The first shows its native title, while the second uses a project/time
unnamed-session label. IDs remain available in tooltips. Neither ID is visible in row text.

## Native names and actual-clock acceptance

The names scenario reads explicit native title fields from all four synthetic roots:
Codex's `threads` SQLite table, Claude custom/AI title records, OMP header title and
DSH session title. It exercises session/project facets, request details, session rows,
missing-title fallback, source rename/refresh and light/dark 1024-pixel screenshots.
September 29 adds 80 tokens in three sessions: 30 and 40 in distinct Codex project
paths both named `reporting`, and 10 in Claude using the first Codex session's ID.
Filtering the worktree path retains only 40 tokens; cross-harness identities stay separate.
`--rename-sessions` changes only guarded temporary `harnesscope-browser-` fixtures.
These title-only updates preserve the October 1 baseline of 1300 tokens.

The current-time scenario observes real requests without API mocks. Blur, Enter,
manual refresh and browser reload resolve relative ranges against the actual clock;
a newly appended 501-token recent request appears on refresh. Future input retains
the current result and prevents a scan until corrected. Related inline-time and
historical-refresh scenarios cover editing pause, no overlapping scans and saved
automatic-refresh preferences when returning to now.
