# Inngest Memory Leak Repro

Minimal reproduction for [inngest/inngest-js#1440](https://github.com/inngest/inngest-js/issues/1440).

Production (Bun + Inngest SDK + Effect-TS) shows staircase memory growth of ~200–300 MB/hour correlated with an hourly cron function that has many steps and large step payloads.

This repro ships **two equivalent handlers** driving the exact same 14-step / ~12 MB-per-run workload, so we can isolate where the retention actually lives:

- **`effect` mode** — uses `FiberSet.makeRuntimePromise()` + `Effect.scoped` + per-step inner `FiberSet` (the pattern the maintainer flagged and the pattern used in production).
- **`plain` mode** — plain `async/await`, no Effect, no FiberSet. Same Inngest SDK, same client, same 14 steps, same payload sizes.

A new simulated run fires every 5 seconds so the staircase (or the absence of one) is visible within ~30 seconds.

## Install

```sh
pnpm install
```

## Run

Four convenience scripts — pick a runtime and a mode:

```sh
pnpm start:bun:effect    # Bun + Effect handler
pnpm start:bun:plain     # Bun + plain async/await handler
pnpm start:node:effect   # Node + Effect handler
pnpm start:node:plain    # Node + plain async/await handler
```

Node scripts include `--expose-gc` (so `global.gc()` works) and `--max-old-space-size=8192` (so the process doesn't OOM before you can watch the growth).

## What the TUI shows

```
Inngest Memory Leak Repro — Bun 1.3.11   mode: effect
uptime: 00:00:19   runs: 4   lastGc: 11:34:58   forcedGc: yes

RSS         726.7 MB  ▃▄▅▅▆▆▇▇██
heapUsed     15.4 MB
heapTotal    15.4 MB
external    388.1 MB
arrayBuf      0.0 MB

Press Ctrl-C to exit
```

**Which line should you watch?** On Bun, step payloads live in `external` (ArrayBuffers), so `heapUsed` alone understates the leak. On Node, the growth shows up in `heapUsed` with a smaller `external` component. The conservative metric is `heapUsed + external`; RSS is noisy because it includes allocator slack.

## Observed results

Measured on macOS (M-series), Bun 1.3.11 and Node v25.7.0. Each snapshot preceded by a forced GC. ~14 runs per session, 5 s between runs.

| Runtime | Mode   | RSS     | heapUsed | external | Verdict               |
| ------- | ------ | ------- | -------- | -------- | --------------------- |
| Bun     | effect | 1.50 GB | 1.34 GB  | 1.32 GB  | **leaks** ~180 MB/run |
| Bun     | plain  | 392 MB  | 10.1 MB  | 2.8 MB   | flat                  |
| Node    | effect | 1.73 GB | 819 MB   | 578 MB   | **leaks** ~95 MB/run  |
| Node    | plain  | 471 MB  | 32.1 MB  | 5.0 MB   | flat                  |

`plain` mode produces a textbook sawtooth: each run briefly pushes `heapUsed` to ~70 MB while the request body is parsed, then drops back to ~10 MB (Bun) or ~32 MB (Node) after GC. `effect` mode produces a monotonic staircase on both runtimes.

### What this tells us

- **Not in the Inngest SDK.** Identical workload, identical steps, identical payload sizes, same `Inngest` client and `inngest/hono` serve handler — plain mode stays flat on both Bun and Node. The Inngest SDK itself is fine.
- **Not Bun-specific.** The Effect-mode leak reproduces on Node.js too. Bun's ALS implementation is not the root cause. (The leak numbers differ between runtimes, but both grow monotonically.)
- **Introduced by the Effect ↔ Inngest bridge.** Something in the `FiberSet.makeRuntimePromise()` + `Effect.scoped` + `inngest.createFunction` combination retains per-run state. Per-run retention is ~95–180 MB for a run that serialises only ~12 MB of step payload — a ~8–15× retention ratio.
- **GC can't collect it.** Each snapshot is preceded by `Bun.gc(true)` (Bun) or `global.gc()` (Node with `--expose-gc`).

The next step for debugging is capturing a heap snapshot after ~10 runs in `effect` mode and tracing which Effect-side root (FiberSet, RuntimeImpl, Fiber._observers, a lingering Scope, a captured closure in the per-step wrapper…) keeps the per-run payloads reachable. The `plain` mode gives us a control: any object class whose count grows with run count in `effect` mode but not `plain` mode is a suspect.

## What this simulates (details)

Both handlers run the identical step sequence:

- 10 `collect-N` steps returning `{ index, data: 'x'.repeat(500_000) }` (~500 KB each)
- 3 `generate-N` steps returning `{ index, text: ... + 'y'.repeat(2_000_000) }` (~2 MB each); the Effect version also creates a nested `FiberSet.makeRuntimePromise()` inside each generate step to mimic an "agent tool" pattern
- 1 `store` step returning `{ stored: true }`

No external Inngest dev server is required. The trigger simulates Inngest's replay protocol directly — POSTing to the in-process Hono handler with accumulated step results in the body and the `fnId` query parameter, exactly as the Inngest executor would.
