import { Effect, FiberSet } from 'effect'
import { inngest } from './client.ts'

export const EFFECT_FN_ID = 'leak-repro-leak-think-cron'
export const EFFECT_EVENT = 'leak/run'

const wrapStepRun = <A, E, R>(
  step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
  id: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const runPromise = yield* FiberSet.makeRuntimePromise<R>()
    return (yield* Effect.promise(() =>
      step.run(id, () => runPromise(effect)),
    )) as A
  })

// Mimics production: 14 steps with large payloads.
// collect steps ~500KB each, generate steps ~2MB each, with nested FiberSet.
export const createEffectLeakFn = () =>
  Effect.gen(function* () {
    const runPromise = yield* FiberSet.makeRuntimePromise()

    return inngest.createFunction(
      { id: 'leak-think-cron', triggers: [{ event: EFFECT_EVENT }] },
      // biome-ignore lint/suspicious/noExplicitAny: inngest handler ctx has complex generics
      async (ctx: any) => {
        return runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              for (let i = 0; i < 10; i++) {
                yield* wrapStepRun(ctx.step, `collect-${i}`, Effect.sync(() => ({
                  index: i,
                  data: 'x'.repeat(500_000),
                })))
              }
              for (let i = 0; i < 3; i++) {
                yield* wrapStepRun(ctx.step, `generate-${i}`, Effect.gen(function* () {
                  const inner = yield* FiberSet.makeRuntimePromise()
                  const chunks = yield* Effect.promise(async () => {
                    const out: string[] = []
                    for (let k = 0; k < 3; k++) {
                      const r = await inner(Effect.succeed('t'.repeat(100_000)))
                      out.push(r as string)
                    }
                    return out
                  })
                  return { index: i, text: chunks.join('|') + 'y'.repeat(2_000_000) }
                }))
              }
              yield* wrapStepRun(ctx.step, 'store', Effect.succeed({ stored: true }))
              return { ok: true }
            }),
          ) as unknown as Effect.Effect<unknown, unknown, never>,
        )
      },
    )
  })
