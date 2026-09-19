#!/usr/bin/env python3
from __future__ import annotations
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

COMMIT="a8d9b5786f81e70e73cce7bb164f5f83da84a4b5"
UPSTREAM_BLOB="ec753649326dcfae8d5c349ff4ef81eb4131c0ed"
ROOT=Path(__file__).resolve().parents[1]
checkout=Path(tempfile.mkdtemp(prefix="zenith-upstream-"))

def run(*args,cwd=None):
    cp=subprocess.run(args,cwd=cwd,capture_output=True,text=True,check=False)
    if cp.returncode:
        raise RuntimeError(f"{args} exit={cp.returncode}\nstdout={cp.stdout}\nstderr={cp.stderr}")
    return cp.stdout.strip()

run("git","clone","--quiet","--no-checkout","https://github.com/Intelligent-Internet/zenith.git",str(checkout))
run("git","-C",str(checkout),"fetch","--quiet","--depth","1","origin",COMMIT)
run("git","-C",str(checkout),"checkout","--quiet","--detach",COMMIT)
actual=run("git","-C",str(checkout),"rev-parse","HEAD")
assert actual==COMMIT, (actual,COMMIT)
target=checkout/"zenith"/"src"/"zenith_harness"/"acp_runner.py"
blob=run("git","-C",str(checkout),"hash-object",str(target))
assert blob==UPSTREAM_BLOB, (blob,UPSTREAM_BLOB)

run(sys.executable,str(ROOT/"scripts"/"patch_zenith_safe.py"),str(checkout))
patched=target.read_text()
assert 'sandbox_mode="danger-full-access"' not in patched
assert 'env["CODEX_DISABLE_SANDBOX"] = "1"' not in patched
assert 'sandbox_mode="workspace-write"' in patched
assert 'approval_policy="on-request"' in patched
assert 'sandbox_workspace_write.network_access=false' in patched
patched_sha256=hashlib.sha256(target.read_bytes()).hexdigest()

sys.path.insert(0,str(checkout/"zenith"/"src"))
from zenith_harness.acp_runner import _augment_acp_command, _acp_subprocess_env
from zenith_harness.config import HarnessConfig
from zenith_harness.controller import ProjectController
from zenith_harness.dispatcher import MockDispatcher, MockTerminalReviewer
from zenith_harness.models import (
    Decision, Task, TaskList, TerminalReviewHandoff,
    ValidateHandoff, ValidationItem, WorkHandoff
)
from zenith_harness.providers import get_provider
from zenith_harness.server import create_orchestrator_server

provider=get_provider("codex")
cmd=_augment_acp_command("codex-acp",provider,"high")
assert 'sandbox_mode="workspace-write"' in cmd
assert 'approval_policy="on-request"' in cmd
assert 'sandbox_workspace_write.network_access=false' in cmd
assert "danger-full-access" not in cmd
assert 'approval_policy="never"' not in cmd

old_cfg=os.environ.get("CODEX_CONFIG")
old_disable=os.environ.get("CODEX_DISABLE_SANDBOX")
os.environ["CODEX_CONFIG"]=json.dumps({
    "model":"gpt-test-placeholder",
    "sandbox_mode":"danger-full-access",
    "approval_policy":"never",
    "dangerous_extra":"must_be_removed",
})
os.environ["CODEX_DISABLE_SANDBOX"]="1"
try:
    env=_acp_subprocess_env(provider,"high",cmd)
finally:
    if old_cfg is None: os.environ.pop("CODEX_CONFIG",None)
    else: os.environ["CODEX_CONFIG"]=old_cfg
    if old_disable is None: os.environ.pop("CODEX_DISABLE_SANDBOX",None)
    else: os.environ["CODEX_DISABLE_SANDBOX"]=old_disable

cfg=json.loads(env["CODEX_CONFIG"])
assert cfg["model"]=="gpt-test-placeholder"
assert cfg["sandbox_mode"]=="workspace-write"
assert cfg["approval_policy"]=="on-request"
assert cfg["sandbox_workspace_write"]=={"network_access":False}
assert cfg["model_reasoning_effort"]=="high"
assert "dangerous_extra" not in cfg
assert env.get("CODEX_SANDBOX")=="workspace-write"
assert "CODEX_DISABLE_SANDBOX" not in env

async def tool_surface():
    home=Path(tempfile.mkdtemp(prefix="zenith-home-surface-"))
    config=HarnessConfig(
        bundled_dir=checkout/"zenith"/"src"/"zenith_harness"/"bundled",
        harness_home=home,
        projects_dir=home/"projects",
        orchestrator_provider_name="codex",
        worker_provider_name="codex",
        worker_acp_command="codex-acp",
        validator_provider_name=None,
        validator_acp_command=None,
        terminal_reviewer_provider_name=None,
        terminal_reviewer_acp_command=None,
        max_parallel_nodes=2,
        worker_reasoning_effort="high",
        validator_reasoning_effort="high",
        terminal_reviewer_reasoning_effort="high",
    )
    server=create_orchestrator_server(config)
    names={t.name for t in await server.list_tools()}
    expected={
      "start_project","submit_plan","advance_project","end_mission",
      "decide_attention","inspect_project","abort_project"
    }
    assert names==expected,(names,expected)
    return sorted(names)
tools=asyncio.run(tool_surface())

def make_config(home):
    return HarnessConfig(
        bundled_dir=checkout/"zenith"/"src"/"zenith_harness"/"bundled",
        harness_home=home,
        projects_dir=home/"projects",
        orchestrator_provider_name="codex",
        worker_provider_name="codex",
        worker_acp_command="codex-acp",
        validator_provider_name=None,
        validator_acp_command=None,
        terminal_reviewer_provider_name=None,
        terminal_reviewer_acp_command=None,
        max_parallel_nodes=2,
        worker_reasoning_effort="high",
        validator_reasoning_effort="high",
        terminal_reviewer_reasoning_effort="high",
    )

def tasks():
    return TaskList(tasks=[
      Task(id="w1",type="work",body="bounded work",targets=["VAL-001"],skill="worker"),
      Task(id="v1",type="validate",body="audit",targets=["VAL-001"],skill="validator",depends_on=["w1"]),
      Task(id="g1",type="gate",body="",targets=["VAL-001"],skill=None,depends_on=["v1"]),
    ])

def responder(req):
    if req.task.type=="work":
        return WorkHandoff(node_id=req.task.id,done=True,report="mock work complete")
    return ValidateHandoff(
        node_id=req.task.id,done=True,report="mock validation complete",
        items=[ValidationItem(item_id="VAL-001",passed=True)],passed=True
    )

# Clean mission: work -> validate -> gate attention -> continue -> mission_running -> end -> done.
home=Path(tempfile.mkdtemp(prefix="zenith-home-clean-"))
workspace=Path(tempfile.mkdtemp(prefix="zenith-workspace-clean-"))
config=make_config(home)
controller=ProjectController(
    config,MockDispatcher(responder),
    MockTerminalReviewer(TerminalReviewHandoff(done=True,report="independent terminal review clean"))
)
start=controller.start_project("ZEIBAEL bounded mock mission",str(workspace))
pid=start.projectId
contract=controller.store.ensure_contract_dir(pid,"mission-001")
(contract/"VAL-001.md").write_text("# VAL-001\n\nMock assertion.\n")
submitted=controller.submit_plan(pid,tasks())
assert submitted.state.state=="mission_running"
first=controller.advance_project(pid)
assert first.state.state=="attention_needed",first.state.state
attention=controller.store.load_attention(pid)
assert attention and attention[0].kind=="gate_checkpoint"
controller.decide_attention(pid,[Decision(item_id=attention[0].id,action="continue")])
second=controller.advance_project(pid)
assert second.state.state=="mission_running",second.state.state
done=controller.end_mission(pid)
assert done.state.state=="done",done.state.state
closeout=controller.store.mission_dir(pid,"mission-001")/"closeout.md"
assert closeout.exists() and "status: done" in closeout.read_text()

# Gap mission: terminal reviewer says not done -> attention_needed, proving stopping discipline.
home2=Path(tempfile.mkdtemp(prefix="zenith-home-gap-"))
workspace2=Path(tempfile.mkdtemp(prefix="zenith-workspace-gap-"))
config2=make_config(home2)
controller2=ProjectController(
    config2,MockDispatcher(responder),
    MockTerminalReviewer(TerminalReviewHandoff(
      done=False,report="blocking gap: missing required proof\nbrief_reference: ZEIBAEL bounded mock mission"
    ))
)
start2=controller2.start_project("ZEIBAEL gap mission",str(workspace2))
pid2=start2.projectId
contract2=controller2.store.ensure_contract_dir(pid2,"mission-001")
(contract2/"VAL-001.md").write_text("# VAL-001\n\nMock assertion.\n")
controller2.submit_plan(pid2,tasks())
a=controller2.advance_project(pid2)
items=controller2.store.load_attention(pid2)
controller2.decide_attention(pid2,[Decision(item_id=items[0].id,action="continue")])
controller2.advance_project(pid2)
blocked=controller2.end_mission(pid2)
assert blocked.state.state=="attention_needed",blocked.state.state
gap_items=controller2.store.load_attention(pid2)
assert gap_items, "terminal review gap did not create attention"

print(json.dumps({
  "schema":"zeibael.zenith_safe_public_canary.v1",
  "status":"VERIFIED_HARNESS_REAL_AGENT_AUTH_GATED",
  "zero_spend":True,
  "secrets_used":False,
  "live_order_enabled":False,
  "upstream_commit":COMMIT,
  "upstream_acp_runner_blob":UPSTREAM_BLOB,
  "patched_sha256":patched_sha256,
  "mcp_tools":tools,
  "checks":{
    "exact_upstream_commit":"PASS",
    "exact_upstream_blob":"PASS",
    "safe_patch":"PASS",
    "danger_full_access_removed":"PASS",
    "ambient_unsafe_codex_config_sanitized":"PASS",
    "workspace_write":"PASS",
    "approval_on_request":"PASS",
    "network_off":"PASS",
    "mcp_tool_surface_exact_7":"PASS",
    "mock_long_horizon_clean_close":"PASS",
    "terminal_gap_blocks_completion":"PASS",
    "real_agent_dispatch":"GATED_NOT_CLAIMED"
  }
},indent=2))
