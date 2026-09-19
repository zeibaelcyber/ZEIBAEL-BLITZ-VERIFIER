#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,sys
from pathlib import Path

def md5s(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()

def validate(archive: Path, manifest_path: Path) -> int:
    manifest=json.loads(manifest_path.read_text())
    if manifest.get("read_only") is not True:
        raise SystemExit("manifest missing read_only=true")
    active=manifest.get("active") or {}
    if any(int(active.get(k,0)) != 0 for k in ("runs","tasks","workers")):
        print(json.dumps({"status":"BLOCKED_ACTIVE_WORK","active":active},sort_keys=True))
        return 3

    expected=manifest.get("tables") or {}
    grouped={k:[] for k in expected}
    total_bytes={k:0 for k in expected}
    with archive.open("r",encoding="utf-8",newline="") as f:
        for raw in f:
            line=raw.rstrip("\r\n")
            if not line: continue
            rec=json.loads(line)
            table=rec.get("table")
            if table not in grouped:
                raise ValueError(f"unexpected table {table}")
            rid=str(rec.get("id") or "")
            if not rid: raise ValueError("archive row missing id")
            grouped[table].append((rid,md5s(line)))
            total_bytes[table]+=len(line.encode("utf-8"))

    report={}
    ok=True
    for table,rows in grouped.items():
        rows.sort(key=lambda x:x[0])
        aggregate=md5s("".join(h for _,h in rows))
        exp=expected[table]
        passed=(
            len(rows)==int(exp["rows"]) and
            aggregate==str(exp["snapshot_hash_md5"]) and
            total_bytes[table]==int(exp["archive_text_bytes"])
        )
        ok &= passed
        report[table]={
          "rows":len(rows),"expected_rows":int(exp["rows"]),
          "archive_text_bytes":total_bytes[table],"expected_archive_text_bytes":int(exp["archive_text_bytes"]),
          "snapshot_hash_md5":aggregate,"expected_snapshot_hash_md5":str(exp["snapshot_hash_md5"]),
          "pass":passed
        }
    print(json.dumps({"schema":"zeibael.shadow_archive_validation.v2","status":"PASS" if ok else "FAIL","tables":report},sort_keys=True))
    return 0 if ok else 1

if __name__=="__main__":
    if len(sys.argv)!=3:
        raise SystemExit("usage: validate_shadow_archive.py <archive.ndjson> <source-manifest.json>")
    raise SystemExit(validate(Path(sys.argv[1]),Path(sys.argv[2])))
