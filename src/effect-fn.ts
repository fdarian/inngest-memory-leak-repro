import { Effect } from "effect";
import { inngest } from "./client.ts";

export const EFFECT_FN_ID = "leak-repro-leak-think-cron";
export const EFFECT_EVENT = "leak/run";

const wrapStepRun = <A, E>(
	step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
	id: string,
	effect: Effect.Effect<A, E>,
) => step.run(id, () => Effect.runPromise(effect));

// Mimics production: 14 steps with large payloads.
// collect steps ~500KB each, generate steps ~2MB each
export const createEffectLeakFn = () =>
	Effect.gen(function* () {
		return inngest.createFunction(
			{ id: "leak-think-cron", triggers: [{ event: EFFECT_EVENT }] },
			async (ctx) => {
				for (let i = 0; i < 10; i++) {
					await wrapStepRun(
						ctx.step,
						`collect-${i}`,
						Effect.sync(() => ({
							index: i,
							data: "x".repeat(500_000),
						})),
					);
				}
				for (let i = 0; i < 3; i++) {
					await wrapStepRun(
						ctx.step,
						`generate-${i}`,
						Effect.gen(function* () {
							const chunks = yield* Effect.promise(async () => {
								const out: string[] = [];
								for (let k = 0; k < 3; k++) {
									const r = await Effect.runPromise(
										Effect.succeed("t".repeat(100_000)),
									);
									out.push(r as string);
								}
								return out;
							});
							return {
								index: i,
								text: chunks.join("|") + "y".repeat(2_000_000),
							};
						}),
					);
				}
				await wrapStepRun(ctx.step, "store", Effect.succeed({ stored: true }));
				return { ok: true };
			},
		);
	});
