# 本机用量工作台 API

所有数值由服务端同一查询生成，界面直接展示 API 数值。时间窗口为 `[start,end)`，参数时间必须包含 UTC offset；分桶使用显式 IANA 时区。成本是日志记录或公开价格折算的用量成本，保留已知小计及缺价覆盖信息。

## 查询参数

`GET /api/analytics` 接收以下参数；`GET /api/sessions` 复用时间与筛选参数。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| start, end | 全部可用事件时间范围 | ISO 8601，必须带 offset；必须一起提供 |
| timezone | UTC | IANA 名称，例如 Asia/Singapore、America/New_York |
| bucket | day | hour / day / week / month；week 从周一开始 |
| group_by | harness | harness / model / provider / project / agent_type / purpose / service_tier / session；逗号分隔支持多个维度，最多 3 个 |
| metric | cost_usd | cost_usd / tokens / calls / input / output / cache_read / cache_write / cache_hit_rate / cost_per_call / cost_per_mtok |
| harness、model 等维度名 | 无 | 可重复参数，多值同维 OR，跨维 AND；空字符串匹配未知值 |
| member | 自动 Top 5 | 重复传 breakdown 的 key 可指定比较成员；其他成员合并 Other |
| offset, limit | 0, 50 | 仅会话列表；limit 最大 200 |

最多返回 2000 个时间桶，超限响应 400，用户需要扩大桶粒度或缩短时间窗。会话标识通过 `(harness,session_id)` 唯一确定。`session` 筛选值为原始 session_id，跨源联合查询可以用 harness 限定。

## 分析响应

```json
{
  "snapshot": {"id": "12"},
  "query": {"start": "2026-10-01T00:00:00Z", "end": "2026-10-05T00:00:00Z", "timezone": "Asia/Singapore", "bucket": "day", "group_by": ["harness"], "metric": "cost_usd", "filters": {}},
  "summary": {"calls": 3, "input": 300, "input_net": 200, "output": 100, "tokens": 400, "cache_read": 100, "cache_write": null, "cache_hit_rate": null, "cost_usd": 0.02, "cost_complete": false, "priced_calls": 2, "unpriced_calls": 1, "cost_per_call": null, "cost_per_mtok": null, "sessions": 2, "tps": []},
  "trend": {
    "members": [{"key": "codex", "label": "codex"}, {"key": "__other__", "label": "Other"}],
    "buckets": [{"start": "2026-09-30T16:00:00Z", "end": "2026-10-01T16:00:00Z", "label": "2026-10-01", "metrics": {}, "value": null, "series": [{"key": "codex", "metrics": {}, "value": null, "share": null}, {"key": "__other__", "metrics": {}, "value": 0, "share": null}]}]
  },
  "breakdown": [{"key": "codex", "label": "codex", "dimensions": {"harness": "codex"}, "metrics": {}, "value": null, "share": null}],
  "comparison": {"start": "2026-09-27T00:00:00Z", "end": "2026-10-01T00:00:00Z", "summary": {}, "delta": {}, "members": [{"key": "codex", "label": "codex", "current": {}, "previous": {}, "delta": {}, "contribution": null}]},
  "coverage": {"events": 3, "priced_calls": 2, "unpriced_calls": 1, "priced_ratio": 0.6666666666666666, "missing_price_models": ["unknown-model"], "quality": {"exact": 3}, "sources": []}
}
```

`metrics` 复用 summary 的计量字段；空对象在示例中用于省略重复字段。所有成员均在 breakdown 与 comparison.members 中返回。单维 key 为原始维度值；未知值 key 为空字符串，label 为 `Unknown`。多维 key 为 JSON 字符串数组，dimensions 保留原始字段。

`input = input_net + cache_read + cache_write`；`tokens = input + output`。缓存写未知时，input/tokens 是已记录分量小计，cache_write 显示 null，附 `cache_write_complete=false`。cache_hit_rate 使用已知且口径完整的输入计算 `Σcache_read / Σinput`；存在未知缓存写时该比率返回 null。比率按合计分子分母计算。成本缺价时 cost_usd 保留已知小计，cost_complete=false；桶内 priced_calls>0 时 trend.value 展示已知小计，全部缺价时 value=null。成本效率比率在缺价时返回 null。未知值不会绘成零；确实没有事件的时间桶会补零，分母为零的比率为 null。

趋势固定使用本窗口 Top 5 成员与 Other，所有桶成员顺序一致；指定 member 时使用指定列表与 Other。每个 series.metrics 都保留合计字段，适用于表格、绝对值与占比展示。加性指标按成员求和守恒；比率不能按成员百分比相加。share 对加性指标提供，分母为零返回 null；费用 share 的分母是已知估算小计，前端需同时显示缺价覆盖。

comparison 使用紧邻当前窗的上一等长 UTC 时间窗。comparison.members 和 breakdown 均使用两窗成员并集，包含本窗消失的成员。cost_coverage_changed 标记费用覆盖变化。每个 delta 指标含 `{absolute,relative}`；上一值为零时 relative=null，新增成员仍保留 absolute。成本增量缺价时 absolute=null；两窗已知成本小计增量另外提供 `cost_usd_known`。成员 contribution 是选定加性指标增量除以总增量；总增量为零或缺值时 null。

TPS 样本按 harness 与 kind 分开返回 `{harness,kind,output,seconds,samples,tps}`；只包含完整落入分析窗的时间样本，不跨定义平均，缺时间样本时列表为空。

facets 返回各维度过滤候选，计算时去除自身维度的筛选，保留其他维度与当前时间窗。

source_cost_usd/source_cost_calls 单列来源 api_estimate 金额及记录数；source_cost_by_kind 保留不同来源金额定义的分项。source_total/source_total_calls 是来源总量及覆盖数，source_total_difference 是已知总量记录与四分量总计的差值。OMP orchestration 等额外用量通过 extra_tokens 保留；Claude 缓存写 TTL 分项和 reasoning 都是子集，禁止再次叠加 tokens。

coverage.sources 是同一 SQLite 快照内的文件扫描状态摘要，包含 harness/state/files/events/warnings/errors。`GET /api/status` 由服务返回数据源发现、索引范围、扫描状态和最近刷新结果；`POST /api/refresh` 显式触发本机日志重扫。

## 会话响应

`GET /api/sessions` 返回 `{snapshot,query,total,offset,limit,sessions}`，列表每行包含 harness/session_id、first/last（窗内事件范围）、model/provider/project/agent_type/purpose/service_tier 值集合及 metrics；默认按 last 降序。列表的聚合值与 analytics 使用相同查询实现。

`GET /api/sessions/{harness}/{sid}` 接收可选 start/end/timezone，返回 `{snapshot,session,summary,events}`。events 保留 token 分量、元数据、来源质量与服务端计算成本，排除正文；session.children 返回同源子会话 ID。无对应会话时服务端返回 404。列表和详情独立请求时可以发生刷新，前端依据 snapshot.id 识别快照变化。

## Python 调用

`QueryRequest.from_params(parse_qs_result)` 统一校验和解析。`AnalyticsQuery(index, pricing=None)` 提供 `analytics(request)`、`sessions(request, offset=0, limit=50)`、`session_detail(harness, sid, request=None)`。查询错误抛出 ValueError，HTTP 层转换为 400；详情不存在返回 None。
