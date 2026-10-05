import { test, type Browser } from '../../web/node_modules/@e2e-dev/web/dist/index.js';
import { expect, type Screen } from '../../web/node_modules/e2e/dist/index.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { initial, refreshed } from './expected.ts';

const ids = ['consumption', 'rate', 'cache', 'speed', 'turns'];
const byId = (browser: Browser, id: string) => browser.locator(`[data-testid="${id}"]`);

async function range(browser: Browser, screen: Screen, start = '2026-10-01T00:00:00', end = '2026-10-01T00:01:30') {
  await browser.locator('[data-testid="time-range"] .range-button').click();
  await screen.getByLabel('开始').fill(start.replace(/:00$/, '')); 
  await screen.getByLabel('结束').fill(end.replace(/:00$/, '')); 
  await screen.getByRole('button', { name: '应用时间范围' }).click();
}
async function openDashboard(browser: Browser, screen: Screen) {
  await browser.goto('/', { waitUntil: 'networkidle' });
  await expect(byId(browser, 'global-query')).toBeVisible();
  await byId(browser, 'timezone').selectOption({ value: 'UTC' });
  await range(browser, screen);
  await byId(browser, 'time-slice').selectOption({ value: 'minute' });
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('1.3K');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=2')).toHaveText('6');
  for (const id of ids) await expect(byId(browser, `panel-${id}`)).toBeVisible();
}
async function harness(browser: Browser, name: string) {
  await browser.locator('[data-testid="filter-harness"] .facet-trigger').click();
  await byId(browser, 'filter-harness').getByLabel(name === 'codex' ? 'Codex' : name).check();
  await browser.locator('[data-testid="filter-harness"] .dismiss').click();
}
async function hoverBucket(browser: Browser, id: string, bucket: 0 | 1) {
  await byId(browser, `chart-${id}`).scrollIntoView();
  const points = await browser.evaluate(({ id, bucket }) => {
    const svg = document.querySelector(`[data-testid="chart-${id}"] .recharts-surface`);
    if (!svg) throw new Error('chart SVG not rendered');
    const rect = svg.getBoundingClientRect();
    // Click well inside the plot, on the first/second half of the visible SVG.
    // Recharts also renders offscreen brush-axis ticks, so those tick boxes are
    // unsuitable as pointer coordinates.
    return { x: rect.x + rect.width * (bucket === 0 ? 0.3 : 0.8), y: rect.y + 50 };

  }, { id, bucket });
  await browser.mouse.move(points.x, points.y);
}

// Tests drive the rendered UI against source logs and the real HTTP service.
// No API-only tests, mocked responses, model calls or business function imports.
test('user journey: overview, trend period, source contribution, turn tools, context restoration', async ({ browser, screen, app }) => {
  await openDashboard(browser, screen);
  await expect(byId(browser, 'global-query')).toHaveCount(1);
  await expect(byId(browser, 'time-range')).toHaveCount(1);
  await expect(byId(browser, 'timezone')).toHaveCount(1);
  await expect(byId(browser, 'time-slice')).toHaveCount(1);
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=2')).toHaveText('6');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=3')).toHaveText('24.7%');
  await expect(byId(browser, 'value-cache')).toHaveText('24.7%');
  await expect(byId(browser, 'turn-count')).toHaveText('5');
  await expect(browser.locator('[data-testid="panel-turns"] .turn-summary article >> nth=1 >> b')).toHaveText('333.3');
  await expect(browser.locator('[data-testid="panel-turns"] .turn-summary article >> nth=2 >> b')).toHaveText('$0.001220');
  await expect(browser.locator('[data-testid="ledger"] tbody tr')).toHaveCount(4);
  await browser.locator('[data-testid="panel-speed"] .timing-explanation summary').click();
  await expect(browser.locator('[data-testid="panel-speed"] .timing-ledger b')).toHaveText(['5.0 TPS', '10.0 TPS', '10.0 TPS']);
  await browser.locator('[data-testid="slices-speed"] summary').click();
  await expect(browser.locator('[data-testid="slices-speed"] tbody tr >> nth=0 >> td >> nth=2')).toHaveText('5');
  await expect(browser.locator('[data-testid="slices-speed"] tbody tr >> nth=0 >> td >> nth=3')).toHaveText('—');
  await expect(browser.locator('[data-testid="slices-speed"] tbody tr >> nth=1 >> td >> nth=2')).toHaveText('—');
  await expect(browser.locator('[data-testid="slices-speed"] tbody tr >> nth=1 >> td >> nth=3')).toHaveText('10');
  await browser.locator('[data-testid="slices-speed"] summary').click();
  await browser.locator('[data-testid="slices-cache"] summary').click();
  await expect(browser.locator('[data-testid="slices-cache"] tbody tr >> nth=0 >> td >> nth=2')).toHaveText('26.7%');
  await expect(browser.locator('[data-testid="slices-cache"] tbody tr >> nth=1 >> td >> nth=2')).toHaveText('20.0%');
  await browser.locator('[data-testid="slices-cache"] summary').click();

  await byId(browser, 'group-rate').selectOption({ value: 'model' });
  await browser.locator('[data-testid="slices-rate"] summary').click();
  const rateCell = (row: number, col: number) => browser.locator(`[data-testid="slices-rate"] tbody tr >> nth=${row} >> td >> nth=${col}`);
  await expect(rateCell(0, 1)).toHaveText('60');
  await expect(rateCell(1, 1)).toHaveText('30');
  await expect(rateCell(0, 2)).toHaveText('800');
  await expect(rateCell(1, 2)).toHaveText('1K');
  await byId(browser, 'metric-rate').selectOption({ value: 'rpm' });
  await expect(rateCell(0, 2)).toHaveText('3');
  await expect(rateCell(1, 2)).toHaveText('6');
  await byId(browser, 'metric-rate').selectOption({ value: 'throughput_tps' });
  await expect(rateCell(0, 2)).toHaveText('13.33');
  await expect(rateCell(1, 2)).toHaveText('16.67');
  await byId(browser, 'metric-rate').selectOption({ value: 'rps' });
  await expect(rateCell(0, 2)).toHaveText('0.05');
  await expect(rateCell(1, 2)).toHaveText('0.1');
  await browser.locator('[data-testid="slices-rate"] summary').click();

  for (const kind of ['bar', 'line', 'area']) {
    await byId(browser, 'chart-type-consumption').selectOption({ value: kind });
    await expect(browser.locator(`[data-testid="chart-consumption"] .recharts-${kind} >> nth=0`)).toBeAttached();
  }
  await byId(browser, 'share-consumption').click();
  await browser.locator('[data-testid="slices-consumption"] summary').click();
  await expect(browser.locator('[data-testid="slices-consumption"] tbody tr >> nth=0 >> td >> nth=2')).toHaveText('100.0%');
  await expect(browser.locator('[data-testid="slices-consumption"] tbody tr >> nth=1 >> td >> nth=2')).toHaveText('100.0%');
  await browser.locator('[data-testid="slices-consumption"] summary').click();
  await byId(browser, 'share-consumption').click();
  await byId(browser, 'time-slice').selectOption({ value: '10second' });
  await expect(byId(browser, 'value-consumption')).toHaveText(`$${initial.cost.toFixed(6)}`);
  for (const id of ['consumption', 'rate', 'cache', 'speed'])
    await expect(browser.locator(`[data-testid="panel-${id}"] .panel-foot`)).toContainText('每10秒');
  await byId(browser, 'time-slice').selectOption({ value: 'minute' });

  await byId(browser, 'timezone').selectOption({ value: 'Asia/Singapore' });
  await expect(browser.locator('[data-testid="time-range"] .range-button')).toContainText('08:00');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('1.3K');
  await byId(browser, 'timezone').selectOption({ value: 'UTC' });
  await harness(browser, 'codex');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('500');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=2')).toHaveText('3');
  await expect(byId(browser, 'turn-count')).toHaveText('2');
  await expect(browser.locator('[data-testid="ledger"] tbody tr')).toHaveCount(1);
  await expect(byId(browser, 'value-cache')).toHaveText('17.1%');
  await browser.locator('[data-testid="panel-speed"] .timing-explanation summary').click();
  await expect(browser.locator('[data-testid="panel-speed"] .timing-ledger b')).toHaveText('5.0 TPS');
  await byId(browser, 'clear-filters').click();
  await expect(byId(browser, 'turn-count')).toHaveText('5');

  // A direct click in the second bucket zooms every panel and the ledger.
  await hoverBucket(browser, 'rate', 1);
  await browser.mouse.down(); await browser.mouse.up();
  await expect(byId(browser, 'zoom-back')).toBeVisible();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('500');
  await expect(browser.locator('[data-testid="ledger"] tbody tr')).toHaveCount(4);
  await expect(browser.locator('[data-testid="ledger"] tbody tr:has-text("Claude Code") td >> nth=2')).toHaveText('0');
  await browser.locator('[data-testid="journey-nav"] a[href="#contributors"]').click();
  await byId(browser, 'group-consumption').selectOption({ value: 'harness' });
  await browser.locator('#contributors button[title="筛选Codex并查看其轮次"]').click();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('100');
  await expect(byId(browser, 'turn-count')).toHaveText('1');
  await browser.locator('[data-testid="turn-row"]').filter({ hasText: 'codex-turn-live' }).click();
  await expect(byId(browser, 'turn-detail')).toContainText('窗内 Tokens 100');
  await expect(byId(browser, 'turn-model-call')).toHaveCount(1);
  await expect(byId(browser, 'turn-tool-call')).toHaveCount(1);
  await expect(byId(browser, 'turn-tool-call')).toContainText('进行中');
  await browser.locator('[data-testid="turn-detail"] button[title="关闭轮次详情"]').click();
  await byId(browser, 'clear-filters').click();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('500');
  await byId(browser, 'zoom-back').click();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('1.3K');
  // The chart's visible range selector must apply the same shared zoom.
  await byId(browser, 'chart-rate').scrollIntoView();
  const brush = await browser.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-testid="chart-rate"] .recharts-brush-traveller')];
    if (nodes.length !== 2) throw new Error('range selector handles expected');
    const first = nodes[0].getBoundingClientRect(), last = nodes[1].getBoundingClientRect();
    return { x: first.x + first.width / 2, y: first.y + first.height / 2,
      targetX: last.x + last.width / 2 + 2 };
  });
  await browser.mouse.move(brush.x, brush.y);
  await browser.mouse.down();
  await browser.mouse.move(brush.targetX, brush.y);
  await browser.mouse.up();
  await expect(byId(browser, 'zoom-back')).toBeVisible();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('500');
  await expect(browser.locator('[data-testid="ledger"] tbody tr')).toHaveCount(4);
  await expect(browser.locator('[data-testid="ledger"] tbody tr:has-text("Claude Code") td >> nth=2')).toHaveText('0');
  await byId(browser, 'zoom-back').click();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('1.3K');
  await app.screenshot('dashboard-hand-counted-window');
});

test('turn ledger: model calls, tools, status and detail follow global filters', async ({ browser, screen, app }) => {
  await openDashboard(browser, screen);
  await harness(browser, 'codex');
  const row = browser.locator('[data-testid="panel-turns"] tr').filter({ hasText: 'codex-turn-1' });
  await expect(row).toContainText('400');
  await expect(row).toContainText('20.0s');
  await browser.locator('[data-testid="turn-row"]').filter({ hasText: 'codex-turn-1' }).click();
  await expect(byId(browser, 'turn-detail')).toContainText('窗内 Tokens 400');
  await expect(byId(browser, 'turn-detail')).toContainText('窗内估算费用 $0.001310');
  await expect(byId(browser, 'turn-detail')).toContainText('窗内已记录模型调用 2');
  await expect(byId(browser, 'turn-model-call')).toHaveCount(2);
  await expect(byId(browser, 'turn-tool-call')).toHaveCount(2);
  await expect(byId(browser, 'turn-tool-call')).toContainText(['exec_command', 'exec_command']);
  await expect(browser.locator('[data-testid="turn-tool-call"] .status-badge')).toHaveText(['完成', '错误']);
  await app.screenshot('completed-turn-tools');
  await browser.locator('[data-testid="turn-detail"] button[title="关闭轮次详情"]').click();

  await range(browser, screen, '2026-10-01T00:00:15', '2026-10-01T00:00:23');
  await expect(byId(browser, 'turn-count')).toHaveText('1');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('270');
  await browser.locator('[data-testid="turn-row"]').filter({ hasText: 'codex-turn-1' }).click();
  await expect(byId(browser, 'turn-detail')).toContainText('窗内 Tokens 270');
  await expect(byId(browser, 'turn-detail')).toContainText('窗内已记录模型调用 1');
  await expect(byId(browser, 'turn-model-call')).toHaveCount(2);
  await expect(byId(browser, 'turn-model-call')).toContainText(['窗外', '窗内']);
});

test('refresh: one new call, replay dedup, live tool/turn completion, missing and empty buckets', async ({ browser, screen, app }) => {
  await openDashboard(browser, screen);
  const state = JSON.parse(readFileSync(new URL('../../.e2e/fixture-state.json', import.meta.url), 'utf8'));
  execFileSync('python3', [new URL('./fixture_logs.py', import.meta.url).pathname, '--append', state.root]);
  await byId(browser, 'scan-data').click();
  await expect(byId(browser, 'value-consumption')).toHaveText(`$${refreshed.cost.toFixed(6)}`);
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('1.4K');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=2')).toHaveText('7');
  await expect(byId(browser, 'turn-count')).toHaveText('5');
  const live = browser.locator('[data-testid="panel-turns"] tr').filter({ hasText: 'codex-turn-live' });
  await expect(live).toContainText('完成');
  await expect(live).toContainText('200');
  await browser.locator('[data-testid="turn-row"]').filter({ hasText: 'codex-turn-live' }).click();
  await expect(byId(browser, 'turn-model-call')).toHaveCount(2);
  await expect(byId(browser, 'turn-tool-call')).toHaveCount(1);
  await expect(byId(browser, 'turn-tool-call')).toContainText('错误');
  await browser.locator('[data-testid="turn-detail"] button[title="关闭轮次详情"]').click();
  execFileSync('python3', [new URL('./fixture_logs.py', import.meta.url).pathname, '--append', state.root]);
  await byId(browser, 'scan-data').click();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=2')).toHaveText('7');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('1.4K');
  await expect(byId(browser, 'turn-count')).toHaveText('5');

  await range(browser, screen, '2026-10-01T00:01:30', '2026-10-01T00:02:00');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=0')).toHaveText('—');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=3')).toHaveText('—');
  await expect(byId(browser, 'summary')).toContainText('缺价 1 条调用');
  await expect(byId(browser, 'panel-speed')).toContainText('当前条件没有可用计时样本');
  await range(browser, screen, '2026-10-01T00:02:00', '2026-10-01T00:03:00');
  await expect(byId(browser, 'value-rate')).toHaveText('0');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('0');
  await expect(byId(browser, 'value-cache')).toHaveText('—');
  await expect(byId(browser, 'panel-speed')).toContainText('当前条件没有可用计时样本');
  await app.screenshot('missing-fields-and-empty-buckets');
});


test('relative window: refresh advances cutoff, zoom stays fixed, return restores live context', async ({ browser, screen, app }) => {
  await browser.goto('/', { waitUntil: 'networkidle' });
  await expect(byId(browser, 'global-query')).toBeVisible();
  await byId(browser, 'timezone').selectOption({ value: 'UTC' });
  await screen.getByRole('button', { name: '近24小时', exact: true }).click();
  await byId(browser, 'time-slice').selectOption({ value: 'hour' });
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('0');
  const state = JSON.parse(readFileSync(new URL('../../.e2e/fixture-state.json', import.meta.url), 'utf8'));
  const append = (ordinal: number) => execFileSync('python3', [
    new URL('./fixture_logs.py', import.meta.url).pathname, '--append', state.root,
    '--recent-call', String(ordinal),
  ]);
  append(1);
  await byId(browser, 'scan-data').click();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('100');
  await expect(byId(browser, 'global-query')).toContainText('最近时段');
  await browser.locator('[data-testid="slices-consumption"] summary').click();
  await browser.locator('[data-testid="slices-consumption"] tbody tr >> nth=-1 >> button').click();
  await expect(byId(browser, 'zoom-back')).toBeVisible();
  await expect(byId(browser, 'global-query')).toContainText('固定时段');
  const fixedRange = await browser.locator('[data-testid="time-range"] .range-button').textContent();
  append(2);
  await byId(browser, 'scan-data').click();
  await expect(browser.locator('[data-testid="time-range"] .range-button')).toHaveText(fixedRange!);
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('100');
  await byId(browser, 'zoom-back').click();
  await expect(byId(browser, 'global-query')).toContainText('最近时段');
  await byId(browser, 'scan-data').click();
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=1')).toHaveText('200');
  await expect(browser.locator('[data-testid="summary"] .metric-value >> nth=2')).toHaveText('2');
  await app.screenshot('relative-window-restored');
});
