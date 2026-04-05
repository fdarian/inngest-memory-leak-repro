import { Effect, Exit, FiberId, Layer, Scope } from "effect";
import { createEffectLeakFn, EFFECT_EVENT, EFFECT_FN_ID } from "./effect-fn.ts";
import { incrementRunCount, setMode, startMonitor } from "./monitor.ts";
import { PLAIN_EVENT, PLAIN_FN_ID, plainLeakFn } from "./plain-fn.ts";
import { getRuntimeLabel } from "./runtime.ts";
import { startServer } from "./server.ts";
import { startTriggerLoop } from "./trigger.ts";

type Mode = "effect" | "plain";

const resolveMode = (): Mode => {
	const raw = (process.env.MODE ?? "effect").toLowerCase();
	if (raw === "plain") return "plain";
	if (raw === "effect") return "effect";
	process.stderr.write(
		`Unknown MODE="${raw}", expected "effect" or "plain". Falling back to "effect".\n`,
	);
	return "effect";
};

const INTERVAL_MS = 5_000;

const main = Effect.gen(function* () {
	const mode = resolveMode();
	setMode(mode);

	const effectFn = yield* createEffectLeakFn();

	// Register both functions on the same server so the fnId query param picks
	// which one the trigger loop exercises. Only one runs per process — the
	// other sits idle to keep the comparison clean.
	const server = yield* Effect.tryPromise(() =>
		startServer([effectFn, plainLeakFn]),
	);

	const runtimeLabel = getRuntimeLabel();
	process.stdout.write(`Inngest Memory Leak Repro\n`);
	process.stdout.write(`Runtime: ${runtimeLabel}\n`);
	process.stdout.write(`Mode:    ${mode}\n`);
	process.stdout.write(`Server:  ${server.baseUrl}/api/inngest\n`);
	process.stdout.write(`Interval: ${INTERVAL_MS / 1000}s\n`);
	process.stdout.write(`Starting in 1 second...\n`);

	yield* Effect.sleep("1 second");

	const stopMonitor = startMonitor();
	const stopTrigger = startTriggerLoop({
		baseUrl: server.baseUrl,
		fnId: mode === "plain" ? PLAIN_FN_ID : EFFECT_FN_ID,
		event: mode === "plain" ? PLAIN_EVENT : EFFECT_EVENT,
		intervalMs: INTERVAL_MS,
		onRunComplete: incrementRunCount,
	});

	const cleanup = async () => {
		stopTrigger();
		stopMonitor();
		server.stop();
		process.exit(0);
	};

	process.on("SIGINT", () => void cleanup());
	process.on("SIGTERM", () => void cleanup());
	yield* Effect.never;
});

main.pipe(Effect.scoped, Effect.runPromise).catch((err) => {
	process.stderr.write(`Fatal error: ${String(err)}\n`);
	process.exit(1);
});
