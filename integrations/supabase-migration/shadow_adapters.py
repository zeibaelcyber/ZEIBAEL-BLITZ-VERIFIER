#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

REDIS_TASK_ALLOWLIST = {
    "id","idempotency_key","status","next_attempt_at","correlation_id",
    "attempt_count","max_attempts","selected_provider","selected_model"
}
REDIS_WORKER_ALLOWLIST = {
    "id","run_id","lane_key","worker_role","capability_key","agent_key",
    "provider_key","model_key","status","task_id","rank_in_lane",
    "started_at","completed_at","request_id","http_status","timed_out",
    "qc_status","accepted"
}
FORBIDDEN_NAMES = {
    "payload","result","instruction","final_result","evidence_bundle",
    "secret","secrets","token","api_key","authorization","password"
}
TELEMETRY_ALLOWLIST = {
    "occurred_at","task_id","provider_key","capability_key","operation","status",
    "latency_ms","cost_units","quota_key","quota_before","quota_after","cache_hit",
    "ticker","market_session","error_code","correlation_id","event_type","source",
    "severity"
}

def _forbidden_key(name: str) -> bool:
    n=name.lower()
    return n in FORBIDDEN_NAMES or any(x in n for x in ("secret","token","password","authorization","api_key"))

def select_allowed(record: dict[str, Any], allowlist: set[str]) -> dict[str, Any]:
    out={}
    for k in sorted(allowlist):
        if k in record and not _forbidden_key(k):
            out[k]=record[k]
    return out

def redis_shadow_record(kind: str, record: dict[str, Any]) -> dict[str, Any]:
    if kind=="task":
        payload=select_allowed(record,REDIS_TASK_ALLOWLIST)
        identifier=str(record.get("id") or "")
        prefix="task"
    elif kind=="worker":
        payload=select_allowed(record,REDIS_WORKER_ALLOWLIST)
        identifier=str(record.get("id") or "")
        prefix="worker"
    else:
        raise ValueError("unsupported kind")
    if not identifier:
        raise ValueError("id required")
    key=f"zeibael:shadow:{prefix}:{identifier}"
    encoded=json.dumps(payload,sort_keys=True,separators=(",",":"),default=str)
    return {
        "key":key,
        "payload":payload,
        "sha256":hashlib.sha256(encoded.encode()).hexdigest(),
        "canonical_authority":False,
    }

def telemetry_shadow_event(record: dict[str, Any]) -> dict[str, Any]:
    attrs=select_allowed(record,TELEMETRY_ALLOWLIST)
    encoded=json.dumps(attrs,sort_keys=True,separators=(",",":"),default=str)
    return {
        "attributes":attrs,
        "sha256":hashlib.sha256(encoded.encode()).hexdigest(),
        "contains_detail_json":False,
        "canonical_authority":False,
    }

def cloudflare_shadow_envelope(task: dict[str, Any]) -> dict[str, Any]:
    task_id=str(task.get("id") or "")
    idem=str(task.get("idempotency_key") or "")
    if not task_id or not idem:
        raise ValueError("task id and idempotency_key required")
    body={
        "task_id":task_id,
        "idempotency_key":idem,
        "capability_key":task.get("capability_key"),
        "correlation_id":task.get("correlation_id"),
        "shadow":True,
        "canonical_authority":"supabase",
    }
    encoded=json.dumps(body,sort_keys=True,separators=(",",":"),default=str)
    body["envelope_sha256"]=hashlib.sha256(encoded.encode()).hexdigest()
    return body
