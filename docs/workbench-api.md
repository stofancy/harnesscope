# 本机用量工作台 API

所有数值由服务端同一查询生成，界面直接展示 API 数值。时间窗口为 `[start,end)`，参数时间必须包含 UTC offset；分桶使用显式 IANA 时区。成本是日志记录或公开价格折算的用量成本，保留已知小计及缺价覆盖信息。

## 查询参数

`GET /api/analytics` 接收以下参数；`GET /api/sessions` 复用时间与筛选参数。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| start, end | 全部可用事件时间范围 | ISO 8601，必须带 offset；必须一起提供 |
| timezone | UTC | IANA 名称，例如 Asia/Singapore、America/New_York |
| bucket | day | auto / second / 5second / 10second / 30second / minute / 5minute / 15minute / hour / day / week / month；week 从周一开始 |
| group_by | harness | harness / model / provider / project / agent_type / purpose / service_tier / session；逗号分隔支持多个维度，最多 3 个 |
| metric | cost_usd | cost_usd / tokens / calls / input / output / cache_read / cache_write / cache_hit_rate / cost_per_call / cost_per_mtok / tpm / rpm / throughput_tps / rps |
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

`metrics` 复用 summary 的计量字段；空对象在示例中用于省略重复字段。所有成员均在 breakdown 与 comparison.members 中返回。单维 key 为原始维度值；未知值 key 为空字符串，label 为 `Unknown`。多维 key 为 JSON 字符串数组，dimensions 保留原始字段。session 分组始终使用包含 harness 的联合 key：单独 session 为 `[harness,session_id]`，多维且未显式包含 harness 时在数组前追加 harness，以防不同来源同名会话合并。

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

## 轮次、工具与细粒度速率（第二轮）

时间粒度支持 `auto/second/5second/10second/30second/minute/5minute/15minute`，保留 `hour/day/week/month`。
`auto` 按当前窗选择约 120 桶以内的粒度，最细为 minute；显式 second/10second 受 2000 桶上限约束。
`query.bucket` 保留请求值，`query.bucket_resolved` 为实际粒度。每桶增加 `seconds/window_start/window_end`，
其中 seconds 是完整桶与 `[start,end)` 的实际交集秒数。summary 和每桶 metrics 均增加 seconds、
`tpm=tokens/seconds*60`、`rpm=calls/seconds*60`、`throughput_tps=tokens/seconds`、`rps=calls/seconds`。
这些量表示本机已记录用量在分析窗内的平均速率，分母包含空闲时间。

`trend.timing_members` 是 `{key,harness,kind,label}` 数组；每桶 `timed_tps` 按相同顺序返回
`{key,harness,kind,value,output,seconds,samples}`。value 使用真实计时样本的 `Σoutput/Σseconds`，
无样本时 null。完整落入分析窗的样本按完成时间分配到一个桶，分母保留该样本完整耗时，
完成时间正好等于桶尾时归入该桶。不同 harness/kind 分开绘制，summary.tps 保留原有定义。

`GET /api/turns` 复用 QueryRequest 与 offset/limit（0/50、最大 200），支持
`sort=start|cost_usd|tokens|duration|calls|tool_calls` 与 `order=asc|desc`，默认 start/desc。
完整筛选结果先排序再分页；null 始终靠后，同值按 harness/session_id/turn_id/key 升序稳定排序。
start 使用开始时间；cost_usd/tokens/calls 使用窗内已记录小计（无任何定价记录的费用排序值为 null）；
duration 使用起止时间差，未闭合为 null；tool_calls 使用已记录工具数量。非法值或重复参数响应 400。
返回 `{snapshot,query,sort,order,summary,trend,tools,rows,total,offset,limit,coverage}`。
`include_rows=false` 返回空 rows，保留同一快照的 summary/trend/tools/coverage/total，供 Dashboard 聚合面板使用；默认 true，仅接受单个 true/false 值。

- `rows` 每项包含原始 TurnRecord 元数据、start/end、status、duration_seconds、full_window、
  recorded_usage_available、usage_scope、window_metrics、full_metrics、tool_calls_known、tool_calls、tool_coverage。
  轮次凭窗内开始/结束边界、匹配的窗内调用或窗内工具开始/结束边界活动入选。
  仅历史开始且结束未知的轮次不会永久进入后续窗口；缺结束仍保留未知，不设置过期时长或补造结束。
  窗内 calls/tokens/cost 使用同窗口
  与全局筛选条件，usage_scope 为 `filtered_calls` 或 `all_recorded_calls`。
  模型/provider/purpose/service_tier 筛选通过窗内匹配的 UsageEvent 选择轮次，工具仍统计这些轮次的
  已记录工具调用，返回 `tool_scope=selected_turns`。
- `full_window` 表示完整闭合区间落在窗内；有已记录调用时 recorded_usage_available=true，full_metrics 提供整轮已记录小计。
  exact/inferred 边界均保留数据及标识，来源遗漏调用无法由已有记录证明完整，字段不声明完整账单。
  缺价时 cost_complete=false，成本效率与每轮成本为 null；截断、运行中或没有已记录调用时 full_metrics=null。
  window_metrics 始终保留窗内已记录小计。
- summary 包含 turns、status_counts、metrics（所有所选轮次的窗内匹配用量）、tool_calls_known、
  tool_calls、tools_per_turn、duration_p50/duration_p95、duration_samples、full_turns、per_turn。
  per_turn 使用完整落窗、已结束且有已记录调用的轮次，含 samples/calls/tokens/cost_usd/scope/boundary_quality；
  scope=recorded_usage，模型筛选下为匹配调用的每轮值，保留 exact/inferred 样本数量。
  输入组成未知时 per_turn.tokens=null，缺价时 per_turn.cost_usd=null。另提供 tokens_known_mean 与
  cost_usd_known_mean：使用相同 samples 作分母，将样本的已记录 tokens/已知估算费用小计合计后除以样本数。
  tokens_complete_samples/cost_complete_samples/cost_priced_samples 分别标出输入组成完整、所有调用有价、
  至少一条调用有价的样本数量；这些覆盖数少于 samples 时，已记录均值应显示“部分”。
  全部样本没有可计价调用时 cost_usd_known_mean=null，已知零价调用可以为 0。均值覆盖明确保留缺价，
  不表达未定价调用免费。耗时分位数使用完整闭合且有起止时间的
  轮次，以秒返回，采用线性插值；duration_boundary_quality 显示 exact/inferred 样本数量。
  tool_coverage 任一为 partial/unknown 时 tool_calls/tools_per_turn=null，known 小计持续可见。
- trend 为 `{buckets}`；每桶包含 start/end/window_start/window_end/seconds、metrics、turns、status_counts、
  tool_calls_known、tool_calls、duration_p50/duration_p95。用量按事件时间分配，轮次数量按最早窗内活动时间 activity_us 分配。
  工具仅在开始或结束边界落窗时计入，按窗内开始时间分桶；开始早于窗时按窗内结束时间分桶。
  历史未结束工具无窗内边界活动时不进入统计。工具 count 是窗内有边界活动的已记录数量。
- tools 返回 `{coverage,scope,status_counts,rows}`，rows 按工具名包含 tool_name/calls/status_counts/
  duration_p50/duration_p95/duration_samples；覆盖部分缺失时这些 count 表示已记录数量。
- coverage 包含 boundary_quality、tool_coverage 分布、truncated_turns、unassigned_calls、usage_scope。
  unassigned_calls 表示符合当前筛选、时间窗但没有已选轮次归属的事件；usage_quality 保留调用质量分布。

`GET /api/turns/detail?harness=...&session_id=...&turn_id=...` 使用 URL 编码参数定位，
返回 `{snapshot,query,turn,calls,tools,window_metrics,recorded_metrics,usage_scope,related_turns}`，
元数据与工具排除正文和参数。calls/tools 显示整轮已记录内容并用 in_window 标记当前窗归属；
调用仍遵循模型/provider/purpose/service_tier 等全局筛选，usage_scope 明确其范围。
recorded_metrics 标为整轮已记录小计，完整性取决于边界与日志质量，保留缺价信息。
related_turns 仅返回有依据的 root_turn_id 关联，parent_session_id 单独保留为元数据，未知轮次关系保持未知。

Python 新增 `AnalyticsQuery.turns(request,offset=0,limit=50,sort='start',order='desc',include_rows=True)`、
`AnalyticsQuery.turn_detail(harness,sid,turn_id,request=None)`，详情不存在或被筛选排除时返回 None。

## 统一用量明细

`GET /api/usage` 供独立用量明细页面使用。接收共同时间与八维筛选参数，另接收：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| group | request | request / session / turn / model / harness |
| sort | time | time / cost_usd / tokens / input_net / cache_read / cache_write / output / calls / response_tps / turn_tps |
| order | desc | asc / desc |
| offset, limit | 0, 50 | limit 为 1..200 |
| turn_id | 无 | 可重复，OR；空字符串仅匹配未关联轮次。配合 harness 和 session 形成联合下钻约束 |

group/sort/order 必须为单值，非法枚举与分页范围返回 400。相同 `[start,end)` 中的调用先按所有筛选条件选定，
再按 group 汇总，完整结果排序后分页。time 使用最后窗内调用时间；费用使用已知估算小计，全部缺价时排序值为 null。
缓存写存在未知分量时为 null；tokens 排序使用已记录四分量小计。所有 null 靠后，同值按联合身份 JSON key 升序。

返回 `{snapshot,query,group,sort,order,summary,coverage,facets,rows,total,offset,limit}`。
summary 是全部筛选结果的共享计量汇总，独立于分页。coverage 含 usage_quality/unassigned_calls/priced_calls/unpriced_calls/timing_scope。
facets 复用 analytics 的排除自身维度规则，并保留 turn_id 范围。query.turn_ids 保留明细局部轮次筛选。

每行包含 `key/identity/first/last/projects/harnesses/models/metrics/response_tps/turn_tps/timing`：

- identity 固定含 harness/session_id/turn_id/model/event_key；不适用字段为 null。request 的 event_key 对应原始调用，
  session 与 turn 包含 harness/session_id，turn 还包含 turn_id。未关联轮次以 turn_id=null 保留为独立组，四分量不会掉出总计。
- first/last 是当前窗内调用时间；不会以历史会话创建时间代替。projects/harnesses/models 是本行实际记录的元数据集合。
- metrics 复用共享 summary。四列使用 input_net（未缓存输入）、cache_read、output、cache_write。
  cache_write=null 时 cache_write_known 保留已知写入小计；cost_usd 保留已知估算小计，cost_complete/priced_calls/unpriced_calls 提供覆盖。
- response_tps 仅使用可对应原始调用 key 的完整真实 model 计时样本；turn_tps 使用完整落窗、全部输出可归属该行的 end_to_end 样本。
  request 行不会分摊轮次 TPS。缺计时返回 null，不以窗口吞吐替代。跨 harness 的单值 TPS 为 null，timing 保留各 harness/kind 分项。
  timing 分项含 harness/kind/output/seconds/samples/tps，使用 `Σoutput/Σ真实耗时`。

Python 入口为 `AnalyticsQuery.usage(request,group='request',offset=0,limit=50,sort='time',order='desc',turn_ids=())`。
原 session/turn 详情入口保持可用，详情工具的 in_window 同样以实际开始/结束边界活动为准。
