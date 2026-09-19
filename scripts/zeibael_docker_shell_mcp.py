#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

from fastmcp import FastMCP

mcp = FastMCP("zeibael-docker-shell")
ROOT = Path(os.environ.get("ZEIBAEL_WORKSPACE") or Path.cwd()).resolve()
IMAGE = os.environ.get("ZEIBAEL_DOCKER_SANDBOX_IMAGE", "alpine:3.20.3")
MAX_TIMEOUT = 120

def _docker_base() -> list[str]:
    return [
        "docker", "run", "--rm", "--pull=missing",
        "--network", "none",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", "128",
        "--memory", "512m",
        "--cpus", "1.0",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "--tmpfs", "/work:rw,nosuid,nodev,size=256m,mode=1777",
        "--mount", f"type=bind,src={ROOT},dst=/repo,readonly",
        "--workdir", "/work",
        "--user", "65534:65534",
        IMAGE,
    ]

@mcp.tool()
def shell_execute(command: str, timeout_seconds: int = 60) -> dict[str, Any]:
    """Execute a bounded command in an ephemeral Docker sandbox.

    The host repository is mounted read-only at /repo, copied into an ephemeral
    tmpfs at /work/repo, and the command runs there. The container has no IP
    network, no Linux capabilities, no-new-privileges, a read-only rootfs,
    and bounded PID/memory/CPU resources. No Docker socket or host credentials
    are mounted into the container.
    """
    if not command or len(command) > 12000:
        raise ValueError("command must be 1..12000 characters")
    timeout = max(1, min(int(timeout_seconds), MAX_TIMEOUT))
    if not (ROOT / ".git").exists():
        raise RuntimeError("ZEIBAEL workspace must be a checked-out Git repository")

    script = 'cp -R /repo /work/repo && cd /work/repo && exec /bin/sh -lc "$1"'
    args = _docker_base() + ["/bin/sh", "-lc", script, "zeibael-command", command]
    try:
        cp = subprocess.run(
            args,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=timeout + 20,
            check=False,
            env={
                "PATH": os.environ.get("PATH", ""),
                "HOME": os.environ.get("HOME", ""),
                "DOCKER_HOST": os.environ.get("DOCKER_HOST", ""),
            },
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "status": "TIMEOUT",
            "exit_code": None,
            "stdout": (exc.stdout or "")[-20000:] if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "")[-20000:] if isinstance(exc.stderr, str) else "",
            "isolation": _receipt(),
        }

    return {
        "status": "PASS" if cp.returncode == 0 else "FAILED",
        "exit_code": cp.returncode,
        "stdout": cp.stdout[-20000:],
        "stderr": cp.stderr[-20000:],
        "isolation": _receipt(),
    }

@mcp.tool()
def sandbox_status() -> dict[str, Any]:
    """Return Docker host availability plus the enforced sandbox profile."""
    cp = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")},
    )
    return {
        "docker_available": cp.returncode == 0,
        "docker_server_version": cp.stdout.strip() if cp.returncode == 0 else None,
        "docker_error": cp.stderr[-2000:] if cp.returncode != 0 else "",
        "workspace": str(ROOT),
        "image": IMAGE,
        "isolation": _receipt(),
    }

def _receipt() -> dict[str, Any]:
    return {
        "profile": "zeibael-docker-sandbox-v1",
        "host_workspace_mount": "read-only",
        "execution_workspace": "ephemeral-tmpfs-copy",
        "network": "none",
        "capabilities": "drop-all",
        "no_new_privileges": True,
        "rootfs": "read-only",
        "docker_socket_mounted": False,
        "host_credentials_mounted": False,
        "pids_limit": 128,
        "memory_limit": "512m",
        "cpu_limit": "1.0",
        "canonical_state_authority": False,
        "live_order_authority": False,
    }

if __name__ == "__main__":
    mcp.run()
