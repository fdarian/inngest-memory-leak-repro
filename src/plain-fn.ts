import { inngest } from "./client.ts";

export const PLAIN_FN_ID = "leak-repro-leak-think-cron-plain";
export const PLAIN_EVENT = "leak-plain/run";

// Same 14-step shape as the Effect version, but with plain async/await —
// no Effect, no FiberSet, no runtimes. Used to isolate whether the leak is
// specific to the Effect integration.
export const plainLeakFn = inngest.createFunction(
	{ id: "leak-think-cron-plain", triggers: [{ event: PLAIN_EVENT }] },
	async ({ step }) => {
		for (let i = 0; i < 10; i++) {
			await step.run(`collect-${i}`, async () => ({
				index: i,
				data: "x".repeat(500_000),
			}));
		}
		for (let i = 0; i < 3; i++) {
			await step.run(`generate-${i}`, async () => {
				const chunks: string[] = [];
				for (let k = 0; k < 3; k++) {
					chunks.push("t".repeat(100_000));
				}
				return { index: i, text: chunks.join("|") + "y".repeat(2_000_000) };
			});
		}
		await step.run("store", async () => ({ stored: true }));
		return { ok: true };
	},
);
