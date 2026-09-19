#!/usr/bin/env python3
from __future__ import annotations
import json, os, select, signal, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
TIMEOUT=120

def env():
    keep={k:v for k,v in os.environ.items() if k in {"PATH","HOME","LANG","LC_ALL","TMPDIR","UV_CACHE_DIR","NPM_CONFIG_CACHE","CI"}}
    keep["CI"]="1"; keep["NO_COLOR"]="1"; keep["SEMGREP_SEND_METRICS"]="off"
    for k in list(keep):
        if any(x in k.upper() for x in ("TOKEN","SECRET","PASSWORD","KEY")): keep.pop(k,None)
    return keep

def stop(p):
    if p.poll() is not None:return
    try: os.killpg(p.pid,signal.SIGTERM)
    except Exception: p.terminate()
    try:p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:os.killpg(p.pid,signal.SIGKILL)
        except Exception:p.kill()

def send(p,obj):
    p.stdin.write(json.dumps(obj,separators=(",",":"))+"\n"); p.stdin.flush()

def recv(p,req_id,timeout=TIMEOUT):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if p.poll() is not None:
            err=p.stderr.read()[-5000:] if p.stderr else ""
            raise RuntimeError(f"server_exit:{p.returncode}:{err}")
        ready,_,_=select.select([p.stdout.fileno()],[],[],0.5)
        if not ready:continue
        line=p.stdout.readline().strip()
        if not line.startswith("{"):continue
        try:obj=json.loads(line)
        except json.JSONDecodeError:continue
        if obj.get("id")==req_id:return obj
    raise TimeoutError(f"timeout:{req_id}")

def inventory(name,cmd):
    p=subprocess.Popen(cmd,cwd=ROOT,env=env(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,start_new_session=True)
    try:
        send(p,{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"zeibael-public-runtime-canary","version":"1.0"}}})
        init=recv(p,1)
        if "error" in init:raise RuntimeError(init["error"])
        send(p,{"jsonrpc":"2.0","method":"notifications/initialized","params":{}})
        send(p,{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
        tools=recv(p,2)
        if "error" in tools:raise RuntimeError(tools["error"])
        names=[x.get("name") for x in tools.get("result",{}).get("tools",[]) if x.get("name")]
        if not names:raise RuntimeError("empty_tools")
        return {"status":"PASS","server":name,"protocol":init.get("result",{}).get("protocolVersion"),"serverInfo":init.get("result",{}).get("serverInfo"),"toolCount":len(names),"tools":names},p
    except Exception:
        stop(p); raise

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body=b"<h1>ZEIBAEL_PLAYWRIGHT_CANARY_OK</h1>"
        self.send_response(200); self.send_header("content-type","text/html"); self.send_header("content-length",str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self,*_): pass

def main():
    evidence={"schema":"zeibael.public-housekeeping-mcp-canary.v1","timestamp":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"live_order_enabled":False,"checks":{}}
    procs=[]
    try:
        serena=["uvx","--from","serena-agent==1.7.0","serena","start-mcp-server","--project-from-cwd","--context","codex"]
        ev,p=inventory("serena",serena); procs.append(p); evidence["checks"]["serena_mcp"]=ev; stop(p)

        semgrep=["uvx","--from","semgrep==1.177.0","semgrep","mcp"]
        ev,p=inventory("semgrep",semgrep); procs.append(p); evidence["checks"]["semgrep_mcp"]=ev; stop(p)
        with tempfile.TemporaryDirectory() as td:
            td=Path(td); (td/"x.py").write_text('print("ZEIBAEL_CANARY")\n')
            (td/"rule.yml").write_text("rules:\n- id: zeibael-canary\n  languages: [python]\n  message: canary\n  severity: INFO\n  pattern: print(...)\n")
            cp=subprocess.run(["uvx","--from","semgrep==1.177.0","semgrep","--config",str(td/"rule.yml"),"--json","--metrics=off",str(td/"x.py")],env=env(),capture_output=True,text=True,timeout=TIMEOUT)
            data=json.loads(cp.stdout) if cp.stdout.strip() else {}
            evidence["checks"]["semgrep_local_scan"]={"status":"PASS" if cp.returncode==0 and data.get("results") else "FAIL","returncode":cp.returncode,"findings":len(data.get("results",[]))}
            if evidence["checks"]["semgrep_local_scan"]["status"]!="PASS": raise RuntimeError("semgrep_scan_failed:"+cp.stderr[-2000:])

        pw=["npx","--yes","@playwright/mcp@0.0.81","--isolated","--headless","--allowed-origins=http://127.0.0.1:*;http://localhost:*","--block-service-workers","--image-responses=omit","--idle-timeout=300000"]
        ev,p=inventory("playwright",pw); procs.append(p); evidence["checks"]["playwright_mcp"]=ev
        srv=ThreadingHTTPServer(("127.0.0.1",0),H); th=threading.Thread(target=srv.serve_forever,daemon=True); th.start()
        try:
            send(p,{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":f"http://127.0.0.1:{srv.server_port}/"}}})
            nav=recv(p,3,90)
            bad="error" in nav or nav.get("result",{}).get("isError") is True
            evidence["checks"]["playwright_localhost_navigation"]={"status":"FAIL" if bad else "PASS","result":nav.get("result",{})}
            if bad:raise RuntimeError("playwright_navigation_failed")
        finally:
            srv.shutdown();srv.server_close();stop(p)

        evidence["status"]="VERIFIED"
        print(json.dumps(evidence,indent=2,sort_keys=True))
        return 0
    except Exception as exc:
        evidence["status"]="FAILED"; evidence["error"]=str(exc)[:5000]
        print(json.dumps(evidence,indent=2,sort_keys=True))
        return 1
    finally:
        for p in procs: stop(p)

if __name__=="__main__": raise SystemExit(main())
