#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastmcp import FastMCP

mcp = FastMCP("zeibael-k6-loadtest")
K6_BIN = os.environ.get("ZEIBAEL_K6_BIN", "")
ALLOWED = {
    x.strip().rstrip("/")
    for x in os.environ.get("ZEIBAEL_K6_ALLOWED_ORIGINS", "").split(",")
    if x.strip()
}
MAX_VUS = int(os.environ.get("ZEIBAEL_K6_MAX_VUS", "5"))
MAX_DURATION = int(os.environ.get("ZEIBAEL_K6_MAX_DURATION_SECONDS", "15"))

def _require_bin() -> str:
    if not K6_BIN:
        raise RuntimeError("ZEIBAEL_K6_BIN is required; staging MCP will not auto-download")
    return K6_BIN

def _origin(url: str) -> str:
    p = urlparse(url)
    if p.scheme not in {"http", "https"} or not p.hostname:
        raise ValueError("only http/https URLs are allowed")
    port = f":{p.port}" if p.port else ""
    return f"{p.scheme}://{p.hostname}{port}"

def _allowed(url: str) -> None:
    origin = _origin(url)
    if not ALLOWED or origin not in ALLOWED:
        raise ValueError(f"origin not allowlisted: {origin}")

def _version() -> str:
    cp = subprocess.run([_require_bin(), "version"], capture_output=True, text=True, timeout=20, check=False)
    if cp.returncode != 0:
        raise RuntimeError((cp.stderr or cp.stdout)[-2000:])
    return (cp.stdout or cp.stderr).strip()

@mcp.tool()
def status() -> dict[str, Any]:
    return {
        "mode":"OUT_OF_BAND_READ_ONLY_LOAD_TEST",
        "k6_version":_version(),
        "allowed_origins":sorted(ALLOWED),
        "max_vus":MAX_VUS,
        "max_duration_seconds":MAX_DURATION,
        "allowed_methods":["GET"],
        "production_hot_path":False,
        "canonical_state_authority":False,
        "supabase_mutation_authority":False,
        "blitz_router_authority":False,
        "live_order_authority":False
    }

@mcp.tool()
def http_get_load_test(url: str, vus: int = 1, duration_seconds: int = 5) -> dict[str, Any]:
    _allowed(url)
    vus = max(1, min(int(vus), MAX_VUS))
    duration = max(1, min(int(duration_seconds), MAX_DURATION))
    script = f"""
import http from 'k6/http';
import {{ check }} from 'k6';
export const options = {{
  vus: {vus},
  duration: '{duration}s',
  thresholds: {{
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000']
  }}
}};
export default function () {{
  const res = http.get({json.dumps(url)});
  check(res, {{ 'status < 500': (r) => r.status < 500 }});
}}
"""
    with tempfile.TemporaryDirectory(prefix="zeibael-k6-") as td:
        root=Path(td)
        script_path=root/"test.js"
        summary_path=root/"summary.json"
        script_path.write_text(script)
        env={"PATH":os.environ.get("PATH",""),"HOME":os.environ.get("HOME",""),"K6_NO_USAGE_REPORT":"true"}
        cp=subprocess.run(
            [_require_bin(),"run","--quiet",f"--summary-export={summary_path}",str(script_path)],
            capture_output=True,text=True,timeout=duration+45,check=False,env=env
        )
        summary={}
        if summary_path.exists():
            try: summary=json.loads(summary_path.read_text())
            except Exception: summary={}
        return {
            "status":"PASS" if cp.returncode==0 else "FAILED",
            "exit_code":cp.returncode,
            "vus":vus,
            "duration_seconds":duration,
            "url":url,
            "summary":summary,
            "stdout_tail":(cp.stdout or "")[-4000:],
            "stderr_tail":(cp.stderr or "")[-4000:],
            "production_hot_path":False
        }

if __name__=="__main__":
    mcp.run()
