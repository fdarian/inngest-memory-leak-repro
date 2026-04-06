import { Effect } from "effect";
import { inngest } from "./client.ts";

export const EFFECT_FN_ID = "leak-repro-leak-think-cron";
export const EFFECT_EVENT = "leak/run";

async function stepOne(
	step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
	id: string,
) {
	return step.run(id, () =>
		Effect.runPromise(
			Effect.sync(() => ({
				data: "x".repeat(500_000),
			})),
		),
	);
}

async function stepTwo(
	step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
	id: string,
) {
	return step.run(id, () =>
		Effect.runPromise(
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
					text: chunks.join("|") + "y".repeat(2_000_000),
				};
			}),
		),
	);
}

async function stepThree(
	step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
	id: string,
) {
	return step.run(id, () =>
		Effect.runPromise(Effect.succeed({ stored: true })),
	);
}

// Mimics production: 14 steps with large payloads.
// collect steps ~500KB each, generate steps ~2MB each
export const createEffectLeakFn = () =>
	Effect.gen(function* () {
		return inngest.createFunction(
			{ id: "leak-think-cron", triggers: [{ event: EFFECT_EVENT }] },
			async (ctx) =>
				Effect.gen(function* () {
					for (let i = 0; i < 10; i++) {
						yield* Effect.promise(() => stepOne(ctx.step, `collect-${i}`));
					}
					for (let i = 0; i < 3; i++) {
						yield* Effect.promise(() => stepTwo(ctx.step, `generate-${i}`));
					}
					yield* Effect.promise(() => stepThree(ctx.step, "store"));
					return { ok: true };
				}).pipe(Effect.runPromise),
		);
	});
