// Values come from the source ledger in README.md, independent of app output.
export const initial = {
  tokens: 1300, calls: 6, input: 850, output: 450,
  cacheRead: 210, cacheHitRate: 210 / 850, cost: 0.005085,
  codex: { tokens: 500, calls: 3, input: 350, output: 150, cacheRead: 60, cost: 0.001810 },
  buckets: [
    { seconds: 60, tokens: 800, calls: 3, tpm: 800, rpm: 3, tps: 800 / 60, rps: 3 / 60, cacheHitRate: 160 / 600 },
    { seconds: 30, tokens: 500, calls: 3, tpm: 1000, rpm: 6, tps: 500 / 30, rps: 3 / 30, cacheHitRate: 50 / 250 },
  ],
};
export const refreshed = { tokens: 1400, calls: 7, cost: 0.005585,
  codex: { tokens: 600, calls: 4, cost: 0.002310 },
};
export const window = { start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:01:30Z' };
