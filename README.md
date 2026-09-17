# ZEIBAEL BLITZ VERIFIER

Secret-free StackBlitz/WebContainer verification harness for ZEIBAEL.

## Purpose

This repository is the execution-and-evidence layer used to turn engineering claims into machine-checkable PASS/FAIL results before a task is marked VERIFIED.

## Quick start

```bash
npm run verify
```

The default verification is intentionally secret-free and checks the runtime, filesystem, subprocess execution, timers, HTTP reachability (when configured), and the verifier's own evidence contract.

## Optional target checks

Set only non-sensitive health/canary endpoints as environment variables in StackBlitz:

- `SUPABASE_HEALTH_URL`
- `CONVEX_HEALTH_URL`
- `ZEIBAEL_CANARY_URL`

Do not put database passwords, service-role keys, private tokens, or trading secrets in this public repository.

## Result contract

A verification run emits a JSON evidence document with:

- `status`: `VERIFIED`, `FAILED`, or `BLOCKED`
- per-check PASS/FAIL/SKIP results
- duration
- timestamp
- runtime metadata
- deterministic evidence id

A task should only be called VERIFIED when all required checks pass in a fresh run.
