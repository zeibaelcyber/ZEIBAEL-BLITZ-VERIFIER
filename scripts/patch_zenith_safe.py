#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: patch_zenith_safe.py <zenith-checkout>")
root=Path(sys.argv[1]).resolve()
p=root/"zenith"/"src"/"zenith_harness"/"acp_runner.py"
if not p.exists():
    raise SystemExit(f"missing {p}")
text=p.read_text()

repls=[
(
'''    For codex-acp this is the no-ask, no-sandbox combo — equivalent to
    `codex --dangerously-bypass-approvals-and-sandbox`, which codex-acp
    does not expose as a flag but accepts via `-c` overrides.
''',
'''    ZEIBAEL safety patch: Codex workers are restricted to workspace-write,
    approval_policy=on-request, and sandbox network disabled. The upstream
    danger-full-access behavior is intentionally removed.
'''
),
(
'''            + ' -c sandbox_mode="danger-full-access"'
            + ' -c approval_policy="never"'
            + f' -c model_reasoning_effort="{effort}"'
''',
'''            + ' -c sandbox_mode="workspace-write"'
            + ' -c approval_policy="on-request"'
            + ' -c sandbox_workspace_write.network_access=false'
            + f' -c model_reasoning_effort="{effort}"'
'''
),
(
'''        # Env-var hints — harmless if codex ignores them.
        env["CODEX_SANDBOX"] = "danger-full-access"
        env["CODEX_DISABLE_SANDBOX"] = "1"
''',
'''        # ZEIBAEL safety boundary: never disable Codex sandbox.
        env["CODEX_SANDBOX"] = "workspace-write"
        env.pop("CODEX_DISABLE_SANDBOX", None)
'''
),
(
'''        # Layer 3: zenith's safety keys always win.
        codex_config["sandbox_mode"] = "danger-full-access"
        codex_config["approval_policy"] = "never"
        codex_config["model_reasoning_effort"] = effort
''',
'''        # Layer 3: ZEIBAEL safety keys always win. Preserve only an
        # explicitly selected model from earlier layers; discard any ambient
        # config capable of weakening sandbox/approval/network policy.
        selected_model = codex_config.get("model")
        codex_config = {}
        if selected_model is not None:
            codex_config["model"] = selected_model
        codex_config["sandbox_mode"] = "workspace-write"
        codex_config["approval_policy"] = "on-request"
        codex_config["sandbox_workspace_write"] = {"network_access": False}
        codex_config["model_reasoning_effort"] = effort
'''
)
]
for old,new in repls:
    count=text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one upstream pattern, got {count}: {old[:80]!r}")
    text=text.replace(old,new)

for forbidden in [
    'sandbox_mode="danger-full-access"',
    'env["CODEX_DISABLE_SANDBOX"] = "1"',
    'codex_config["sandbox_mode"] = "danger-full-access"',
]:
    if forbidden in text:
        raise SystemExit(f"unsafe Zenith pattern survived patch: {forbidden}")
for required in [
    'sandbox_mode="workspace-write"',
    'approval_policy="on-request"',
    'sandbox_workspace_write.network_access=false',
    '{"network_access": False}',
]:
    if required not in text:
        raise SystemExit(f"safe Zenith pattern missing after patch: {required}")

p.write_text(text)
print("ZEIBAEL_ZENITH_SAFE_PATCH_OK")
