import { test, type Browser } from '../../web/node_modules/@e2e-dev/web/dist/index.js';
import { expect } from '../../web/node_modules/e2e/dist/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
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
async function page(b: Browser, name: 'dashboard' | 'usage' | 'calendar') {
  await byId(b, `page-${name}`).click(); await ready(b);
  if(name==='calendar') await expect(byId(b,'calendar-page')).toHaveAttribute('aria-busy','false');
}
async function group(b: Browser, name: string) { await byId(b, `usage-group-${name}`).click(); await ready(b); }
async function reveal(b: Browser, id: string) {
  if (await byId(b, id).getAttribute('open') === null) await b.locator(`[data-testid="${id}"] > summary`).click();
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

type NativeAccount = {account_ref:string;harness:string;provider:string;kind:string;label:string};
type NativePeriod = {id:string;account_ref:string;label:string;start:string|null;end:string|null;observed_at:string;
  used_fraction:number|null;scope:{model:string|null;shared:boolean|null}};
type NativeDirectory = {snapshot:{id:string|number};accounts:NativeAccount[];periods:NativePeriod[]};
const accountWindow = {start:'2025-05-01T00:00:00Z',end:'2025-05-01T05:00:00Z'};
function fixtureRoot() {
  return JSON.parse(readFileSync(new URL('../../.e2e/fixture-state.json',import.meta.url),'utf8')).root as string;
}
async function accountCatalog(b:Browser) {
  await reveal(b,'account-periods');
  await expect(byId(b,'account-select')).toBeEnabled();
}
async function chooseAccountPeriod(b:Browser,directory:NativeDirectory,email:string,label:string) {
  await accountCatalog(b);
  const account=directory.accounts.find(a=>a.label.includes(email));
  if(!account) throw new Error(`Missing fixture account ${email}`);
  const period=directory.periods.find(p=>p.account_ref===account.account_ref&&p.label===label);
  if(!period) throw new Error(`Missing fixture period ${label}`);
  await byId(b,'account-select').selectOption({value:account.account_ref});
  await byId(b,'account-period-select').selectOption({value:period.id});
  return {account,period};
}
async function openAccountWindow(b:Browser) {
  await b.goto('/',{waitUntil:'networkidle'}); await ready(b);
  // The engine requires an open page before registering a response wait.
  const response=b.waitForResponse(/\/api\/accounts(?:\?|$)/);
  await b.reload(); await ready(b);
  const directory=await (await response).json<NativeDirectory>();
  await range(b,accountWindow.start,accountWindow.end);
  await expect(byId(b,'summary-tokens')).toHaveText('660');
  return directory;
}

// Browser actions and rendered assertions against synthetic source logs and the
// actual Python service. Network observation passes every response unchanged.
test('dashboard journey: shared time, rates, cache, speeds, plots, ranking and return', async ({ browser: b, app }) => {
  await open(b);
  await expect(byId(b, 'global-query')).toHaveCount(1);
  for (const removed of ['timezone','metric-help','open-metric-help','turn-row','usage-table']) await expect(byId(b, removed)).toHaveCount(0);
  await expect(byId(b, 'source-health')).toHaveCount(0);
  const zone = await b.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect(byId(b, 'resolved-range')).toHaveAttribute('title',zone);
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
  await reveal(b,'slices-speed');
  const timedValues=await b.evaluate(()=>[...document.querySelectorAll('[data-testid="slices-speed"] tbody tr')]
    .flatMap(row=>[...row.children].slice(2,-1).map(cell=>cell.textContent?.trim()))
    .filter(text=>text&&text!=='—').map(Number).sort((a,b)=>a-b));
  expect(timedValues).toEqual([7.5,12.5]);
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
  await expect(byId(b, 'summary-tokens')).toHaveText('1.3K');
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
  await expect(omp('[data-testid="usage-response-tps"]')).toHaveText('12.5');
  await omp('[data-testid="usage-row-open"]').click(); await expect(byId(b,'usage-request-detail')).toContainText('12.5 TPS');
  await expect(byId(b,'usage-request-detail')).toContainText('8 秒');
  await row(b,'response-codex-1','[data-testid="usage-row-open"]').click();
  await expect(row(b,'response-codex-1','[data-testid="usage-response-tps"]')).toHaveText('7.5');
  await group(b,'turn'); await expect(row(b,'codex-turn-1','[data-testid="usage-turn-tps"]')).toHaveText('5');
  await row(b,'codex-turn-1','[data-testid="usage-row-open"]').click();
  await expect(byId(b,'usage-row')).toHaveCount(2); await expect(byId(b,'usage-total-tokens')).toHaveText('400');
  await group(b,'model'); await byId(b,'usage-row-open').click(); await ready(b);
  await expect(byId(b,'usage-row')).toHaveCount(2); await expect(byId(b,'usage-total-tokens')).toHaveText('400');
  await expect(byId(b,'usage-drill-context')).toContainText('→');
  await byId(b,'usage-drill-back').click(); await ready(b); await expect(byId(b,'usage-row')).toHaveCount(5);
  await expect(byId(b,'usage-group-turn')).toHaveAttribute('class','selected');
  await group(b,'model'); await expect(byId(b,'usage-response-tps')).toHaveText('—'); await expect(byId(b,'usage-turn-tps')).toHaveText('—');
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
  await expect(row(b,'44444444-2222','[data-testid="usage-session-name"]')).toContainText('未命名会话');
  await expect(row(b,'44444444-1111','[data-testid="usage-session-name"]')).toHaveText('历史会话继续工作');
  await expect(byId(b,'usage-session-id')).toHaveCount(0);
  await b.setViewport({width:1024,height:1100}); await b.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  expect(await b.evaluate(()=>[...document.querySelectorAll('[data-testid="usage-session-name"]')].every(n=>{const r=n.getBoundingClientRect(),p=n.parentElement!.getBoundingClientRect();return r.left>=p.left&&r.right<=p.right&&r.width>0;}))).toBe(true);
  await app.screenshot('long-project-session-names-1024');
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
  await expect(byId(b,'tokens-per-turn')).toHaveText(/65\s*\*/);
  await expect(byId(b,'cost-per-turn')).toHaveText(/\$0\.000250\s*\*/);
  await page(b,'usage'); await group(b,'request');
  await expect(byId(b,'usage-total-cost')).toHaveText('$0.000500*');
  const missing=(child: string)=>b.locator(`tr[data-testid="usage-row"]:has-text("e2e-unpriced") ${child}`);
  await expect(missing('td >> nth=7')).toHaveText('—'); await missing('[data-testid="usage-row-open"]').click();
  await expect(missing('[data-testid="usage-response-tps"]')).toHaveText('—');
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
        if(name==='dashboard') await expect(b.locator('[data-testid="chart-speed"] .chart-isolated-point')).toHaveCount(2);
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
    await expect(byId(b, `time-${id}`)).toHaveValue(local);
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

test('comparison: current period matches KPI values and quiet cost coverage', async ({ browser: b, app }) => {
  await open(b);
  const localPeriod=async(start:string,end:string)=>b.evaluate(values=>values.map(v=>{
    const d=new Date(v),p=(n:number)=>String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }).join(' — '),[start,end]);
  const assertPeriod=async(start:string,end:string)=>{
    await expect(byId(b,'summary-period')).toHaveText(await localPeriod(start,end));
    await expect(byId(b,'comparison-period')).toHaveCount(0);
  };
  await expect(b.locator('.summary-heading h2')).toHaveText('用量概览');
  await assertPeriod('2026-10-01T00:00:00Z','2026-10-01T00:01:30Z');
  // Previous zero is an absolute change, not an explanatory paragraph.
  await expect(byId(b,'summary-change-calls')).toContainText('+6');
  await expect(byId(b,'summary-change-calls')).not.toContainText('上期为');
  await range(b,'2026-10-01T00:01:00Z','2026-10-01T00:01:30Z');
  await assertPeriod('2026-10-01T00:01:00Z','2026-10-01T00:01:30Z');
  await expect(byId(b,'summary-tokens')).toHaveText('500');
  await expect(byId(b,'summary-calls')).toHaveText('3');
  await expect(byId(b,'summary-cost')).toHaveText('$0.002425');
  await expect(byId(b,'summary-change-tokens')).toHaveText('环比 +25.0%');
  await expect(byId(b,'summary-change-calls')).toHaveText('环比 +200.0%');
  await expect(byId(b,'summary-change-cost')).toHaveText('环比 +79.6%');
  const previous=await localPeriod('2026-10-01T00:00:30Z','2026-10-01T00:01:00Z');
  await expect(byId(b,'summary-change-cost')).toHaveAttribute('title',previous);
  expect(await b.evaluate(period=>document.body.innerText.includes(period),previous)).toBe(false);
  await range(b,'2026-10-04T00:00:00Z','2026-10-05T00:00:00Z');
  await assertPeriod('2026-10-04T00:00:00Z','2026-10-05T00:00:00Z');
  await expect(byId(b,'summary-tokens')).toHaveText('300');
  await expect(byId(b,'summary-cost')).toHaveText('$0.001025');
  await expect(byId(b,'summary-change-cost')).toHaveCount(0);
  await expect(byId(b,'summary-note-cost')).toHaveCount(0);
  await range(b,'2026-10-03T00:00:00Z','2026-10-04T00:00:00Z');
  await assertPeriod('2026-10-03T00:00:00Z','2026-10-04T00:00:00Z');
  await expect(byId(b,'summary-tokens')).toHaveText('130');
  await expect(byId(b,'summary-cost')).toHaveText('$0.000500');
  await expect(byId(b,'summary-note-cost')).toHaveText('*');
  await expect(byId(b,'summary-note-cost')).toHaveAttribute('title','1 次调用未计价');
  await expect(byId(b,'summary-change-cost')).toHaveCount(0);
  for(const id of ['source-health','account-attribution','auto-refresh-note']) await expect(byId(b,id)).toHaveCount(0);
  const visible=await b.evaluate(()=>document.body.innerText);
  for(const noise of ['环比上一等长时段','上期为 0','与当前范围相交','当前范围 · 逐桶合计','推理 Tokens 已包含在输出中',
    '四分量相加为 Tokens 小计','仅比较可估价','历史范围不自动刷新','全结果排序']) expect(visible.includes(noise)).toBe(false);
  await byId(b,'theme-dark').click(); await b.setViewport({width:1024,height:1100});
  await b.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>{scrollTo(0,0);r();}))));
  expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await app.screenshot('summary-current-period-dark-1024');
  await range(b,'2026-10-01T00:01:30Z','2026-10-01T00:02:00Z');
  await assertPeriod('2026-10-01T00:01:30Z','2026-10-01T00:02:00Z');
  await expect(byId(b,'summary-cost')).toHaveText('—');
  await expect(byId(b,'summary-note-cost')).toHaveCount(0);
  await expect(byId(b,'summary-change-cost')).toHaveCount(0);
});

test('names: native session titles, project names, tooltips, joint identities and refresh', async ({ browser: b, app }) => {
  await open(b);
  await byId(b,'more-filters').click();
  await b.locator('[data-testid="filter-session"] .facet-trigger').click();
  for (const name of ['费用看板联动','缓存报表核对','响应速度分析','工具耗时整理'])
    await expect(b.locator('[data-testid="filter-session"] .facet-list')).toContainText(name);
  await expect(b.locator('[data-testid="filter-session"] .facet-list')).not.toContainText('11111111');
  await b.locator('[data-testid="filter-session"] .facet-popover > input').fill('缓存报表');
  await expect(b.locator('[data-testid="filter-session"] .facet-list label')).toHaveCount(1);
  await byId(b,'filter-session').getByLabel('缓存报表核对 · Claude Code').check();
  await b.locator('[data-testid="filter-session"] .dismiss').click(); await ready(b);
  await expect(byId(b,'summary-tokens')).toHaveText('400');
  await byId(b,'clear-filters').click(); await ready(b);
  await b.locator('[data-testid="filter-project"] .facet-trigger').click();
  await expect(b.locator('[data-testid="filter-project"] .facet-list span')).toHaveText('workbench');
  await expect(b.locator('[data-testid="filter-project"] .facet-list label')).toHaveAttribute('title','workbench\n/synthetic/workbench');
  await b.locator('[data-testid="filter-project"] .dismiss').click();
  await page(b,'usage');
  await row(b,'response-codex-1','[data-testid="usage-row-open"]').click();
  await expect(byId(b,'detail-session_id')).toHaveText('费用看板联动');
  await expect(byId(b,'detail-session_id')).toHaveAttribute('title','11111111-1111-4111-8111-111111111111');
  await expect(byId(b,'detail-project-name')).toHaveText('workbench');
  await expect(byId(b,'detail-project-name')).toHaveAttribute('title','/synthetic/workbench');
  await expect(byId(b,'detail-turn_id')).toHaveText('已关联轮次');
  await expect(byId(b,'detail-turn_id')).toHaveAttribute('title','codex-turn-1');
  await expect(byId(b,'detail-event_key')).toHaveAttribute('title',/response-codex-1/);
  for (const hidden of ['11111111','/synthetic/','response-codex-1','codex-turn-1'])
    await expect(byId(b,'usage-request-detail')).not.toContainText(hidden);
  await group(b,'session');
  await expect(byId(b,'usage-row')).toHaveCount(4);
  for (const name of ['费用看板联动','缓存报表核对','响应速度分析','工具耗时整理'])
    await expect(byId(b,'usage-table')).toContainText(name);
  await expect(byId(b,'usage-session-id')).toHaveCount(0);
  await range(b,'2026-09-29T00:00:00Z','2026-09-29T00:01:00Z');
  await expect(byId(b,'usage-total-tokens')).toHaveText('80');
  await expect(byId(b,'usage-row')).toHaveCount(3);
  for (const name of ['主目录费用复核','工作树速率复核','Claude 共享身份名称'])
    await expect(byId(b,'usage-table')).toContainText(name);
  await b.locator('[data-testid="filter-project"] .facet-trigger').click();
  await expect(b.locator('[data-testid="filter-project"] .facet-list span')).toHaveText(['reporting','reporting']);
  await b.locator('[data-testid="filter-project"] label[title*="worktrees"] input').check();
  await b.locator('[data-testid="filter-project"] .dismiss').click(); await ready(b);
  await expect(byId(b,'usage-row')).toHaveCount(1);
  await expect(byId(b,'usage-total-tokens')).toHaveText('40');
  await expect(byId(b,'usage-session-name')).toHaveText('工作树速率复核');
  await byId(b,'clear-filters').click(); await ready(b);
  await range(b,'2026-10-04T00:00:00Z','2026-10-04T00:01:00Z');
  await expect(row(b,'44444444-2222','[data-testid="usage-session-name"]')).toContainText('activity');
  await expect(row(b,'44444444-2222','[data-testid="usage-session-name"]')).toContainText('未命名会话');
  await expect(byId(b,'usage-table')).not.toContainText('44444444');
  await range(b);
  const state = JSON.parse(readFileSync(new URL('../../.e2e/fixture-state.json', import.meta.url), 'utf8'));
  execFileSync('python3',[new URL('./fixture_logs.py', import.meta.url).pathname,'--append',state.root,'--rename-sessions']);
  await refresh(b);
  for (const name of ['费用看板新名称','缓存报表新名称','响应速度新名称','工具耗时新名称'])
    await expect(byId(b,'usage-table')).toContainText(name);
  await expect(byId(b,'usage-total-tokens')).toHaveText('1,300');
  await b.reload(); await ready(b);
  await expect(byId(b,'usage-table')).toContainText('费用看板新名称');
  for (const theme of ['light','dark']) {
    await byId(b,`theme-${theme}`).click();
    await b.setViewport({width:1024,height:1100});
    await app.screenshot(`session-project-names-${theme}-1024`);
  }
});

// Kept before the first usage append: the original 1300-token ledger remains
// pristine. Calendar fixture dates/values are hand-counted in README.md.
const calendarCell = (b: Browser, date: string) => b.locator(`[data-testid="usage-calendar"] [data-date="${date}"]`);
async function hoverCalendarDay(b: Browser,date:string) {
  await calendarCell(b,date).scrollIntoView();
  const rect=await b.evaluate(date=>{const r=document.querySelector(`[data-testid="usage-calendar"] [data-date="${date}"]`)!.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},date);
  await b.mouse.move(rect.x,rect.y);
  await expect(byId(b,'calendar-tooltip')).toBeVisible();
}
async function calendarClock(b: Browser) {
  return b.evaluate(() => {
    const now = new Date(), year = now.getFullYear(), p = (n: number) => String(n).padStart(2, '0');
    const day = (d: Date) => `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
    return {year, start:new Date(year,0,1).toISOString(), previousStart:new Date(year-1,0,1).toISOString(),
      dayStart:new Date(year,0,2).toISOString(), dayEnd:new Date(year,0,3).toISOString(),
      today:day(now),todayStart:new Date(year,now.getMonth(),now.getDate()).toISOString(),
      tomorrow:day(new Date(year,now.getMonth(),now.getDate()+1))};
  });
}
test('calendar dashboard: real KPI microtrends and four token components retain unknowns', async ({browser:b,app}) => {
  await open(b);
  for (const [metric,values] of [['tokens',[800,500]],['calls',[3,3]],['cost',[.002660,.002425]]] as const) {
    await expect(byId(b,`summary-sparkline-${metric}`)).toHaveAttribute('data-state','available');
    const points=await b.evaluate(metric=>[...document.querySelectorAll(`[data-testid="summary-sparkline-${metric}"] circle[data-value]`)]
      .map(n=>({value:Math.round(Number(n.getAttribute('data-value'))*1e9)/1e9,start:n.getAttribute('data-start'),end:n.getAttribute('data-end'),
        width:n.getBoundingClientRect().width})),metric);
    expect(points.map(p=>p.value)).toEqual([...values]);
    expect(points.map(p=>[Date.parse(p.start!),Date.parse(p.end!)])).toEqual([
      [Date.parse('2026-10-01T00:00:00Z'),Date.parse('2026-10-01T00:01:00Z')],
      [Date.parse('2026-10-01T00:01:00Z'),Date.parse('2026-10-01T00:01:30Z')],
    ]);
    expect(points.every(p=>p.width>0)).toBe(true);
    const path=await b.locator(`[data-testid="summary-sparkline-${metric}"] path.sparkline-path`).getAttribute('d');
    expect(path!.includes('M')&&path!.includes('L')).toBe(true);
  }
  for(const [part,value] of [['input',540],['cache_read',210],['output',450],['cache_write',100]] as const) {
    await expect(byId(b,`token-part-${part}`)).toHaveAttribute('data-value',String(value));
    await expect(byId(b,`token-part-${part}`)).toHaveAttribute('data-unknown','false');
  }
  expect(await b.evaluate(()=>[...document.querySelectorAll('[data-testid="token-component-bar"] [data-part]')]
    .reduce((sum,n)=>sum+Number(n.getAttribute('data-value')),0))).toBe(1300);
  await app.screenshot('calendar-kpi-and-composition-baseline');
  await range(b,'2026-10-03T00:00:00Z','2026-10-03T00:01:00Z');
  for(const [part,value] of [['input',70],['cache_read',0],['output',60],['cache_write',0]] as const)
    await expect(byId(b,`token-part-${part}`)).toHaveAttribute('data-value',String(value));
  await expect(byId(b,'token-part-cache_write')).toHaveAttribute('data-unknown','true');
  await expect(byId(b,'summary-tokens')).toHaveText('130');
  await range(b,'2026-10-01T00:01:30Z','2026-10-01T00:02:00Z');
  await expect(byId(b,'summary-sparkline-cost')).toHaveAttribute('data-state','unknown');
  await expect(b.locator('[data-testid="summary-sparkline-cost"] svg')).toHaveCount(0);
  await range(b,'2026-10-01T00:02:00Z','2026-10-01T00:03:00Z');
  await expect(byId(b,'summary-calls')).toHaveText('0');
  await expect(byId(b,'token-component-bar')).toHaveAttribute('class',/empty/);
});

test('calendar page: full annual data, isolated dashboard state, day drill and return', async ({browser:b,app}) => {
  const requests:URL[]=[];
  await b.route(/\/api\//,async r=>{requests.push(new URL(r.request.url));await r.continue();});
  await open(b);
  await byId(b,'time-start').fill('2026-10-01T00:00:00Z');
  await byId(b,'time-end').fill('现在'); await byId(b,'time-apply').click(); await ready(b);
  await harness(b);
  for(const [dimension,label] of [['model','e2e-known'],['account','账号未知']]) {
    await b.locator(`[data-testid="filter-${dimension}"] .facet-trigger`).click();
    await byId(b,`filter-${dimension}`).getByLabel(label).check();
    await b.locator(`[data-testid="filter-${dimension}"] .dismiss`).click(); await ready(b);
  }
  await expect(byId(b,'summary-tokens')).toHaveText('3.3K');
  await expect(byId(b,'summary-tokens')).toHaveAttribute('title','Tokens 3,339');
  await expect(byId(b,'summary-calls')).toHaveText('30');
  await expect(byId(b,'value-consumption')).toHaveText('$0.0231');
  await settings(b,'consumption'); await byId(b,'members-consumption').click();
  await b.locator('[data-testid="panel-consumption"] .panel-members').getByLabel('e2e-known').check(); await ready(b);
  await settings(b,'consumption',true);
  const savedDashboard=async()=>b.evaluate(()=>{
    const p=JSON.parse(localStorage.getItem('usage-dashboard.preferences.v4')!).preferences;
    return {global:p.global,timeSpec:p.timeSpec,panels:p.panels,history:p.history};
  });
  const before=await savedDashboard(),clock=await calendarClock(b),year=clock.year;
  const latest=()=>requests.filter(q=>q.pathname==='/api/analytics').at(-1)!;
  const annual=()=>requests.filter(q=>q.pathname==='/api/calendar').at(-1)!;
  const assertAnnual=(expectedYear=year)=>{
    const q=annual(); expect(q.searchParams.get('year')).toBe(String(expectedYear));
    expect([...q.searchParams.keys()].sort()).toEqual(['timezone','year']);
  };
  const sumCells=async(metric:'tokens'|'cost'|'calls')=>b.evaluate(metric=>{
    const labels={tokens:'Tokens',cost:'估算费用',calls:'调用'};
    return [...document.querySelectorAll('[data-testid="usage-calendar"] [data-date]:not([data-state="padding"])')]
      .reduce((sum,n)=>{const text=n.getAttribute('aria-label')||'';
        const amount=text.split(labels[metric]+' ')[1]?.match(/^\$?([\d,.]+)/)?.[1];
        return sum+(amount?Number(amount.replaceAll(',','')):0);},0);
  },metric);
  const response=b.waitForResponse(/\/api\/calendar(?:\?|$)/);
  const start=requests.length,entered=Date.now(); await page(b,'calendar');
  await expect(calendarCell(b,`${year}-10-02`)).toHaveAttribute('aria-label',/Tokens 2,?539/);
  const enterMs=Date.now()-entered;
  expect(requests.slice(start).map(q=>q.pathname)).toEqual(['/api/calendar']); assertAnnual();
  const boundary=await (await response).json<{start:string;end:string}>();
  expect(Date.parse(boundary.start)).toBe(Date.parse(clock.start));
  expect(Math.abs(Date.parse(boundary.end)-Date.now())<5000).toBe(true);
  for(const id of ['global-query','account-periods','calendar-view','trend-view','summary']) await expect(byId(b,id)).toHaveCount(0);
  expect(await sumCells('tokens')).toBe(4879);
  await expect(calendarCell(b,clock.tomorrow)).toHaveAttribute('data-state','future');
  await expect(calendarCell(b,clock.tomorrow)).toBeDisabled();
  const metricRequests=requests.length;
  await byId(b,'calendar-metric-calls').click(); expect(await sumCells('calls')).toBe(46);
  await byId(b,'calendar-metric-cost').click(); expect(Math.round(await sumCells('cost')*1e6)).toBe(29189);
  expect(requests.length).toBe(metricRequests);
  await expect(calendarCell(b,`${year}-01-03`)).toHaveAttribute('data-state','unknown');
  await hoverCalendarDay(b,`${year}-01-03`); await expect(b.locator('[data-testid="calendar-tooltip"] dd').first()).toHaveText('30*');
  await expect(calendarCell(b,`${year}-01-04`)).toHaveAttribute('data-state','partial');
  await hoverCalendarDay(b,`${year}-01-04`); await expect(byId(b,'calendar-tooltip')).toContainText('$0.00028*');
  const pastResponse=b.waitForResponse(/\/api\/calendar(?:\?|$)/);
  await byId(b,'calendar-prev-year').click(); await ready(b);
  await expect(calendarCell(b,`${year-1}-12-31`)).toHaveAttribute('aria-label',/\$0\.000485/);
  assertAnnual(year-1);
  const pastBoundary=await (await pastResponse).json<{start:string;end:string}>();
  expect(Date.parse(pastBoundary.start)).toBe(Date.parse(clock.previousStart)); expect(Date.parse(pastBoundary.end)).toBe(Date.parse(clock.start));
  expect(Math.round(await sumCells('cost')*1e6)).toBe(27510);
  await b.reload(); await ready(b); await expect(byId(b,'calendar-year')).toContainText(String(year-1));
  await expect(byId(b,'calendar-page')).toHaveAttribute('aria-busy','false');
  await expect(byId(b,'calendar-metric-cost')).toHaveAttribute('class','selected');
  assertAnnual(year-1); expect(await savedDashboard()).toEqual(before);
  const refreshResponse=b.waitForResponse(/\/api\/calendar(?:\?|$)/);
  await byId(b,'calendar-refresh').click(); await refreshResponse;
  await expect(byId(b,'calendar-page')).toHaveAttribute('aria-busy','false'); expect(await savedDashboard()).toEqual(before);
  await page(b,'dashboard');
  await expect(byId(b,'summary-tokens')).toHaveAttribute('title','Tokens 3,339');
  expect(await savedDashboard()).toEqual(before);
  await settings(b,'consumption'); await expect(byId(b,'members-consumption')).toContainText('1'); await settings(b,'consumption',true);
  await page(b,'calendar'); await byId(b,'calendar-next-year').click(); await ready(b);
  await expect(byId(b,'calendar-next-year')).toBeDisabled();
  await expect(calendarCell(b,`${year}-10-02`)).toHaveAttribute('aria-label',/\$0\.020312/); assertAnnual();
  await byId(b,'theme-dark').click(); await b.setViewport({width:1024,height:1100});
  await b.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>{scrollTo(0,0);r();}))));
  expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const grid=await b.evaluate(()=>{const cells=[...document.querySelectorAll('[data-testid="usage-calendar"] [data-date]:not([data-state="padding"])')];
    return{days:cells.length,rows:new Set(cells.map(n=>Math.round(n.getBoundingClientRect().top))).size,visible:cells.every(n=>n.getBoundingClientRect().width>0)};});
  expect(grid).toEqual({days:365,rows:7,visible:true});
  await hoverCalendarDay(b,`${year}-10-02`); await expect(byId(b,'calendar-tooltip')).toContainText('2,539');
  await app.screenshot('calendar-full-year-dark-1024');
  await calendarCell(b,`${year}-01-02`).click(); await ready(b);
  await expect(byId(b,'summary-tokens')).toHaveText('200'); await expect(byId(b,'calendar-view')).toHaveCount(0);
  expect(Date.parse(latest().searchParams.get('start')!)).toBe(Date.parse(clock.dayStart)); expect(Date.parse(latest().searchParams.get('end')!)).toBe(Date.parse(clock.dayEnd));
  const cleared=await savedDashboard(); expect(cleared.global.filters).toEqual({}); expect(cleared.history).toEqual([]);
  expect(Object.values(cleared.panels as Record<string,{members:string[]}>).every(p=>p.members.length===0)).toBe(true);
  await page(b,'usage'); await expect(byId(b,'usage-total-tokens')).toHaveText('200'); await vector(b,[1,50,30,20,100]);
  await page(b,'calendar'); await expect(byId(b,'calendar-year')).toContainText(String(year));
  await expect(byId(b,'calendar-metric-cost')).toHaveAttribute('class','selected');
  // A current-day jump cannot put an end in the future.
  await calendarCell(b,clock.today).click(); await ready(b);
  expect(Date.parse(latest().searchParams.get('start')!)).toBe(Date.parse(clock.todayStart));
  expect(Math.abs(Date.parse(latest().searchParams.get('end')!)-Date.now())<5000).toBe(true);
  // Preserve one local timing record with the report, without a benchmark matrix.
  writeFileSync(new URL('../../.e2e/calendar-entry.json',import.meta.url),JSON.stringify({enterMs,year,tokens:4879,calls:46}));
});

// Account logs live in May 2025, with a separate project. Only quota metadata
// uses the current clock; no recent usage append or original ledger is changed.
test('account periods: native directory, refresh and fixed current-period cutoff', async ({browser:b,app}) => {
  const requests:URL[]=[];
  await b.route(/\/api\//,async r=>{requests.push(new URL(r.request.url));await r.continue();});
  const directory=await openAccountWindow(b);
  await chooseAccountPeriod(b,directory,'fixture-a@example.invalid','Fixture ended 5 Hour');
  await expect(byId(b,'account-info')).toContainText('订阅');
  await expect(byId(b,'account-info')).toContainText('周期已结束');
  await expect(byId(b,'account-quota-fraction')).toHaveText('25%');
  await expect(byId(b,'account-quota')).toContainText('e2e-known');
  await chooseAccountPeriod(b,directory,'fixture-a@example.invalid','Fixture missing start');
  await expect(byId(b,'apply-account-period')).toBeDisabled();
  for(const kind of ['api_key','gateway_credential']) {
    await byId(b,'account-select').selectOption({value:directory.accounts.find(a=>a.kind===kind)!.account_ref});
    await expect(byId(b,'account-period-select')).toBeDisabled();
    await expect(byId(b,'apply-account')).toBeEnabled();
    await expect(byId(b,'account-info')).toContainText(kind==='api_key'?'API':'网关');
  }
  await chooseAccountPeriod(b,directory,'fixture-b@example.invalid','Fixture stale active 5 Hour');
  await expect(byId(b,'account-info')).toContainText('已过期');
  await expect(byId(b,'account-info')).not.toContainText('周期已结束');
  await chooseAccountPeriod(b,directory,'fixture-a@example.invalid','Fixture ended 5 Hour');
  execFileSync('python3',[new URL('./fixture_logs.py',import.meta.url).pathname,'--append',fixtureRoot(),'--update-account-metadata']);
  await refresh(b);
  await expect(byId(b,'account-quota-fraction')).toHaveText('55%');
  await expect(byId(b,'account-period-select')).toContainText('Fixture ended 5 Hour refreshed');
  await expect(byId(b,'summary-tokens')).toHaveText('660');
  await expect(byId(b,'value-consumption')).toHaveText('$0.003025');
  await b.setViewport({width:1024,height:1100});
  await b.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await b.evaluate(()=>[...document.querySelectorAll('.dashboard-chart .recharts-surface')]
    .every(n=>n.getBoundingClientRect().width>0))).toBe(true);
  const height=await b.evaluate(()=>{scrollTo(0,0);return Math.max(1100,document.documentElement.scrollHeight);});
  await b.setViewport({width:1024,height}); await app.screenshot('account-periods-dashboard-1024');
  await b.setViewport({width:1600,height:1100});
  const {period}=await chooseAccountPeriod(b,directory,'fixture-a@example.invalid','Fixture current 5 Hour');
  const before=Date.now(); await byId(b,'apply-account-period').click(); await ready(b); const after=Date.now();
  const latest=()=>requests.filter(q=>q.pathname==='/api/analytics').at(-1)!;
  const fixed=latest().searchParams.get('end')!;
  expect(Date.parse(latest().searchParams.get('start')!)).toBe(Date.parse(period.start!));
  expect(Date.parse(fixed)>=before&&Date.parse(fixed)<=after).toBe(true);
  expect(Date.parse(fixed)<Date.parse(period.end!)).toBe(true);
  await refresh(b); expect(latest().searchParams.get('end')).toBe(fixed);
  await b.reload(); await ready(b); expect(latest().searchParams.get('end')).toBe(fixed);
});

test('account periods: native boundaries, unified statistics and model/provider/account drill return', async ({browser:b}) => {
  const requests:URL[]=[];
  await b.route(/\/api\//,async r=>{requests.push(new URL(r.request.url));await r.continue();});
  const directory=await openAccountWindow(b);
  await page(b,'usage');
  for(const [name,count] of [['model',2],['provider',2],['account',5]] as const) {
    await group(b,name); await expect(byId(b,'usage-row')).toHaveCount(count);
    await expect(byId(b,'usage-total-tokens')).toHaveText('660');
    await expect(byId(b,'usage-total-cost')).toHaveText('$0.003025'); await vector(b,[7,280,50,40,290]);
  }
  await expect(byId(b,'usage-table')).toContainText('fixture-a@example.invalid');
  await expect(byId(b,'usage-table')).toContainText('fixture-b@example.invalid');
  await expect(byId(b,'usage-table')).toContainText('账号未知');
  await b.locator('tr[data-testid="usage-row"]:has-text("账号未知") [data-testid="usage-row-open"]').click(); await ready(b);
  await expect(byId(b,'usage-total-tokens')).toHaveText('100'); await vector(b,[1,60,0,0,40]);
  expect(requests.filter(q=>q.pathname==='/api/usage').at(-1)!.searchParams.getAll('account')).toEqual(['']);
  await byId(b,'usage-drill-back').click(); await ready(b);
  const a=directory.accounts.find(a=>a.label.includes('fixture-a@'))!;
  await row(b,a.account_ref,'[data-testid="usage-row-open"]').click(); await ready(b);
  await expect(byId(b,'usage-total-tokens')).toHaveText('240'); await vector(b,[3,60,30,40,110]);
  expect(requests.filter(q=>q.pathname==='/api/usage').at(-1)!.searchParams.getAll('account')).toEqual([a.account_ref]);
  await byId(b,'usage-drill-back').click(); await ready(b);
  await expect(byId(b,'usage-group-account')).toHaveAttribute('class','selected');
  await expect(byId(b,'usage-total-tokens')).toHaveText('660');
  await page(b,'dashboard');
  await b.locator('[data-testid="filter-project"] .facet-trigger').click();
  await b.locator('[data-testid="filter-project"] label[title*="/synthetic/accounts"] input').check();
  await b.locator('[data-testid="filter-project"] .dismiss').click(); await ready(b);
  await b.locator('[data-testid="filter-model"] .facet-trigger').click();
  await byId(b,'filter-model').getByLabel('e2e-known',{exact:true}).check();
  await b.locator('[data-testid="filter-model"] .dismiss').click(); await ready(b);
  const ended=directory.periods.find(p=>p.account_ref===a.account_ref&&p.start&&Date.parse(p.end!)===Date.parse(accountWindow.end))!;
  await accountCatalog(b); await byId(b,'account-select').selectOption({value:a.account_ref});
  await byId(b,'account-period-select').selectOption({value:ended.id});
  await byId(b,'apply-account-period').click(); await ready(b);
  await expect(byId(b,'summary-tokens')).toHaveText('180'); await expect(byId(b,'summary-calls')).toHaveText('2');
  await expect(byId(b,'value-consumption')).toHaveText('$0.000910');
  const latest=()=>requests.filter(q=>q.pathname==='/api/analytics').at(-1)!;
  let query=latest();
  expect(Date.parse(query.searchParams.get('start')!)).toBe(Date.parse(accountWindow.start));
  expect(Date.parse(query.searchParams.get('end')!)).toBe(Date.parse(accountWindow.end));
  for(const [key,value] of [['account',a.account_ref],['provider','anthropic'],['harness','omp'],['model','e2e-known'],['project','/synthetic/accounts']])
    expect(query.searchParams.getAll(key)).toEqual([value]);
  await byId(b,'account-period-select').selectOption({value:directory.periods.find(p=>p.label==='Fixture ended 7 Day')!.id});
  await byId(b,'apply-account-period').click(); await ready(b);
  await expect(byId(b,'summary-tokens')).toHaveText('2.2K');
  await expect(byId(b,'summary-tokens')).toHaveAttribute('title','Tokens 2,180');
  await byId(b,'account-period-select').selectOption({value:ended.id});
  await byId(b,'apply-account-period').click(); await ready(b);
  await expect(byId(b,'summary-tokens')).toHaveText('180');
  const selectedB=await chooseAccountPeriod(b,directory,'fixture-b@example.invalid','Fixture B ended 5 Hour');
  await byId(b,'apply-account-period').click(); await ready(b);
  await expect(byId(b,'summary-tokens')).toHaveText('120'); await expect(byId(b,'value-consumption')).toHaveText('$0.000570');
  expect(latest().searchParams.getAll('account')).toEqual([selectedB.account.account_ref]);
  await byId(b,'rank-group-account').click();
  await b.locator('[data-testid="absolute-ranking"] button[title*="fixture-b@example.invalid"]').click(); await ready(b);
  await page(b,'usage'); await group(b,'account'); await expect(byId(b,'usage-total-tokens')).toHaveText('120');
  await byId(b,'usage-row-open').click(); await ready(b);
  await group(b,'model'); await expect(byId(b,'usage-table')).toContainText('fixture-b@example.invalid');
  await byId(b,'usage-row-open').click(); await ready(b); await vector(b,[1,40,20,0,60]);
  await byId(b,'usage-row-open').click(); await expect(byId(b,'usage-request-detail')).toContainText('fixture-b@example.invalid');
  await byId(b,'usage-drill-back').click(); await ready(b); await b.reload(); await ready(b);
  await expect(byId(b,'usage-group-account')).toHaveAttribute('class','selected');
  await expect(byId(b,'usage-total-tokens')).toHaveText('120');
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
  await expect(byId(b,'auto-refresh-note')).toHaveCount(0);
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

test('automatic refresh: enabling scans immediately and each period receives appended data', async ({ browser: b, app }) => {
  let posts = 0;
  await b.route(/\/api\//, async r => {
    if (r.request.method === 'POST' && new URL(r.request.url).pathname === '/api/refresh') posts++;
    await r.continue();
  });
  await b.goto('/', { waitUntil: 'networkidle' }); await ready(b);
  await byId(b, 'time-start').fill('-1h'); await byId(b, 'time-start').press('Enter'); await ready(b);
  const baseline = Number(await byId(b, 'summary-calls').textContent());
  append(997);
  await byId(b, 'auto-period-15').click();
  const enabled = b.waitForResponse(/\/api\/refresh/, { timeout: 5000 });
  await byId(b, 'auto-refresh-toggle').check(); await enabled;
  await expect(byId(b, 'summary-calls')).toHaveText(String(baseline + 1));
  await expect(byId(b, 'auto-refresh-state')).toContainText('最近');
  const beforePeriod = posts;
  append(998);
  await b.waitForResponse(/\/api\/refresh/, { timeout: 25000 });
  await expect(byId(b, 'summary-calls')).toHaveText(String(baseline + 2));
  expect(posts > beforePeriod).toBe(true);
  await byId(b, 'auto-refresh-toggle').uncheck();
  await app.screenshot('automatic-refresh-immediate-and-periodic');
});

test('calendar cancel: opening and dismissing a picker does not leave refresh paused', async ({ browser: b, app }) => {
  await b.goto('/', { waitUntil: 'networkidle' }); await ready(b);
  await byId(b, 'time-start-picker').click(); await b.keyboard.press('Escape');
  await expect(byId(b, 'resolved-range')).not.toContainText('编辑期间暂停自动刷新');
  await app.screenshot('cancelled-calendar-resumes-refresh');
});

test('current time: input blur, Enter, refresh and browser reload resolve the actual clock', async ({ browser: b, app }) => {
  const requests: URL[] = [];
  await b.route(/\/api\//, async r => { requests.push(new URL(r.request.url)); await r.continue(); });
  await open(b);
  const latest = () => requests.filter(r => r.pathname === '/api/analytics').at(-1)!;
  await byId(b,'time-start').fill('-3h');
  await byId(b,'time-end').fill('现在');
  await refresh(b);
  let q = latest();
  expect(Date.parse(q.searchParams.get('end')!) - Date.parse(q.searchParams.get('start')!)).toBe(3*3600000);
  expect(Math.abs(Date.parse(q.searchParams.get('end')!)-Date.now())<5000).toBe(true);
  const before = q.searchParams.get('end')!;
  await wait(100); await b.reload(); await ready(b);
  q = latest();
  expect(Date.parse(q.searchParams.get('end')!) > Date.parse(before)).toBe(true);
  expect(Math.abs(Date.parse(q.searchParams.get('end')!)-Date.now())<5000).toBe(true);
  await byId(b,'time-start').fill('-1h'); await byId(b,'time-start').press('Enter'); await ready(b);
  q = latest();
  expect(Date.parse(q.searchParams.get('end')!) - Date.parse(q.searchParams.get('start')!)).toBe(3600000);
  const calls = Number(await byId(b,'summary-calls').textContent());
  append(501);
  await byId(b,'time-start').fill('-2h');
  await refresh(b);
  q = latest();
  expect(Date.parse(q.searchParams.get('end')!) - Date.parse(q.searchParams.get('start')!)).toBe(2*3600000);
  expect(Math.abs(Date.parse(q.searchParams.get('end')!)-Date.now())<5000).toBe(true);
  await expect(byId(b,'summary-calls')).toHaveText(String(calls+1));
  const applied = q.searchParams.get('end')!;
  await byId(b,'time-start').fill('2100-01-01T00:00:00Z');
  const posts = requests.filter(r=>r.pathname==='/api/refresh').length;
  await byId(b,'scan-data').click();
  await expect(b.locator('[role="alert"]')).toHaveText('开始时间不能晚于现在');
  expect(requests.filter(r=>r.pathname==='/api/refresh').length).toBe(posts);
  expect(latest().searchParams.get('end')).toBe(applied);
  await byId(b,'time-start').fill('-2h'); await byId(b,'time-start').press('Enter'); await ready(b);
  await app.screenshot('current-clock-without-apply');
});
