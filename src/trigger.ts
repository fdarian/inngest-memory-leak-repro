// Simulates Inngest's replay protocol against the in-process handler.
// Posts to the serve handler with the fnId query param and accumulated step
// results, just as the Inngest executor would on each re-invoke.

const STEP_IDS = [
	...Array.from({ length: 10 }, (_, i) => `collect-${i}`),
	...Array.from({ length: 3 }, (_, i) => `generate-${i}`),
	"store",
];

type StepResult = { type: "data"; data: unknown };
type StepResults = Record<string, StepResult>;

type InngestOp = {
	op: string;
	id?: string;
	data?: unknown;
};

const buildBody = (
	fnId: string,
	event: string,
	runId: string,
	stepResults: StepResults,
) => {
	const completedStepIds = Object.keys(stepResults);
	return {
		event: { name: event, data: {} },
		events: [{ name: event, data: {} }],
		steps: stepResults,
		ctx: {
			fn_id: fnId,
			run_id: runId,
			attempt: 0,
			disable_immediate_execution: false,
			use_api: false,
			stack: {
				stack: completedStepIds,
				current: completedStepIds.length > 0 ? completedStepIds.length - 1 : 0,
			},
		},
		version: 2,
	};
};

const postToHandler = async (
	baseUrl: string,
	fnId: string,
	event: string,
	runId: string,
	stepResults: StepResults,
): Promise<{ status: number; ops: InngestOp[] }> => {
	const url = `${baseUrl}/api/inngest?fnId=${encodeURIComponent(fnId)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(buildBody(fnId, event, runId, stepResults)),
	});

	const text = await res.text();

	if (res.status !== 200 && res.status !== 206) {
		throw new Error(`Inngest handler returned ${res.status}: ${text}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { status: res.status, ops: [] };
	}

	const ops = Array.isArray(parsed) ? (parsed as InngestOp[]) : [];
	return { status: res.status, ops };
};

type RunOpts = {
	baseUrl: string;
	fnId: string;
	event: string;
};

export const runOnce = async (opts: RunOpts): Promise<void> => {
	const runId = `run-${crypto.randomUUID()}`;
	const stepResults: StepResults = {};

	for (let attempt = 0; attempt < STEP_IDS.length + 5; attempt++) {
		const { status, ops } = await postToHandler(
			opts.baseUrl,
			opts.fnId,
			opts.event,
			runId,
			stepResults,
		);

		if (status === 200) {
			return;
		}

		let gotNewStep = false;
		for (const op of ops) {
			if ((op.op === "StepRun" || op.op === "Step") && op.id !== undefined) {
				stepResults[op.id] = { type: "data", data: op.data ?? null };
				gotNewStep = true;
			}
		}

		if (!gotNewStep) {
			break;
		}
	}
};

type LoopOpts = RunOpts & {
	intervalMs: number;
	onRunComplete: () => void;
};

export const startTriggerLoop = (opts: LoopOpts): (() => void) => {
	let stopped = false;

	const runAndSchedule = async () => {
		if (stopped) return;
		try {
			await runOnce(opts);
			if (!stopped) opts.onRunComplete();
		} catch (err) {
			process.stderr.write(`[trigger] run failed: ${String(err)}\n`);
		}
		if (!stopped) {
			setTimeout(runAndSchedule, opts.intervalMs);
		}
	};

	setTimeout(runAndSchedule, 0);

	return () => {
		stopped = true;
	};
};
