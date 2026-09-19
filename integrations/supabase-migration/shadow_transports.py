#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import urllib.request
from typing import Any

from shadow_adapters import redis_shadow_record, telemetry_shadow_event, cloudflare_shadow_envelope

def enabled(name: str) -> bool:
    return os.environ.get(name,"false").strip().lower()=="true"

def redis_shadow_write(client: Any, kind: str, record: dict[str,Any], ttl_seconds: int = 300) -> dict[str,Any]:
    if not enabled("ZEIBAEL_REDIS_SHADOW_ENABLED"):
        return {"status":"DISABLED","mutated":False}
    shaped=redis_shadow_record(kind,record)
    client.setex(shaped["key"],max(30,min(int(ttl_seconds),3600)),json.dumps(shaped["payload"],sort_keys=True,default=str))
    return {"status":"SHADOW_WRITTEN","key":shaped["key"],"sha256":shaped["sha256"],"canonical_authority":False}

def _post_json(url: str, payload: dict[str,Any], headers: dict[str,str], timeout: int = 10) -> tuple[int,str]:
    data=json.dumps(payload,separators=(",",":"),default=str).encode()
    req=urllib.request.Request(url,data=data,headers={"content-type":"application/json",**headers},method="POST")
    with urllib.request.urlopen(req,timeout=timeout) as resp:
        return int(resp.status),resp.read(8192).decode(errors="replace")

def honeycomb_shadow_emit(record: dict[str,Any]) -> dict[str,Any]:
    if not enabled("ZEIBAEL_HONEYCOMB_SHADOW_ENABLED"):
        return {"status":"DISABLED","mutated":False}
    endpoint=os.environ.get("ZEIBAEL_HONEYCOMB_OTLP_HTTP_ENDPOINT","").strip()
    api_key=os.environ.get("ZEIBAEL_HONEYCOMB_API_KEY","").strip()
    dataset=os.environ.get("ZEIBAEL_HONEYCOMB_DATASET","").strip()
    if not endpoint or not api_key or not dataset:
        raise RuntimeError("Honeycomb shadow enabled but endpoint/api-key/dataset missing")
    shaped=telemetry_shadow_event(record)
    status,_=_post_json(endpoint,shaped["attributes"],{"X-Honeycomb-Team":api_key,"X-Honeycomb-Dataset":dataset})
    if status<200 or status>=300:
        raise RuntimeError(f"Honeycomb shadow HTTP {status}")
    return {"status":"SHADOW_EMITTED","sha256":shaped["sha256"],"canonical_authority":False}

def cloudflare_shadow_dispatch(task: dict[str,Any]) -> dict[str,Any]:
    if not enabled("ZEIBAEL_CLOUDFLARE_SHADOW_DISPATCH"):
        return {"status":"DISABLED","mutated":False}
    endpoint=os.environ.get("ZEIBAEL_CLOUDFLARE_SHADOW_ENDPOINT","").strip()
    token=os.environ.get("ZEIBAEL_CLOUDFLARE_SHADOW_TOKEN","").strip()
    if not endpoint or not token:
        raise RuntimeError("Cloudflare shadow enabled but endpoint/token missing")
    envelope=cloudflare_shadow_envelope(task)
    status,_=_post_json(endpoint,envelope,{"authorization":f"Bearer {token}"})
    if status<200 or status>=300:
        raise RuntimeError(f"Cloudflare shadow HTTP {status}")
    return {"status":"SHADOW_DISPATCHED","sha256":envelope["envelope_sha256"],"canonical_authority":"supabase"}
