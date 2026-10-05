import { test, type Browser } from '../../web/node_modules/@e2e-dev/web/dist/index.js';
import { expect } from '../../web/node_modules/e2e/dist/index.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { initial, refreshed } from './expected.ts';

const byId = (b: Browser, id: string) => b.locator(`[data-testid="${id}"]`);
const row = (b: Browser, identity: string, child = '') => b.locator(`tr[data-testid="usage-row"]:has(button[title*="${identity}"]) ${child}`);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function ready(b: Browser) { await expect(byId(b, 'query-updating')).toHaveCount(0); }
async function range(b: Browser, start = '2026-10-01T00:00:00Z', end = '2026-10-01T00:01:30Z') {
  const local = await b.evaluate(({ start, end }) => [start, end].map(v => {
    const d = new Date(v), p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}${d.getSeconds() ? `:${p(d.getSeconds())}` : ''}`;
  }), { start, end });
  await byId(b, 'time-start').fill(local[0]); await byId(b, 'time-end').fill(local[1]);
  await byId(b, 'time-apply').click(); await ready(b);
}
async function open(b: Browser) {
  await b.goto('/', { waitUntil: 'networkidle' });
  await expect(byId(b, 'global-query')).toBeVisible(); await range(b);
  await byId(b, 'slice-minute').click(); await ready(b);
  await expect(byId(b, 'summary-tokens')).toHaveText('1.3K');
}
async function page(b: Browser, name: 'dashboard' | 'usage') { await byId(b, `page-${name}`).click(); await ready(b); }
async function group(b: Browser, name: string) { await byId(b, `usage-group-${name}`).click(); await ready(b); }
async function reveal(b: Browser, id: string) {
  if (await byId(b, id).getAttribute('open') === null) await b.locator(`[data-testid="${id}"] summary`).click();
}
async function settings(b: Browser, id: string, hide = false) {
  const opened = await byId(b, `settings-${id}`).getAttribute('open') !== null;
  if (opened === hide) await b.locator(`[data-testid="settings-${id}"] summary`).click();
}
async function harness(b: Browser) {
  await b.locator('[data-testid="filter-harness"] .facet-trigger').click();
  await byId(b, 'filter-harness').getByLabel('Codex').check();
  await b.locator('[data-testid="filter-harness"] .dismiss').click(); await ready(b);
}
function append(ordinal?: number) {
  const state = JSON.parse(readFileSync(new URL('../../.e2e/fixture-state.json', import.meta.url), 'utf8'));
  execFileSync('python3', [new URL('./fixture_logs.py', import.meta.url).pathname, '--append', state.root,
    ...(ordinal === undefined ? [] : ['--recent-call', String(ordinal)])]);
}
async function refresh(b: Browser) {
  const response = b.waitForResponse(/\/api\/refresh/); await byId(b, 'scan-data').click(); await response;
  await expect(byId(b, 'scan-data')).toHaveText('刷新'); await ready(b);
}
async function hover(b: Browser, id: string, bucket = 1) {
  await byId(b, `chart-${id}`).scrollIntoView();
  const point = await b.evaluate(({ id, bucket }) => {
    const rect = document.querySelector(`[data-testid="chart-${id}"] .recharts-surface`)!.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('Chart SVG has no visible layout area');
    return { x: rect.x + rect.width * (bucket ? .8 : .3), y: rect.y + 50 };
  }, { id, bucket });
  await b.mouse.move(point.x, point.y);
}
async function vector(b: Browser, expected: number[]) {
  // Sum rendered cells, independently of the application's summary/API output.
  const actual = await b.evaluate(() => {
    const rows = [...document.querySelectorAll('tr[data-testid="usage-row"]')];
    return [3,4,5,7,6].map(index => rows.reduce((sum, r) => {
      const text = r.children[index].textContent?.replaceAll(',', '').trim();
      if (!text || text === '—') throw new Error('Unexpected missing fixture component');
      return sum + Number(text);
    }, 0));
  });
  expect(actual).toEqual(expected);
}

// Browser actions and rendered assertions against synthetic source logs and the
// actual Python service. Network observation passes every response unchanged.
test('dashboard journey: shared time, rates, cache, speeds, plots, ranking and return', async ({ browser: b, app }) => {
  await open(b);
  await expect(byId(b, 'global-query')).toHaveCount(1);
  for (const removed of ['timezone','metric-help','open-metric-help','turn-row','usage-table']) await expect(byId(b, removed)).toHaveCount(0);
  expect(await byId(b, 'source-health').getAttribute('open')).toBe(null);
  const zone = await b.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect(byId(b, 'resolved-range')).toContainText(`本机时区 · ${zone}`);
  expect(await b.evaluate(()=>[...document.querySelectorAll('.dashboard-chart .recharts-surface')].length===5&&[...document.querySelectorAll('.dashboard-chart .recharts-surface')].every(n=>n.getBoundingClientRect().width>0))).toBe(true);
  await expect(byId(b, 'summary-calls')).toHaveText('6');
  await expect(byId(b, 'value-consumption')).toHaveText(`$${initial.cost.toFixed(6)}`);
  await expect(byId(b, 'value-cache')).toHaveText('24.7%');
  await expect(byId(b, 'turn-count')).toHaveText('5');
  await expect(byId(b, 'tokens-per-turn')).toHaveText('333.3');
  await expect(byId(b, 'cost-per-turn')).toHaveText('$0.001220');
  await reveal(b, 'slices-cache');
  await expect(b.locator('[data-testid="slices-cache"] tbody tr >> nth=0 >> td >> nth=2')).toHaveText('26.7%');
  await expect(b.locator('[data-testid="slices-cache"] tbody tr >> nth=1 >> td >> nth=2')).toHaveText('20.0%');
  if (await b.locator('[data-testid="panel-speed"] .timing-explanation').getAttribute('open') === null)
    await b.locator('[data-testid="panel-speed"] .timing-explanation summary').click();
  await expect(b.locator('[data-testid="panel-speed"] .timing-ledger b')).toHaveText(['5.0 TPS','10.0 TPS','10.0 TPS']);
  await settings(b, 'rate'); await byId(b, 'group-rate').selectOption({ value: 'model' }); await ready(b);
  await reveal(b, 'slices-rate');
  const cell = (r: number, c: number) => b.locator(`[data-testid="slices-rate"] tbody tr >> nth=${r} >> td >> nth=${c}`);
  await expect(cell(0,1)).toHaveText('60'); await expect(cell(1,1)).toHaveText('30');
  for (const [metric, values] of [['tpm',['800','1K']],['rpm',['3','6']],['throughput_tps',['13.33','16.67']],['rps',['0.05','0.1']]] as const) {
    await byId(b, 'metric-rate').selectOption({ value: metric }); await ready(b);
    await expect(cell(0,2)).toHaveText(values[0]); await expect(cell(1,2)).toHaveText(values[1]);
  }
  await settings(b, 'rate', true); await settings(b, 'consumption');
  for (const kind of ['bar','line','area']) {
    await byId(b, 'chart-type-consumption').selectOption({ value: kind });
    await expect(b.locator(`[data-testid="chart-consumption"] .recharts-${kind} >> nth=0`)).toBeAttached();
  }
  await byId(b, 'share-consumption').click(); await reveal(b, 'slices-consumption');
  await expect(b.locator('[data-testid="slices-consumption"] tbody tr >> nth=0 >> td >> nth=2')).toHaveText('100.0%');
  await byId(b, 'share-consumption').click(); await settings(b, 'consumption', true);
  for (const interval of ['5second','10second','30second','minute','15minute']) {
    await byId(b, `slice-${interval}`).click(); await ready(b);
    await expect(byId(b, `slice-${interval}`)).toHaveAttribute('class', 'selected');
    await expect(byId(b, 'summary-tokens')).toHaveText('1.3K');
  }
  await byId(b, 'slice-minute').click(); await ready(b); await harness(b);
  await expect(byId(b, 'summary-tokens')).toHaveText('500'); await expect(byId(b, 'value-cache')).toHaveText('17.1%');
  await byId(b, 'clear-filters').click(); await ready(b);
  await hover(b, 'rate');
  await b.mouse.down(); await b.mouse.up(); await ready(b);
  await expect(byId(b, 'zoom-back')).toBeVisible(); await expect(byId(b, 'summary-tokens')).toHaveText('500');
  await byId(b, 'rank-group-harness').click();
  await b.locator('[data-testid="absolute-ranking"] button[title*="Codex"]').click(); await ready(b);
  await expect(byId(b, 'usage-table')).toBeVisible(); await expect(byId(b, 'usage-total-tokens')).toHaveText('100');
  await expect(byId(b, 'panel-consumption')).toHaveCount(0);
  await byId(b, 'clear-filters').click(); await ready(b); await byId(b, 'zoom-back').click(); await ready(b);
  await expect(byId(b, 'usage-total-tokens')).toHaveText('1,300'); await page(b, 'dashboard');
  await byId(b, 'chart-rate').scrollIntoView();
  const brush = await b.evaluate(() => {
    const n = [...document.querySelectorAll('[data-testid="chart-rate"] .recharts-brush-traveller')];
    const a=n[0].getBoundingClientRect(), z=n[1].getBoundingClientRect();
    return {x:a.x+a.width/2,y:a.y+a.height/2,to:z.x+z.width/2+2};
  });
  await b.mouse.move(brush.x,brush.y); await b.mouse.down(); await b.mouse.move(brush.to,brush.y); await b.mouse.up(); await ready(b);
  await expect(byId(b, 'summary-tokens')).toHaveText('500'); await byId(b, 'zoom-back').click(); await ready(b);
  await expect(byId(b, 'summary-tokens')).toHaveText('1.3K'); await app.screenshot('dashboard-journey');
});

test('usage page: all five groups preserve four components, reliable TPS, joint drill and return', async ({ browser: b, app }) => {
  await open(b); await page(b,'usage');
  for (const [name,count] of [['request',6],['session',4],['turn',5],['model',1],['harness',4]] as const) {
    await group(b,name); await expect(byId(b,'usage-row')).toHaveCount(count);
    await expect(byId(b,'usage-total-tokens')).toHaveText('1,300'); await expect(byId(b,'usage-total-cost')).toHaveText('$0.005085');
    await vector(b,[6,540,210,100,450]);
  }
  await group(b,'request');
  const omp = (child: string) => b.locator(`tr[data-testid="usage-row"]:has-text("OMP") ${child}`);
  await expect(omp('[data-testid="usage-response-tps"]')).toHaveText('10');
  await omp('[data-testid="usage-row-open"]').click(); await expect(byId(b,'usage-request-detail')).toContainText('10 TPS');
  await expect(byId(b,'usage-request-detail')).toContainText('10 秒');
  await row(b,'response-codex-1','[data-testid="usage-row-open"]').click();
  await expect(byId(b,'usage-request-detail')).toContainText('无可用的请求计时');
  await group(b,'turn'); await expect(row(b,'codex-turn-1','[data-testid="usage-turn-tps"]')).toHaveText('5');
  await row(b,'codex-turn-1','[data-testid="usage-row-open"]').click();
  await expect(byId(b,'usage-row')).toHaveCount(2); await expect(byId(b,'usage-total-tokens')).toHaveText('400');
  await group(b,'model'); await byId(b,'usage-row-open').click(); await ready(b);
  await expect(byId(b,'usage-row')).toHaveCount(2); await expect(byId(b,'usage-total-tokens')).toHaveText('400');
  await expect(byId(b,'usage-drill-context')).toContainText('→');
  await byId(b,'usage-drill-back').click(); await ready(b); await expect(byId(b,'usage-row')).toHaveCount(5);
  await expect(byId(b,'usage-group-turn')).toHaveAttribute('class','selected');
  await group(b,'model'); await expect(byId(b,'usage-response-tps')).toHaveText('10'); await expect(byId(b,'usage-turn-tps')).toHaveText('—');
  await page(b,'dashboard');
  const ranking = b.locator('[data-testid="absolute-ranking"] button[title*="e2e-known"]');
  await ranking.click(); await ready(b);
  await group(b,'harness');
  await b.locator('tr[data-testid="usage-row"]:has-text("Codex") [data-testid="usage-row-open"]').click(); await ready(b);
  await expect(byId(b,'usage-total-tokens')).toHaveText('500');
  await page(b,'dashboard'); await ranking.click(); await ready(b);
  await expect(byId(b,'usage-drill-context')).toHaveCount(0);
  await expect(byId(b,'usage-total-tokens')).toHaveText('1,300');
  await app.screenshot('usage-four-components-and-timing');
});

test('window activity: historical open metadata, same-prefix sessions, unassociated turns and partial values', async ({ browser: b, app }) => {
  await open(b); await range(b,'2026-10-04T00:00:00Z','2026-10-04T00:01:00Z');
  await expect(byId(b,'summary-tokens')).toHaveText('300'); await expect(byId(b,'turn-count')).toHaveText('1');
  await expect(byId(b,'tool-call-total')).toHaveText('1'); await expect(byId(b,'tools-summary')).toContainText('fresh_tool');
  await expect(byId(b,'tools-summary')).not.toContainText('exec_command');
  await page(b,'usage');
  for (const [name,count] of [['request',2],['session',2],['turn',2],['model',1],['harness',1]] as const) {
    await group(b,name); await expect(byId(b,'usage-row')).toHaveCount(count); await vector(b,[2,150,50,20,80]);
    await expect(byId(b,'usage-total-tokens')).toHaveText('300'); await expect(byId(b,'usage-total-cost')).toHaveText('$0.001025');
    await expect(byId(b,'usage-table')).not.toContainText('55555555');
  }
  await group(b,'session');
  await expect(byId(b,'usage-session-id')).toHaveText(['44444444…222222','44444444…111111']);
  await b.setViewport({width:1024,height:1100}); await b.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  expect(await b.evaluate(()=>[...document.querySelectorAll('[data-testid="usage-session-id"]')].every(n=>{const r=n.getBoundingClientRect(),p=n.parentElement!.getBoundingClientRect();return n.clientWidth>=n.scrollWidth&&r.left>=p.left&&r.right<=p.right&&r.width>0;}))).toBe(true);
  await app.screenshot('long-project-colliding-session-ids-1024');
  await group(b,'turn'); await expect(row(b,'222222222222')).toContainText('未关联轮次');
  await row(b,'222222222222','[data-testid="usage-row-open"]').click(); await ready(b);
  await expect(byId(b,'usage-row')).toHaveCount(1); await expect(byId(b,'usage-total-tokens')).toHaveText('170');
  await expect(byId(b,'usage-response-tps')).toHaveText('—'); await expect(byId(b,'usage-turn-tps')).toHaveText('—');
  await byId(b,'usage-drill-back').click(); await ready(b);
  await app.screenshot('historical-open-and-unassociated');
  await range(b,'2026-10-04T00:02:00Z','2026-10-04T00:03:00Z'); await expect(byId(b,'usage-row')).toHaveCount(0);
  await page(b,'dashboard'); await expect(byId(b,'turn-count')).toHaveText('0'); await expect(byId(b,'tool-call-total')).toHaveText('0');
  await range(b,'2026-10-03T00:00:00Z','2026-10-03T00:01:00Z');
  await expect(byId(b,'summary-tokens')).toHaveText('130'); await expect(byId(b,'summary-cost')).toHaveText('$0.000500');
  await expect(byId(b,'summary')).toContainText('已知小计 · 1 次无法估价'); await expect(byId(b,'tokens-per-turn')).toHaveText('65');
  await expect(byId(b,'cost-per-turn')).toHaveText('$0.000250'); await expect(byId(b,'panel-turns')).toContainText('部分价格覆盖');
  await page(b,'usage'); await group(b,'request');
  await expect(byId(b,'usage-total-cost')).toHaveText('$0.000500 · 部分');
  const missing=(child: string)=>b.locator(`tr[data-testid="usage-row"]:has-text("e2e-unpriced") ${child}`);
  await expect(missing('td >> nth=7')).toHaveText('—'); await missing('[data-testid="usage-row-open"]').click();
  await expect(byId(b,'usage-request-detail')).toContainText('输入组成有缺失'); await expect(byId(b,'usage-request-detail')).toContainText('次调用缺价');
});

test('daily use: persisted settings, isolated requests, global sorting and light/dark desktop layouts', async ({ browser: b, app }) => {
  const requests: URL[]=[]; await b.route(/\/api\//,async r=>{requests.push(new URL(r.request.url));await r.continue();});
  await open(b); await harness(b); await settings(b,'consumption');
  requests.length=0; await byId(b,'group-consumption').selectOption({value:'harness'}); await ready(b);
  expect(requests.map(r=>r.pathname)).toEqual(['/api/analytics']);
  requests.length=0; await byId(b,'chart-type-consumption').selectOption({value:'area'}); await byId(b,'share-consumption').click(); await wait(100);
  expect(requests.length).toBe(0); await b.reload(); await ready(b); await settings(b,'consumption');
  await expect(byId(b,'group-consumption')).toHaveValue('harness'); await expect(byId(b,'chart-type-consumption')).toHaveValue('area');
  await expect(byId(b,'summary-tokens')).toHaveText('500'); await settings(b,'consumption',true);
  await byId(b,'clear-filters').click(); await ready(b); await range(b,'2026-10-02T00:00:00Z','2026-10-02T01:00:00Z');
  requests.length=0; await page(b,'usage'); expect(requests.map(r=>r.pathname)).toEqual(['/api/usage']);
  requests.length=0; await group(b,'turn'); expect(requests.map(r=>r.pathname)).toEqual(['/api/usage']); await expect(byId(b,'usage-row')).toHaveCount(20);
  await expect(row(b,'ranking-turn-00')).toHaveCount(0); requests.length=0;
  await byId(b,'usage-next').click(); await ready(b); await expect(byId(b,'usage-row')).toHaveCount(5);
  expect(requests.map(r=>r.pathname)).toEqual(['/api/usage']); await expect(row(b,'ranking-turn-00')).toBeVisible();
  requests.length=0; await byId(b,'usage-sort-cost_usd').click(); await ready(b);
  expect(requests.map(r=>r.pathname)).toEqual(['/api/usage']); await expect(byId(b,'usage-row-open').first()).toHaveAttribute('title', /ranking-turn-00/);
  await expect(row(b,'ranking-turn-00','td >> nth=10')).toHaveText('$0.0160');
  await byId(b,'usage-sort-turn_tps').click(); await ready(b); await expect(byId(b,'usage-row-open').first()).toHaveAttribute('title', /ranking-turn-00/);
  await byId(b,'usage-sort-turn_tps').click(); await ready(b); await expect(byId(b,'usage-row-open').first()).toHaveAttribute('title', /ranking-turn-01/);
  await byId(b,'usage-sort-time').click(); await ready(b); await byId(b,'usage-next').click(); await ready(b);
  await row(b,'ranking-turn-00','[data-testid="usage-row-open"]').click(); await ready(b);
  await expect(byId(b,'usage-total-tokens')).toHaveText('2,000'); await byId(b,'usage-drill-back').click(); await ready(b);
  await expect(byId(b,'usage-row')).toHaveCount(5); await b.reload(); await ready(b);
  await expect(byId(b,'usage-row')).toHaveCount(5); await expect(byId(b,'usage-group-turn')).toHaveAttribute('class','selected');
  // A saved second page can outlive its data, e.g. after a rolling range moves.
  await b.evaluate(() => {
    const key = 'usage-dashboard.preferences.v4';
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.preferences.timeSpec = { start: '2026-10-04T00:00:00Z', end: '2026-10-04T00:01:00Z' };
    stored.preferences.global.since = '2026-10-04T00:00:00Z';
    stored.preferences.global.until = '2026-10-04T00:01:00Z';
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await b.reload(); await ready(b);
  await expect(byId(b,'usage-row')).toHaveCount(2);
  await expect(b.locator('[data-testid="usage-table"] .table-bottom')).toContainText('第 1 / 1 页');
  await range(b); await group(b,'request');
  for (const theme of ['light','dark']) {
    await byId(b,`theme-${theme}`).click(); await expect(byId(b,'workbench')).toHaveAttribute('data-theme',theme);
    for (const width of [1600,1024]) {
      await b.setViewport({width,height:1100}); await b.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      for (const name of ['usage','dashboard'] as const) {
        await page(b,name); expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
        if(name==='dashboard') await expect(b.locator('[data-testid="chart-speed"] .chart-isolated-point')).toHaveCount(3);
        const height=await b.evaluate(()=>{scrollTo(0,0);return Math.max(1100,document.documentElement.scrollHeight);});
        await b.setViewport({width,height}); await b.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
        await app.screenshot(`${name}-${theme}-${width}`); await b.setViewport({width,height:1100});
      }
    }
    await b.setViewport({width:1600,height:1100}); await hover(b,'consumption',0);
    await expect(b.locator('[data-testid="chart-consumption"] .chart-tooltip')).toBeVisible();
    await app.screenshot(`tooltip-${theme}`); await b.reload(); await ready(b);
    await expect(byId(b,'workbench')).toHaveAttribute('data-theme',theme);
  }
});

test('unified time: expressions on both ends, calendar selection, mixed bounds and persistence', async ({ browser: b, app }) => {
  const requests: URL[] = [];
  await b.route(/\/api\//, async r => {
    requests.push(new URL(r.request.url)); await r.continue();
  });
  await open(b);
  const latest = () => requests.filter(r => r.pathname === '/api/analytics').at(-1)!;
  const apply = async () => { await byId(b, 'time-apply').click(); await ready(b); };
  await expect(b.locator('[data-testid^="time-mode-"]')).toHaveCount(0);
  for (const id of ['start', 'end']) {
    await expect(byId(b, `time-${id}`)).toHaveAttribute('type', 'text');
    await expect(byId(b, `time-${id}-picker`)).toBeVisible();
    await expect(byId(b, `time-${id}-calendar`)).toHaveAttribute('step', '1');
  }
  const start = await byId(b, 'time-start').getAttribute('value');
  const end = await byId(b, 'time-end').getAttribute('value');
  const before = requests.length;
  await byId(b, 'time-end').fill(start!); await apply();
  await expect(b.locator('[role="alert"]')).toHaveText('结束时间须晚于开始时间');
  expect(requests.length).toBe(before); await expect(byId(b, 'summary-calls')).toHaveText('6');
  await byId(b, 'time-end').fill('2100-01-01T00:00:00Z'); await apply();
  await expect(b.locator('[role="alert"]')).toHaveText('结束时间不能晚于现在');
  expect(requests.length).toBe(before);
  await byId(b, 'time-start').fill('2100-01-01T00:00:00Z'); await byId(b, 'time-end').fill('现在'); await apply();
  await expect(b.locator('[role="alert"]')).toHaveText('开始时间不能晚于现在');
  expect(requests.length).toBe(before);

  await byId(b, 'time-start').fill('-2h'); await byId(b, 'time-end').fill('-1h'); await apply();
  let q = latest();
  expect(Date.parse(q.searchParams.get('end')!) - Date.parse(q.searchParams.get('start')!)).toBe(3600000);
  expect(Math.abs(Date.parse(q.searchParams.get('end')!) - (Date.now() - 3600000)) < 5000).toBe(true);
  await expect(byId(b, 'time-end')).toHaveValue('-1h');
  await byId(b, 'time-start').fill(start!); await apply();
  expect(latest().searchParams.get('start')).toBe('2026-10-01T00:00:00.000Z');
  await expect(byId(b, 'time-end')).toHaveValue('-1h');
  const fixedEnd = new Date(Date.now() - 3600000).toISOString();
  await byId(b, 'time-start').fill('-3h'); await byId(b, 'time-end').fill(fixedEnd); await apply();
  expect(latest().searchParams.get('end')).toBe(fixedEnd);
  await expect(byId(b, 'time-start')).toHaveValue('-3h');

  for (const [id, local] of [['start', start!], ['end', end!]]) {
    await byId(b, `time-${id}-picker`).click();
    const max = await byId(b, `time-${id}-calendar`).getAttribute('max');
    expect(max != null && Math.abs(Date.parse(max) - Date.now()) < 5000).toBe(true);
    const native = local.replace(' ', 'T').replace(/:00$/, '');
    await byId(b, `time-${id}-calendar`).fill(native);
    await byId(b, `time-${id}-calendar`).press('Escape');
    await expect(byId(b, `time-${id}`)).toHaveValue(native.replace('T', ' '));
  }
  await apply(); await expect(b.locator('[role="alert"]')).toHaveCount(0);
  await expect(byId(b, 'summary-calls')).toHaveText('6');
  q = latest();
  expect(q.searchParams.get('start')).toBe('2026-10-01T00:00:00.000Z');
  expect(q.searchParams.get('end')).toBe('2026-10-01T00:01:30.000Z');
  await page(b, 'usage'); await expect(byId(b, 'usage-row')).toHaveCount(6);
  const usage = requests.filter(r => r.pathname === '/api/usage').at(-1)!;
  expect(usage.searchParams.get('start')).toBe(q.searchParams.get('start'));
  expect(usage.searchParams.get('end')).toBe(q.searchParams.get('end'));
  await b.reload(); await ready(b);
  await expect(byId(b, 'time-start')).toHaveValue(start!);
  await expect(byId(b, 'time-end')).toHaveValue(end!);
  await refresh(b); await expect(byId(b, 'time-end')).toHaveValue(end!);
  for (const theme of ['light', 'dark']) {
    await byId(b, `theme-${theme}`).click();
    for (const width of [1600, 1024]) {
      await b.setViewport({ width, height: 1000 });
      await b.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(byId(b, 'time-start')).toBeVisible(); await expect(byId(b, 'time-end')).toBeVisible();
      await app.screenshot(`unified-time-${theme}-${width}`);
    }
  }
  await byId(b, 'time-start').fill('-6h'); await byId(b, 'time-end').fill('-1h'); await apply();
  await expect(byId(b, 'time-start')).toHaveValue('-6h');
  await expect(byId(b, 'time-end')).toHaveValue('-1h');
});

test('comparison: adjacent equal window and explicit current/previous unpriced reasons', async ({ browser: b, app }) => {
  await open(b);
  await range(b,'2026-10-04T00:00:00Z','2026-10-05T00:00:00Z');
  await expect(byId(b,'summary-cost')).toHaveText('$0.001025');
  await expect(byId(b,'summary-change-cost')).toHaveText('上期 1 次无法估价');
  await expect(byId(b,'summary-change-cost')).toHaveAttribute('class','change unavailable');
  const local = await b.evaluate(() => ['2026-10-03T00:00:00Z','2026-10-04T00:00:00Z'].map(v => {
    const d = new Date(v), p = (n: number) => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }));
  await expect(byId(b,'comparison-period')).toContainText(`${local[0]} — ${local[1]}`);
  await expect(byId(b,'comparison-period')).toContainText('环比上一等长时段');
  await app.screenshot('comparison-previous-unpriced');
  await range(b,'2026-10-03T00:00:00Z','2026-10-04T00:00:00Z');
  await expect(byId(b,'summary-change-cost')).toHaveText('本期 1 次无法估价');
  await expect(byId(b,'summary')).toContainText('已知小计 · 1 次无法估价');
});

test('refresh: incremental dedup, completed metadata, unknown and empty windows, live zoom restoration', async ({ browser: b, app }) => {
  await open(b); append(); await refresh(b);
  await expect(byId(b,'summary-tokens')).toHaveText('1.4K'); await expect(byId(b,'summary-calls')).toHaveText('7');
  await expect(byId(b,'value-consumption')).toHaveText(`$${refreshed.cost.toFixed(6)}`); await expect(byId(b,'turn-count')).toHaveText('5');
  await expect(b.locator('[data-testid="tools-summary"] article:has-text("exec_command")')).toContainText('错误 2');
  await expect(b.locator('[data-testid="tools-summary"] article:has-text("exec_command")')).not.toContainText('进行中');
  await expect(byId(b,'tokens-per-turn')).toHaveText('300'); await expect(byId(b,'cost-per-turn')).toHaveText('$0.001165');
  await page(b,'usage'); await group(b,'turn'); await expect(row(b,'codex-turn-live','td >> nth=9')).toHaveText('11.11');
  await row(b,'codex-turn-live','[data-testid="usage-row-open"]').click(); await ready(b);
  await expect(byId(b,'usage-row')).toHaveCount(2); await expect(byId(b,'usage-total-tokens')).toHaveText('200');
  await byId(b,'usage-drill-back').click(); await ready(b); append(); await refresh(b);
  await expect(byId(b,'usage-total-tokens')).toHaveText('1,400'); await expect(byId(b,'usage-row')).toHaveCount(5);
  await page(b,'dashboard'); await range(b,'2026-10-01T00:01:30Z','2026-10-01T00:02:00Z');
  await expect(byId(b,'summary-cost')).toHaveText('—'); await expect(byId(b,'value-cache')).toHaveText('—');
  await expect(byId(b,'panel-speed')).toContainText('当前条件没有可用计时样本');
  await range(b,'2026-10-01T00:02:00Z','2026-10-01T00:03:00Z'); await expect(byId(b,'value-rate')).toHaveText('0');
  await expect(byId(b,'turn-count')).toHaveText('0');
  await byId(b,'time-start').fill('-24h'); await byId(b,'time-end').fill('现在'); await byId(b,'time-apply').click(); await ready(b);
  await byId(b,'slice-hour').click(); await ready(b); append(1); await refresh(b); await expect(byId(b,'summary-tokens')).toHaveText('100');
  await reveal(b,'slices-consumption'); await b.locator('[data-testid="slices-consumption"] tbody tr >> nth=-1 >> button').click(); await ready(b);
  const frozen=await byId(b,'resolved-range').textContent(); append(2); await refresh(b);
  await expect(byId(b,'resolved-range')).toHaveText(frozen!); await expect(byId(b,'summary-tokens')).toHaveText('100');
  await byId(b,'zoom-back').click(); await ready(b); await expect(byId(b,'time-start')).toHaveValue('-24h');
  await expect(byId(b,'time-end')).toHaveValue('现在'); await refresh(b); await expect(byId(b,'summary-tokens')).toHaveText('200');
  await app.screenshot('incremental-refresh-and-live-return');
});

test('inline time: relative/since/fixed, auto refresh persisted, editing pause and no overlap', async ({ browser: b, app }) => {
  const requests:URL[]=[]; let posts=0,hold=false,release:(()=>void)|undefined;
  await b.route(/\/api\//,async r=>{
    const u=new URL(r.request.url); requests.push(u);
    if(r.request.method==='POST'&&u.pathname==='/api/refresh') {posts++; if(hold){hold=false;await new Promise<void>(resolve=>{release=resolve;});}}
    await r.continue();
  });
  await b.goto('/',{waitUntil:'networkidle'}); await expect(byId(b,'auto-refresh-toggle')).not.toBeChecked();
  const latest=()=>requests.filter(r=>r.pathname==='/api/analytics').at(-1)!;
  for (const [expression,ms] of [['-18h',18*3600000],['-2days',2*86400000]] as const) {
    await byId(b,'time-start').fill(expression); await byId(b,'time-end').fill('现在'); await byId(b,'time-apply').click(); await ready(b);
    const q=latest(); expect(Date.parse(q.searchParams.get('end')!)-Date.parse(q.searchParams.get('start')!)).toBe(ms);
    expect(Math.abs(Date.parse(q.searchParams.get('end')!)-Date.now())<5000).toBe(true);
    expect(q.searchParams.get('timezone')).toBe(await b.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone));
  }
  await byId(b,'time-start').fill('2026-10-01T00:00:00Z'); await byId(b,'time-apply').click(); await ready(b);
  expect(latest().searchParams.get('start')).toBe('2026-10-01T00:00:00.000Z'); const before=latest().searchParams.get('end')!;
  await refresh(b); expect(Date.parse(latest().searchParams.get('end')!)>Date.parse(before)).toBe(true);
  expect(latest().searchParams.get('start')).toBe('2026-10-01T00:00:00.000Z');
  await byId(b,'time-start').fill('-18h'); await byId(b,'time-apply').click(); await ready(b); await byId(b,'slice-hour').click(); await ready(b);
  const baseline=Number(await byId(b,'summary-calls').textContent()); append(99); posts=0;hold=true; await byId(b,'auto-period-15').click(); await byId(b,'auto-refresh-toggle').check();
  for(let i=0;i<20&&!release;i++) await wait(1000); expect(posts).toBe(1); await wait(16000); expect(posts).toBe(1);
  release!(); await expect(byId(b,'summary-calls')).toHaveText(String(baseline+1));
  await b.reload(); await ready(b); await expect(byId(b,'auto-refresh-toggle')).toBeChecked();
  await expect(byId(b,'auto-period-15')).toHaveAttribute('class','selected'); await expect(byId(b,'time-start')).toHaveValue('-18h');
  await byId(b,'time-start').fill('-18h'); const beforeEdit=posts; await wait(16000); expect(posts).toBe(beforeEdit);
  await range(b); const fixed=await byId(b,'resolved-range').textContent();
  await refresh(b); await expect(byId(b,'resolved-range')).toHaveText(fixed!); await b.reload(); await ready(b);
  await expect(byId(b,'resolved-range')).toHaveText(fixed!); await expect(byId(b,'auto-refresh-toggle')).not.toBeChecked();
  await expect(byId(b,'auto-refresh-toggle')).toBeDisabled();
  await expect(byId(b,'auto-refresh-note')).toHaveText('历史范围不自动刷新');
  await app.screenshot('inline-time-and-auto-refresh');
});

test('historical refresh: fixed and past-relative ends pause scans and returning to now restores preference', async ({ browser: b, app }) => {
  let posts=0;
  await b.route(/\/api\//, async r => {
    if(r.request.method==='POST' && new URL(r.request.url).pathname==='/api/refresh') posts++;
    await r.continue();
  });
  await b.goto('/',{waitUntil:'networkidle'}); await ready(b);
  await byId(b,'auto-period-15').click(); await byId(b,'auto-refresh-toggle').check();
  await range(b); await b.reload(); await ready(b);
  await expect(byId(b,'auto-refresh-toggle')).toBeDisabled();
  await expect(byId(b,'auto-refresh-toggle')).not.toBeChecked();
  const beforeHistory=posts; await wait(16000); expect(posts).toBe(beforeHistory);
  await byId(b,'time-start').fill('-2h'); await byId(b,'time-end').fill('-1h'); await byId(b,'time-apply').click(); await ready(b);
  await expect(byId(b,'auto-refresh-toggle')).toBeDisabled();
  const beforePast=posts; await wait(16000); expect(posts).toBe(beforePast);
  await byId(b,'time-end').fill('现在'); await byId(b,'time-apply').click(); await ready(b);
  await expect(byId(b,'auto-refresh-toggle')).toBeChecked();
  await expect(byId(b,'auto-refresh-toggle')).toBeEnabled();
  await expect(byId(b,'auto-refresh-note')).toHaveCount(0);
  await byId(b,'auto-refresh-toggle').uncheck();
  await app.screenshot('historical-refresh-pause-and-resume');
});
