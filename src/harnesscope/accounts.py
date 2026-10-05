"""Offline OMP identities and quota observations. Never select credential bodies."""

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from typing import Any


ACCOUNT_SCHEMA = """
CREATE TABLE IF NOT EXISTS account_bindings (
    credential_ref TEXT PRIMARY KEY, account_ref TEXT NOT NULL,
    store_ref TEXT NOT NULL, harness TEXT NOT NULL, provider TEXT NOT NULL,
    kind TEXT NOT NULL, label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bindings_account ON account_bindings(account_ref);
CREATE TABLE IF NOT EXISTS account_periods (
    id TEXT PRIMARY KEY, store_ref TEXT NOT NULL, harness TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sources (
    harness TEXT PRIMARY KEY, store_ref TEXT NOT NULL, payload TEXT NOT NULL
);
"""


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _ref(kind: str, *parts: str) -> str:
    return f"omp-{kind}:" + hashlib.sha256("\0".join(parts).encode()).hexdigest()


def store_ref(path: str | Path) -> str:
    # The configured local store is the namespace. Native transcripts do not
    # identify their original store, so foreign copies cannot be authenticated.
    return _ref("store", str(Path(path).expanduser().resolve()))


def credential_ref(path: str | Path, native_id: Any) -> str | None:
    if isinstance(native_id, bool) or not isinstance(native_id, int) or native_id <= 0:
        return None
    return _ref("credential", store_ref(path), str(native_id))


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _iso_ms(value: Any) -> str | None:
    number = _number(value)
    if number is None:
        return None
    try:
        return datetime.fromtimestamp(number / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def _parts(key: str | None, *, usage: bool = False) -> dict[str, str] | None:
    key = _text(key)
    if not key:
        return None
    atoms = key.split("|")
    if usage:
        if atoms.pop(0) != "oauth":
            return None
    result = {}
    for atom in atoms:
        name, separator, value = atom.partition(":")
        if not separator or not value or name not in {"account", "email", "org", "project", "enterprise"}:
            return None
        if name in result:
            return None
        result[name] = value
    return result


def _identity(provider: str, parts: dict[str, str]) -> str | None:
    # Mirror OMP's persisted identity_key contract, including billing org scope.
    order = ("email", "account", "project") if provider in {"anthropic", "openai-codex"} else (
        "account", "email", "project")
    base = next((f"{key}:{parts[key]}" for key in order if parts.get(key)), None)
    if provider in {"anthropic", "openai-codex"} and parts.get("org"):
        org = "org:" + parts["org"]
        return f"{base}|{org}" if base else org
    return base


@dataclass
class AccountSnapshot:
    store_ref: str
    source: dict[str, Any]
    bindings: list[dict[str, Any]] = field(default_factory=list)
    periods: list[dict[str, Any]] = field(default_factory=list)
    successful: bool = False


def _scope(parts: dict[str, str], native: dict[str, Any] | None = None) -> dict[str, Any]:
    native = native or {}
    shared = native.get("shared")
    scope: dict[str, Any] = {"model": _text(native.get("modelId")),
                             "shared": shared if isinstance(shared, bool) else None}
    for field_name, source_name in (("org", "orgId"), ("project", "projectId"),
                                    ("tier", "tier"), ("window_id", "windowId")):
        value = _text(native.get(source_name)) or parts.get(field_name)
        if value:
            scope[field_name] = value
    return scope


def _period(account: str, provider: str, limit_id: str, label: str | None,
            observed: Any, reset: Any, scope: dict, *, duration: Any = None,
            expires: Any = None, unit: Any = "percent", used: Any = None,
            limit: Any = None, remaining: Any = None, fraction: Any = None) -> dict | None:
    observed_at, end = _iso_ms(observed), _iso_ms(reset)
    if observed_at is None:
        return None
    duration_ms = _number(duration)
    duration_ms = int(duration_ms) if duration_ms is not None and duration_ms > 0 else None
    start = _iso_ms(reset - duration_ms) if end and duration_ms and _number(reset) is not None else None
    identity = _dump([account, provider, limit_id, end, scope])
    return {"id": _ref("period", identity), "account_ref": account, "provider": provider,
            "limit_id": limit_id, "label": label or limit_id,
            "observed_at": observed_at, "start": start, "end": end,
            "boundary_quality": "inferred" if start else "unknown",
            "duration_ms": duration_ms, "expires_at": _iso_ms(expires),
            "unit": unit if unit in {"percent", "tokens", "requests", "usd", "minutes", "bytes", "unknown"} else "unknown",
            "used": _number(used), "limit": _number(limit), "remaining": _number(remaining),
            "used_fraction": _number(fraction), "scope": scope}


def _read_omp(conn: sqlite3.Connection, path: Path, result: AccountSnapshot) -> None:
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    counters: Counter = Counter()
    # No credential data column, tokens, secrets or credential failure text.
    rows = list(conn.execute("SELECT id,provider,credential_type,identity_key FROM auth_credentials"))
    duplicates = Counter((row[1], row[3]) for row in rows if row[2] == "oauth" and row[3])
    identities: dict[tuple[str, str], str] = {}
    for native_id, provider, kind, identity in rows:
        provider = _text(provider)
        ref = credential_ref(path, native_id)
        if not provider or ref is None:
            counters["invalid_credentials"] += 1
            continue
        if kind == "api_key":
            # OpenRouter explicitly identifies an aggregator route. Unknown
            # aliases do not establish the gateway's upstream account identity.
            display_kind = "gateway_credential" if provider == "openrouter" else "api_key"
            account = _ref("account", result.store_ref, provider, str(native_id))
            label = ("网关凭证" if display_kind == "gateway_credential" else "API 凭证") + " · " + account[-8:]
        elif kind == "oauth":
            parts = _parts(identity)
            canonical = _identity(provider, parts) if parts else None
            if parts is None or canonical != identity or not canonical or duplicates[(provider, identity)] != 1:
                counters["ambiguous_credentials" if identity and duplicates[(provider, identity)] > 1 else "unidentified_credentials"] += 1
                continue
            account = _ref("account", result.store_ref, provider, canonical)
            display_kind = "subscription"
            label = next(parts[key] for key in ("email", "account", "project", "org") if parts.get(key))
            if parts.get("org") and label != parts["org"]:
                label += " · " + parts["org"]
            identities[(provider, canonical)] = account
        else:
            counters["unidentified_credentials"] += 1
            continue
        result.bindings.append({"credential_ref": ref, "account_ref": account,
                                "store_ref": result.store_ref, "harness": "omp",
                                "provider": provider, "kind": display_kind, "label": label})

    def account_for(provider: Any, key: Any):
        parts = _parts(_text(key), usage=True)
        canonical = _identity(provider, parts) if parts and isinstance(provider, str) else None
        account = identities.get((provider, canonical)) if canonical else None
        if not account:
            counters["unmatched_quota_rows"] += 1
        return account, parts or {}

    periods: dict[str, dict] = {}

    def keep(period):
        if period is None:
            counters["invalid_quota_rows"] += 1
            return
        old = periods.get(period["id"])
        if old is None or (period["observed_at"], bool(period["start"])) >= (old["observed_at"], bool(old["start"])):
            periods[period["id"]] = period

    if "usage_history" in tables:
        for row in conn.execute("SELECT provider,account_key,recorded_at,limit_id,label,used_fraction,resets_at FROM usage_history"):
            provider, key, observed, limit_id, label, fraction, reset = row
            account, parts = account_for(provider, key)
            if account and _text(limit_id):
                keep(_period(account, provider, limit_id, _text(label), observed, reset, _scope(parts), fraction=fraction))
            counters["history_rows"] += 1

    if "cache" in tables:
        # JSON extraction materializes only approved fields. raw, headers and
        # metadata bodies never enter Python or the rebuildable usage index.
        approved = {"provider": "$.value.provider", "observed": "$.value.fetchedAt", "expires": "$.expiresAt"}
        limit_fields = {"limit_id": "$.id", "label": "$.label", "duration": "$.window.durationMs",
                        "reset": "$.window.resetsAt", "unit": "$.amount.unit", "used": "$.amount.used",
                        "limit": "$.amount.limit", "remaining": "$.amount.remaining", "fraction": "$.amount.usedFraction",
                        "remaining_fraction": "$.amount.remainingFraction", "modelId": "$.scope.modelId",
                        "shared": "$.scope.shared", "orgId": "$.scope.orgId", "projectId": "$.scope.projectId",
                        "tier": "$.scope.tier", "windowId": "$.scope.windowId", "scope_provider": "$.scope.provider"}
        expressions = [f'json_extract(c.safe,\'{pointer}\') AS "{name}"' for name, pointer in approved.items()]
        expressions += [f'json_extract(l.value,\'{pointer}\') AS "{name}"' for name, pointer in limit_fields.items()]
        sql = ("WITH c AS (SELECT key,CASE WHEN json_valid(value) THEN value ELSE '{}' END AS safe "
               "FROM cache WHERE key LIKE 'usage_cache:report:%') SELECT c.key," + ",".join(expressions) +
               " FROM c,json_each(c.safe,'$.value.limits') l WHERE l.type='object'")
        names = ["key", *approved, *limit_fields]
        for native in conn.execute(sql):
            row = dict(zip(names, native))
            key, provider = row["key"], row["provider"]
            # The marker separates the identity suffix from URLs and versioned
            # provider prefixes. Unknown key formats do not get guessed.
            marker = ":oauth|"
            account_key = "oauth|" + key.rsplit(marker, 1)[1] if key.count(marker) == 1 else None
            prefix = key.removeprefix("usage_cache:report:").split(":", 1)
            key_provider = prefix[1].split(":", 1)[0] if prefix[0].isdigit() else prefix[0]
            if key_provider != provider:
                counters["invalid_quota_rows"] += 1
                continue
            account, parts = account_for(provider, account_key)
            counters["cache_limit_rows"] += 1
            if not account or not _text(row["limit_id"]) or row["scope_provider"] not in (None, provider):
                continue
            native_scope = dict(row)
            native_scope["shared"] = bool(row["shared"]) if row["shared"] in (0, 1) else None
            fraction = _number(row["fraction"])
            used, limit = _number(row["used"]), _number(row["limit"])
            if fraction is None and used is not None and limit is not None and limit > 0:
                fraction = used / limit
            if fraction is None and row["unit"] == "percent" and used is not None:
                fraction = used / 100
            if fraction is None and _number(row["remaining_fraction"]) is not None:
                fraction = 1 - row["remaining_fraction"]
            keep(_period(account, provider, row["limit_id"], _text(row["label"]), row["observed"], row["reset"],
                         _scope(parts, native_scope), duration=row["duration"], expires=row["expires"],
                         unit=row["unit"], used=used, limit=limit, remaining=row["remaining"], fraction=fraction))
    result.bindings.sort(key=lambda row: row["credential_ref"])
    result.periods = sorted(periods.values(), key=lambda row: row["id"])
    result.source.update(status="ready", available=True, error=None,
                         observed_at=max((p["observed_at"] for p in result.periods), default=None),
                         counts=dict(counters), capabilities={"history": "usage_history" in tables, "cache": "cache" in tables})
    result.successful = True


def read_omp_accounts(path: str | Path) -> AccountSnapshot:
    path = Path(path).expanduser().resolve()
    namespace = store_ref(path)
    result = AccountSnapshot(namespace, {"harness": "omp", "available": False,
                                       "status": "missing", "error": None, "observed_at": None})
    if not path.is_file():
        return result
    conn = None
    try:
        conn = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        _read_omp(conn, path, result)
    except (sqlite3.Error, ValueError, TypeError, OverflowError, OSError) as exc:
        result = AccountSnapshot(namespace, {"harness": "omp", "available": False,
                                            "status": "error", "error": type(exc).__name__, "observed_at": None})
    finally:
        if conn is not None:
            conn.close()
    return result


def project_accounts(conn: sqlite3.Connection, harness: str = "omp", source_file: str | None = None) -> int:
    """Refresh both newly indexed calls and historical bindings in one transaction."""
    lookup = ("SELECT b.account_ref FROM account_bindings b JOIN account_sources s "
              "ON b.store_ref=s.store_ref AND b.harness=s.harness "
              "WHERE b.credential_ref=events.credential_ref AND b.provider=events.provider "
              "AND b.harness=events.harness")
    selected = " AND source_file=?" if source_file else ""
    parameters = (harness, source_file) if source_file else (harness,)
    cursor = conn.execute(f"UPDATE events SET account_ref=({lookup}) WHERE harness=? "
                          f"AND account_ref IS NOT ({lookup}){selected}", parameters)
    return cursor.rowcount


def store_snapshot(conn: sqlite3.Connection, snapshot: AccountSnapshot) -> bool:
    harness = snapshot.source["harness"]
    before = _indexed_state(conn, harness)
    previous = conn.execute("SELECT payload,store_ref FROM account_sources WHERE harness=?", (harness,)).fetchone()
    source = dict(snapshot.source)
    if not snapshot.successful and previous and previous[1] == snapshot.store_ref:
        old = json.loads(previous[0])
        source["observed_at"] = old.get("observed_at")
        source["retained"] = True
    conn.execute("INSERT INTO account_sources VALUES (?,?,?) ON CONFLICT(harness) DO UPDATE SET "
                 "store_ref=excluded.store_ref,payload=excluded.payload", (harness, snapshot.store_ref, _dump(source)))
    if snapshot.successful:
        conn.execute("DELETE FROM account_bindings WHERE harness=?", (harness,))
        conn.execute("DELETE FROM account_periods WHERE harness=?", (harness,))
        conn.executemany("INSERT INTO account_bindings VALUES (?,?,?,?,?,?,?)",
                         [(b["credential_ref"], b["account_ref"], b["store_ref"], b["harness"], b["provider"], b["kind"], b["label"])
                          for b in snapshot.bindings])
        conn.executemany("INSERT INTO account_periods VALUES (?,?,?,?)",
                         [(p["id"], snapshot.store_ref, harness, _dump(p)) for p in snapshot.periods])
    changed = before != _indexed_state(conn, harness)
    return bool(project_accounts(conn, harness)) or changed


def _indexed_state(conn: sqlite3.Connection, harness: str) -> list:
    return [[tuple(row) for row in conn.execute(f"SELECT * FROM {table} WHERE harness=? ORDER BY 1", (harness,))]
            for table in ("account_bindings", "account_periods", "account_sources")]


def indexed_account_labels(conn: sqlite3.Connection) -> list[dict]:
    return [dict(zip(("account_ref", "harness", "provider", "kind", "label"), row)) for row in conn.execute(
        "SELECT DISTINCT b.account_ref,b.harness,b.provider,b.kind,b.label FROM account_bindings b "
        "JOIN account_sources s ON b.store_ref=s.store_ref AND b.harness=s.harness ORDER BY b.provider,b.label,b.account_ref")]


def indexed_accounts(conn: sqlite3.Connection) -> dict:
    """Read only index projections, using the caller's existing read snapshot."""
    accounts = indexed_account_labels(conn)
    periods = [json.loads(row[0]) for row in conn.execute(
        "SELECT p.payload FROM account_periods p JOIN account_sources s ON p.store_ref=s.store_ref "
        "AND p.harness=s.harness ORDER BY p.id")]
    sources = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM account_sources ORDER BY harness")]
    total, assigned, native = conn.execute("SELECT COUNT(*),COUNT(account_ref),COUNT(credential_ref) FROM events").fetchone()
    return {"accounts": accounts, "periods": periods,
            "coverage": {"sources": sources, "assigned_calls": assigned, "unknown_calls": total - assigned,
                         "total_calls": total, "with_credential_ref_calls": native}}
