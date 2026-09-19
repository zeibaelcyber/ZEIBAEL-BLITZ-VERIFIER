#!/usr/bin/env python3
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("OPENCLAW_CANARY_PORT", "18766"))
ANSWER = "ZEIBAEL_OPENCLAW_STRICT_CANARY_PASS"

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt, *args):
        print("OPENCLAW_STUB " + (fmt % args), flush=True)
    def _json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path in {"/health", "/v1/health"}:
            return self._json(200, {"ok": True, "provider": "zeibael-openclaw-local-stub"})
        if self.path in {"/models", "/v1/models"}:
            return self._json(200, {"object":"list","data":[{"id":"canary-model","object":"model","owned_by":"zeibael-local-stub"}]})
        return self._json(404, {"error":"not_found"})
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try: body = json.loads(raw or b"{}")
        except Exception: return self._json(400, {"error":"invalid_json"})
        if self.path not in {"/chat/completions", "/v1/chat/completions"}:
            return self._json(404, {"error":"not_found"})
        model = body.get("model") or "canary-model"
        if body.get("stream"):
            chunks = [
                {"id":"zeibael-openclaw-canary","object":"chat.completion.chunk","created":1,"model":model,"choices":[{"index":0,"delta":{"role":"assistant","content":ANSWER},"finish_reason":None}]},
                {"id":"zeibael-openclaw-canary","object":"chat.completion.chunk","created":1,"model":model,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}},
            ]
            payload = "".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n"
            data = payload.encode()
            self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.send_header("Cache-Control","no-cache"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data); return
        return self._json(200, {"id":"zeibael-openclaw-canary","object":"chat.completion","created":1,"model":model,"choices":[{"index":0,"message":{"role":"assistant","content":ANSWER},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})

if __name__ == "__main__":
    print(f"ZEIBAEL_OPENCLAW_LOCAL_STUB_READY port={PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
