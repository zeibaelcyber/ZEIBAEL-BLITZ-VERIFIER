# ZEIBAEL Acker Accelerator v1

Role: execution accelerator, not decision-maker.

Acker/Sol remains the brain. The accelerator receives a packet of independent or partially dependent jobs, runs every ready job in parallel, and returns one compact evidence bundle so Acker can decide once instead of testing options sequentially.

## Manual trigger model

Nothing runs by itself. Acker explicitly creates/invokes one accelerator packet.

## Packet

```json
{
  "task_id": "example",
  "objective": "compare three implementation options",
  "jobs": [
    {"id":"a","type":"command","command":"node option-a.mjs"},
    {"id":"b","type":"command","command":"node option-b.mjs"},
    {"id":"c","type":"http","url":"https://example.test/health"}
  ]
}
```

## Execution policy

- All jobs with no unresolved dependency start immediately.
- Dependent jobs start the instant their dependencies finish successfully.
- No artificial low worker cap is imposed by the accelerator.
- Failures do not stop unrelated jobs.
- Each job records start/end/duration/status/stdout/stderr or HTTP evidence.
- Final output is one machine-readable bundle for Acker/Sol.

## Important boundary

The accelerator does not decide the "best" answer. It supplies parallel evidence so Acker/Sol can make that decision faster.
