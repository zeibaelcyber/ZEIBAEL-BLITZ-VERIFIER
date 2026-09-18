# ZEIBAEL Blitz Capability Map v1

Purpose: measure the usable concurrency envelope of a StackBlitz/WebContainer session without pretending there is one universal StackBlitz worker limit.

## Operating model

Each benchmark profile produces three values:

- `burst_max`: highest concurrency that completes inside the profile timeout.
- `first_fail`: first adjacent concurrency that fails or times out.
- `safe_max`: conservative operating ceiling used for real work.

A boundary is `EXACT` only when `N` passes and `N+1` fails in two confirmation rounds in the same environment/session.

## Profiles

1. `LIGHT` — tiny Node processes: arithmetic, hashing, JSON.
2. `IO` — filesystem/read-write/process-output workload inside the WebContainer.
3. `BUILD_TEST` — syntax-check / module-load / test-like process workload.
4. `CPU_HEAVY` — sustained compute loop + crypto.

## Search algorithm

1. Probe 1, 2, 4, 8, 16... until the first failure or profile cap.
2. Binary-search between the last pass and first fail.
3. Confirm `N PASS` and `N+1 FAIL` twice.
4. If the two confirmation rounds disagree, mark the profile `VARIABLE` and use the minimum observed stable boundary for safe planning.

## Safety policy

This map is manual. It does not auto-trigger workers, deployment, trading, or production writes.

Default safe ceilings:
- LIGHT: 80% of burst_max
- IO: 75%
- BUILD_TEST: 70%
- CPU_HEAVY: 60%

The percentages are intentionally conservative and can be revised after repeated evidence on the user's primary device.

## Environment fingerprint

Every map records browser user-agent, logical CPU count, reported device memory when available, cross-origin isolation, timestamp, and WebContainer API version.

Do not compare two maps as if they were identical unless their environment fingerprints and benchmark profile versions match.

## Lab v2 integration

ZEIBAEL Blitz Lab v2 should read this map as a capability contract:

- NORMAL mode uses `safe_max`.
- BURST mode may use up to `burst_max` only when the user explicitly requests it.
- REDLINE is `first_fail` and is never used for real work.
