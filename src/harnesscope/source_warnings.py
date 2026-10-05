"""Controlled source diagnostics; never persist or return raw parser messages."""
from collections import Counter
import json
from pathlib import Path
import re
from typing import Any

# Codes are stable API identities. Text explains the source limitation in Chinese.
WARNING_INFO = {
    'aux_title_usage_missing': (
        '标题生成辅助调用未记录用量',
        '标题生成的辅助开销无法计入请求数、token 和费用；已记录的主模型用量仍保留。次数按每文件一项提示统计，不代表辅助调用次数。',
        '可在 DSH 或提供商的原生用量记录核对辅助开销；刷新可读取新日志，无法补算历史中未持久化的用量。'),
    'aux_search_usage_missing': (
        '搜索辅助调用未记录用量',
        '搜索辅助开销无法计入请求数、token 和费用；已记录的主模型用量仍保留。次数按每文件一项提示统计，不代表辅助调用次数。',
        '可在 DSH 或提供商的原生用量记录核对辅助开销；刷新可读取新日志，无法补算历史中未持久化的用量。'),
    'model_usage_missing': (
        '部分模型尝试未记录用量',
        '这些尝试未计入请求数、token 和费用；无法据此判断是否收费。相关完整轮次吞吐样本也可能缺失。',
        '可核对 Harness 或提供商的原生用量记录；刷新可读取后续追加用量，无法从无用量记录推算历史开销。'),
    'usage_counters_incomplete': (
        '用量计数或时间不完整',
        '缺少必要计数或时间的用量记录已跳过，相关请求数、token、费用及吞吐样本可能不完整。',
        '刷新可读取后续完整记录；保留原始日志，可通过 Harness 原生用量记录核对缺失部分。'),
    'usage_timestamp_missing': (
        '用量记录缺少有效时间',
        '这些用量无法可靠归入时间窗口，已跳过相关计量。',
        '可按文件及字节位置核对源格式；刷新可读取后续完整记录，历史无有效时间的条目无法自动归属。'),
    'invalid_json': (
        '部分日志记录无法解析',
        '无效 JSON 记录已跳过；记录中的用量或轮次、工具元数据可能缺失，其余完整记录仍保留。',
        '可按文件及字节位置核对原始日志；确认 Harness 已写入完整记录后刷新，不需要删除原始日志。'),
    'incomplete_jsonl_tail': (
        '日志末行尚未写完整',
        '已保留完整记录；尚未写完整的末行未纳入统计，轮次或工具状态可能仍不完整。',
        '等待 Harness 完成写入后刷新。'),
    'incomplete_zstd_tail': (
        '压缩日志末帧尚未写完整',
        '已保留完整压缩帧；未完成末帧中的用量、轮次和工具元数据暂未纳入统计。',
        '等待 DSH 完成写入后刷新；若源已停止写入，可用 DSH 原生会话记录核对。'),
    'unsupported_dsh_format': (
        'DSH 格式版本或文件头不匹配',
        '该文件的计量记录未导入；当前索引仍保留其他成功解析文件的用量。',
        '核对 DSH 与 Harnesscope 支持的格式版本及文件名，确认兼容后刷新；不要改写原始日志。'),
    'invalid_dsh_inheritance': (
        'DSH 会话继承边界缺失或不一致',
        '无法确认继承历史与本会话的边界，该文件已跳过，避免重复计量。',
        '可通过 DSH 原生会话核对继承关系，确认源格式兼容后刷新；不要手动补造继承边界。'),
    'legacy_warning_metadata': (
        '旧缓存尚未保存提示原因',
        '当前缓存只有提示总数，无法还原各类影响。',
        '刷新一次即可从原始日志补齐分类与文件定位。'),
    'unclassified': (
        '其他解析提示',
        '解析器报告了尚未分类的来源提示；统计按已成功解析的记录计算。',
        '可刷新并核对 Harnesscope 版本；原始提示正文不会通过 API 返回。'),
}

EXACT_CODES = {
    'Auxiliary session/title-llm-request metadata has no persisted usage accounting': 'aux_title_usage_missing',
    'Auxiliary web/deepseek-search-llm-request metadata has no persisted usage accounting': 'aux_search_usage_missing',
    'Model attempt has no recorded usage; totals are incomplete': 'model_usage_missing',
    'Model response has no usage': 'model_usage_missing',
    'Assistant response has no usage': 'model_usage_missing',
    'Model usage has incomplete counters or timestamp': 'usage_counters_incomplete',
    'Model usage has incomplete token counters': 'usage_counters_incomplete',
    'Assistant usage has incomplete token counters': 'usage_counters_incomplete',
    'Advisor usage has incomplete token counters': 'usage_counters_incomplete',
    'Model usage has no valid timestamp': 'usage_timestamp_missing',
    'Assistant usage has no valid timestamp': 'usage_timestamp_missing',
    'Invalid JSON record': 'invalid_json',
    'Incomplete final JSONL line': 'incomplete_jsonl_tail',
    'Incomplete final zstd frame; complete frames retained': 'incomplete_zstd_tail',
    'Unsupported DSH generation or header/filename mismatch': 'unsupported_dsh_format',
    'Seeded DSH session has no inherited-prefix boundary': 'invalid_dsh_inheritance',
    'Unseeded DSH session has an inherited-prefix boundary': 'invalid_dsh_inheritance',
}
LOCATION_CODES = (
    (re.compile(r'Invalid JSON record at byte ([0-9]{1,20})\Z'), 'invalid_json'),
    (re.compile(r'Missing (?:native )?usage timestamp at byte ([0-9]{1,20})\Z'), 'usage_timestamp_missing'),
)
_MAX_LOCATIONS = 10


def summarize(messages):
    counts: Counter[str] = Counter()
    offsets: dict[str, list[int]] = {}
    locations: Counter[str] = Counter()
    for message in messages:
        code, location = EXACT_CODES.get(message, 'unclassified'), None
        for pattern, location_code in LOCATION_CODES:
            match = pattern.fullmatch(message)
            if match:
                code, location = location_code, int(match[1])
                break
        counts[code] += 1
        if location is not None:
            locations[code] += 1
            values = offsets.setdefault(code, [])
            if len(values) < _MAX_LOCATIONS:
                values.append(location)
    return [{'code': code, 'count': count, 'byte_offsets': offsets.get(code, []),
             'locations_omitted': locations[code] - len(offsets.get(code, []))}
            for code, count in sorted(counts.items())]


def merge(previous, current):
    merged: dict[str, Any] = {}
    for item in [*previous, *current]:
        code = item['code'] if item['code'] in WARNING_INFO else 'unclassified'
        value = merged.setdefault(code, {'code': code, 'count': 0, 'byte_offsets': [], 'locations_omitted': 0})
        value['count'] += item['count']
        offsets = value['byte_offsets'] + item.get('byte_offsets', [])
        value['byte_offsets'] = offsets[:_MAX_LOCATIONS]
        value['locations_omitted'] += item.get('locations_omitted', 0) + max(0, len(offsets) - _MAX_LOCATIONS)
    return [merged[code] for code in sorted(merged)]


def stored(value, count):
    details = json.loads(value or '[]')
    missing = count - sum(item['count'] for item in details)
    if missing > 0:
        details = merge(details, [{'code': 'legacy_warning_metadata', 'count': missing}])
    return details


def source_details(rows):
    categories: dict[str, Any] = {}
    for row in rows:
        for item in stored(row['warning_details'], row['warning_count']):
            code = item['code'] if item['code'] in WARNING_INFO else 'unclassified'
            label, impact, action = WARNING_INFO[code]
            group = categories.setdefault(code, {'code': code, 'label': label, 'count': 0,
                                                'affected_files': 0, 'impact': impact,
                                                'action': action, 'files': []})
            group['count'] += item['count']
            group['affected_files'] += 1
            group['files'].append({'name': Path(row['path']).name, 'path': row['path'],
                                   'count': item['count'], 'byte_offsets': item.get('byte_offsets', []),
                                   'locations_omitted': item.get('locations_omitted', 0)})
    return sorted(categories.values(), key=lambda item: (-item['count'], item['code']))
