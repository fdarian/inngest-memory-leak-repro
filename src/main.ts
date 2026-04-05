import { Effect, Exit, FiberId, Layer, Scope } from 'effect'
import { createEffectLeakFn, EFFECT_EVENT, EFFECT_FN_ID } from './effect-fn.ts'
import { plainLeakFn, PLAIN_EVENT, PLAIN_FN_ID } from './plain-fn.ts'
import { startServer } from './server.ts'
import { startTriggerLoop } from './trigger.ts'
import { startMonitor, incrementRunCount, setMode } from './monitor.ts'
import { getRuntimeLabel } from './runtime.ts'

type Mode = 'effect' | 'plain'

const resolveMode = (): Mode => {
  const raw = (process.env.MODE ?? 'effect').toLowerCase()
  if (raw === 'plain') return 'plain'
  if (raw === 'effect') return 'effect'
  process.stderr.write(`Unknown MODE="${raw}", expected "effect" or "plain". Falling back to "effect".\n`)
  return 'effect'
}

const INTERVAL_MS = 5_000

const main = async () => {
  const mode = resolveMode()
  setMode(mode)

  // Long-lived scope for FiberSet.makeRuntimePromise — matches the production
  // pattern where the Inngest function is constructed once at service startup
  // under a root scope that lives for the process lifetime.
  const scope = await Effect.runPromise(Scope.make())

  const effectFn = await Effect.runPromise(
    createEffectLeakFn().pipe(
      Scope.extend(scope),
      Effect.provide(Layer.empty),
    ),
  )

  // Register both functions on the same server so the fnId query param picks
  // which one the trigger loop exercises. Only one runs per process — the
  // other sits idle to keep the comparison clean.
  const server = await startServer([effectFn, plainLeakFn])

  const runtimeLabel = getRuntimeLabel()
  process.stdout.write(`Inngest Memory Leak Repro\n`)
  process.stdout.write(`Runtime: ${runtimeLabel}\n`)
  process.stdout.write(`Mode:    ${mode}\n`)
  process.stdout.write(`Server:  ${server.baseUrl}/api/inngest\n`)
  process.stdout.write(`Interval: ${INTERVAL_MS / 1000}s\n`)
  process.stdout.write(`Starting in 1 second...\n`)

  await new Promise<void>((resolve) => setTimeout(resolve, 1_000))

  const stopMonitor = startMonitor()
  const stopTrigger = startTriggerLoop({
    baseUrl: server.baseUrl,
    fnId: mode === 'plain' ? PLAIN_FN_ID : EFFECT_FN_ID,
    event: mode === 'plain' ? PLAIN_EVENT : EFFECT_EVENT,
    intervalMs: INTERVAL_MS,
    onRunComplete: incrementRunCount,
  })

  const cleanup = async () => {
    stopTrigger()
    stopMonitor()
    server.stop()
    await Effect.runPromise(Scope.close(scope, Exit.interrupt(FiberId.none)))
    process.exit(0)
  }

  process.on('SIGINT', () => void cleanup())
  process.on('SIGTERM', () => void cleanup())
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`)
  process.exit(1)
})
