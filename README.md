# Inngest Memory Leak Repro

Minimal reproduction for [inngest/inngest-js#1440](https://github.com/inngest/inngest-js/issues/1440).

Production (Bun + Inngest SDK + Effect-TS) shows staircase memory growth of ~200–300 MB/hour correlated with an hourly cron function that has many steps and large step payloads.

The Inngest maintainer (amh4r) identified two open questions this repro is meant to answer:

1. **Does it reproduce on Node.js?** That would isolate whether this is Bun-specific.
2. **What external root keeps the execution instance reachable?** The heap snapshot should let you trace the retention root — whether it's Bun's ALS implementation, Effect runtime references, or something else.

## What this simulates

The script replicates the exact production pattern the maintainer flagged:

- `FiberSet.makeRuntimePromise()` called at function creation (outer scope)
- `Effect.scoped` wrapping the entire handler body
- Per-step `FiberSet.makeRuntimePromise()` inside `step.run` callbacks
- Nested `FiberSet.makeRuntimePromise()` inside some steps (agent-tool-like pattern)
- ~14 steps total, with large step payloads (~100 KB per collect step, ~500 KB per generate step)

No external Inngest dev server is required. The script simulates Inngest's replay protocol directly — POSTing step requests to the in-process Hono handler. This is the same technique used in the production codebase's own tests.

## Install

```sh
pnpm install
```

## Run on Bun

```sh
pnpm start:bun
```

## Run on Node

```sh
pnpm start:node
```

Node requires `--expose-gc` to force GC before each memory snapshot. This flag is already included in the `start:node` script.

## What to look for

The TUI redraws every second and shows:

```
Inngest Memory Leak Repro — Bun 1.x.x
uptime: 00:02:13   runs: 7   lastGc: 14:52:03   forcedGc: yes

RSS         182.4 MB  ▃▄▅▅▆▆▇▇██
heapUsed     94.1 MB
heapTotal   128.5 MB
external      1.2 MB
arrayBuf      0.4 MB

Press Ctrl-C to exit
```

Watch the **heapUsed** line (more reliable than RSS, since RSS can include allocator slack that never shrinks):

- **Leaking runtime**: `heapUsed` climbs in a staircase pattern correlated with each completed run (every ~10 seconds), even though each snapshot is taken after a forced GC.
- **Non-leaking runtime**: `heapUsed` stays roughly flat with a sawtooth pattern (rises during a run, falls after GC).

A new simulated run starts every 10 seconds. The TUI also shows a GC marker so you can tell whether forced GC is available.

## Observed results

Measured on this machine (macOS, M-series). Pipe the output through `tail` to see the non-TTY fallback lines.

**Bun 1.3.11** — 10 runs over ~90s, forced GC between each snapshot:

```
runs=0  heapUsed= 12.0 MB   (baseline)
runs=1  heapUsed= 40.9 MB
runs=8  heapUsed=182.9 MB
runs=9  heapUsed=205.6 MB
runs=10 heapUsed=227.1 MB
```

Growth after warmup: **~22 MB / run, linear and monotonic**.

**Node v25.7.0** — 9 runs over ~90s, `--expose-gc` + `global.gc()`:

```
runs=0  heapUsed= 30.1 MB   (baseline)
runs=1  heapUsed= 51.5 MB
runs=7  heapUsed=158.7 MB
runs=8  heapUsed=176.6 MB
runs=9  heapUsed=194.6 MB
```

Growth after warmup: **~18 MB / run, linear and monotonic**.

### What this tells us

- **Not Bun-specific.** The leak reproduces on Node.js with nearly identical per-run retention (~18 MB on Node vs ~22 MB on Bun). Bun's ALS implementation is not the root cause.
- **Retention ratio ~11–14×.** Each run serializes only ~1.6 MB of step payload (10 × 100 KB collect + 3 × 500 KB generate + a few nested strings), yet retains ~18–22 MB of heap after forced GC.
- **GC can't collect it.** Every snapshot is preceded by `Bun.gc(true)` (Bun) or `global.gc()` (Node with `--expose-gc`).

The next step for debugging is capturing a heap snapshot after ~10 runs and tracing which root keeps the `V1InngestExecution` instance (or its `state.steps` map) reachable.
