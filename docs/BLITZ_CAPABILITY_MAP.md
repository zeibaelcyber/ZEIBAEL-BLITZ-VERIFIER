# ZEIBAEL Blitz Capability Map v1

Purpose: record the proven concurrency envelope of Blitz and provide an upper capability reference for real execution.

## Canonical proven benchmark reference

Exact worker-limit benchmark:

- benchmark id: `blitz-worker-limit-1789702096605-6evpmf`
- status: `EXACT_BOUNDARY_OBSERVED`
- max stable workers: `1791`
- first failed worker: `1792`
- first failure: `ready_timeout`

This establishes **1791 as the proven maximum stable capability for that benchmark profile**.

It is not a mandatory worker count for every real task.

## Real-work operating model

Real Blitz work must use **as much concurrency as the actual workload can sustain stably**, bounded by the latest proven benchmark ceiling.

Examples:
- workload stable at 1000 -> use up to 1000;
- workload stable at 600 -> use up to 600;
- only 75 independent work units exist -> run those 75 concurrently;
- do not manufacture workers merely to reach 1791;
- do not force a workload past its stable point just because the benchmark ceiling is higher.

## Execution rules

1. Maximize real usage; do not intentionally underuse Blitz when independent work is available.
2. Keep execution stable; the operating point is the highest level that remains reliable for the actual workload.
3. Do not use conservative percentage derating.
4. Do not impose an arbitrary low worker cap.
5. Do not reserve idle workers while ready work exists.
6. Start independent work together up to the stable workload capacity.
7. Start dependent work as soon as dependencies pass.
8. Failure in one scope must not stop unrelated work; retry only the failed scope.
9. Reuse existing benchmark knowledge. Do not re-run the benchmark from zero merely because a new chat, plugin, wave, or task begins.
10. Do not exceed the latest proven benchmark ceiling without new evidence.
11. If later benchmark evidence proves a higher stable ceiling, adopt the higher proven value.
12. Zero-spend and no-secret rules remain mandatory.

## Evidence semantics

A benchmark result is authoritative only for what it actually tested. The 1791/1792 result is the upper capability reference from the exact worker-limit benchmark. Real workloads may reach a lower stable operating point depending on task shape, memory, I/O, CPU pressure, or runtime conditions.

The goal is therefore:

**MAXIMUM PRACTICAL STABLE UTILIZATION**, not maximum worker count at any cost.
