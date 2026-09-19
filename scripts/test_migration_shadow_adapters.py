#!/usr/bin/env python3
from __future__ import annotations
import json
import tempfile
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"integrations"/"supabase-migration"))
from shadow_adapters import redis_shadow_record, telemetry_shadow_event, cloudflare_shadow_envelope

task={
 "id":"00000000-0000-0000-0000-000000000001",
 "idempotency_key":"idem-1",
 "status":"queued",
 "next_attempt_at":"2026-09-19T12:00:00Z",
 "correlation_id":"corr-1",
 "attempt_count":0,
 "max_attempts":3,
 "selected_provider":"demo",
 "selected_model":"demo-model",
 "payload":{"PRIVATE":"must-not-leak"},
 "instruction":"must-not-leak",
 "result":{"PRIVATE":"must-not-leak"},
 "token":"must-not-leak"
}
shadow=redis_shadow_record("task",task)
blob=json.dumps(shadow)
assert "must-not-leak" not in blob
assert shadow["canonical_authority"] is False
assert shadow["key"].startswith("zeibael:shadow:task:")

worker={
 "id":"00000000-0000-0000-0000-000000000002",
 "run_id":"00000000-0000-0000-0000-000000000003",
 "lane_key":"research","worker_role":"worker","status":"completed",
 "result":{"PRIVATE":"must-not-leak"},"error":"not-copied"
}
w=redis_shadow_record("worker",worker)
assert "must-not-leak" not in json.dumps(w)

event={
 "occurred_at":"2026-09-19T12:00:00Z","task_id":"t1","provider_key":"demo",
 "operation":"call","status":"ok","latency_ms":12,
 "detail":{"secret":"must-not-leak"},"authorization":"must-not-leak"
}
e=telemetry_shadow_event(event)
assert "must-not-leak" not in json.dumps(e)
assert e["contains_detail_json"] is False

env=cloudflare_shadow_envelope(task|{"capability_key":"research"})
assert env["shadow"] is True
assert env["canonical_authority"]=="supabase"
assert "payload" not in env

with tempfile.TemporaryDirectory(prefix="zeibael-archive-test-") as td:
    root=Path(td)
    src=root/"sample.jsonl"
    dst=root/"sample.parquet"
    man=root/"manifest.json"
    src.write_text(
      '{"id":"a","status":"done","value":1}\n'
      '{"id":"b","status":"done","value":2}\n'
    )
    subprocess.run([
      sys.executable,str(ROOT/"integrations"/"supabase-migration"/"jsonl_to_parquet_shadow.py"),
      "--input-jsonl",str(src),"--output-parquet",str(dst),"--manifest",str(man)
    ],check=True,capture_output=True,text=True)
    m=json.loads(man.read_text())
    assert m["row_count"]==2
    assert m["canonical_mutation"] is False
    assert dst.exists() and dst.stat().st_size>0

print(json.dumps({
 "schema":"zeibael.migration_shadow_adapters_canary.v1",
 "status":"PASS",
 "redis_secret_payload_exclusion":"PASS",
 "telemetry_detail_exclusion":"PASS",
 "cloudflare_shadow_envelope":"PASS",
 "archive_parquet_manifest":"PASS",
 "production_access":False,
 "supabase_mutation":False
},sort_keys=True))
