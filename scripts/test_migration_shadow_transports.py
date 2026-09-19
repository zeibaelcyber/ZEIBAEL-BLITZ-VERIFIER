#!/usr/bin/env python3
from __future__ import annotations
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"integrations"/"supabase-migration"))
from shadow_transports import redis_shadow_write,honeycomb_shadow_emit,cloudflare_shadow_dispatch

class FakeRedis:
    def __init__(self): self.data={}
    def setex(self,key,ttl,value): self.data[key]=(ttl,value)

received=[]
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get("content-length","0"))
        body=self.rfile.read(n).decode()
        received.append({"path":self.path,"headers":dict(self.headers),"body":body})
        self.send_response(202); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self,*args): pass

srv=HTTPServer(("127.0.0.1",18081),Handler)
thread=threading.Thread(target=srv.serve_forever,daemon=True); thread.start()

task={"id":"t1","idempotency_key":"i1","status":"queued","payload":{"secret":"x"},"correlation_id":"c1","capability_key":"research"}
event={"provider_key":"p","operation":"call","status":"ok","latency_ms":7,"detail":{"token":"x"}}

# Default-off proves no side effect.
r=FakeRedis()
assert redis_shadow_write(r,"task",task)["status"]=="DISABLED" and not r.data
assert honeycomb_shadow_emit(event)["status"]=="DISABLED"
assert cloudflare_shadow_dispatch(task)["status"]=="DISABLED"
assert not received

# Missing credentials/endpoints must fail closed.
os.environ["ZEIBAEL_HONEYCOMB_SHADOW_ENABLED"]="true"
try:
    honeycomb_shadow_emit(event); raise AssertionError("Honeycomb missing config did not fail")
except RuntimeError: pass
os.environ["ZEIBAEL_HONEYCOMB_SHADOW_ENABLED"]="false"

os.environ["ZEIBAEL_CLOUDFLARE_SHADOW_DISPATCH"]="true"
try:
    cloudflare_shadow_dispatch(task); raise AssertionError("Cloudflare missing config did not fail")
except RuntimeError: pass
os.environ["ZEIBAEL_CLOUDFLARE_SHADOW_DISPATCH"]="false"

# Local dummy transports only.
os.environ["ZEIBAEL_REDIS_SHADOW_ENABLED"]="true"
rr=redis_shadow_write(r,"task",task,120)
assert rr["status"]=="SHADOW_WRITTEN"
stored=next(iter(r.data.values()))[1]
assert '"payload"' not in stored and '"secret"' not in stored

os.environ["ZEIBAEL_HONEYCOMB_SHADOW_ENABLED"]="true"
os.environ["ZEIBAEL_HONEYCOMB_OTLP_HTTP_ENDPOINT"]="http://127.0.0.1:18081/honeycomb"
os.environ["ZEIBAEL_HONEYCOMB_API_KEY"]="dummy"
os.environ["ZEIBAEL_HONEYCOMB_DATASET"]="dummy"
hh=honeycomb_shadow_emit(event)
assert hh["status"]=="SHADOW_EMITTED"

os.environ["ZEIBAEL_CLOUDFLARE_SHADOW_DISPATCH"]="true"
os.environ["ZEIBAEL_CLOUDFLARE_SHADOW_ENDPOINT"]="http://127.0.0.1:18081/cloudflare"
os.environ["ZEIBAEL_CLOUDFLARE_SHADOW_TOKEN"]="dummy"
cc=cloudflare_shadow_dispatch(task)
assert cc["status"]=="SHADOW_DISPATCHED"
assert len(received)==2
assert "secret" not in received[0]["body"] and "payload" not in received[1]["body"]

srv.shutdown()
print(json.dumps({
 "schema":"zeibael.shadow_transports_local_canary.v1","status":"PASS",
 "default_off":"PASS","missing_auth_fail_closed":"PASS","redis_local_shadow":"PASS",
 "honeycomb_dummy_http":"PASS","cloudflare_dummy_http":"PASS",
 "production_access":False,"supabase_mutation":False
},sort_keys=True))
