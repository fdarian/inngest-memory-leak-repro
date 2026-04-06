import { forceGc, getRuntimeLabel, isBun } from "./runtime.ts";

const SPARKLINE_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const RING_SIZE = 60;

type MonitorState = {
	rssSamples: number[];
	totalSamples: number[];
	runCount: number;
	lastGcTime: string;
	gcAvailable: boolean;
	startTime: number;
	mode: string;
};

const state: MonitorState = {
	rssSamples: [],
	totalSamples: [],
	runCount: 0,
	lastGcTime: "--:--:--",
	gcAvailable: true,
	startTime: Date.now(),
	mode: "effect",
};

export const incrementRunCount = () => {
	state.runCount++;
};

export const setMode = (mode: string) => {
	state.mode = mode;
};

const formatBytes = (bytes: number): string => {
	const mb = bytes / 1024 / 1024;
	if (mb >= 1024) {
		return `${(mb / 1024).toFixed(2)} GB`;
	}
	return `${mb.toFixed(1)} MB`;
};

const formatUptime = (ms: number): string => {
	const totalSecs = Math.floor(ms / 1000);
	const h = Math.floor(totalSecs / 3600);
	const m = Math.floor((totalSecs % 3600) / 60);
	const s = totalSecs % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const formatTime = (d: Date): string => {
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

const buildSparkline = (samples: number[]): string => {
	if (samples.length === 0) return "";
	const min = Math.min(...samples);
	const max = Math.max(...samples);
	const range = max - min;
	return samples
		.map((v) => {
			if (range === 0) return SPARKLINE_CHARS[3];
			const idx = Math.round(
				((v - min) / range) * (SPARKLINE_CHARS.length - 1),
			);
			return SPARKLINE_CHARS[idx];
		})
		.join("");
};

const padRight = (s: string, len: number): string => s.padEnd(len, " ");

type HeapStats = {
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
};

const getHeapStats = (): HeapStats => {
	if (isBun) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const jsc = require("bun:jsc") as {
			heapStats: () => {
				heapSize: number;
				heapCapacity: number;
				extraMemorySize: number;
			};
		};
		const stats = jsc.heapStats();
		return {
			heapUsed: stats.heapSize,
			heapTotal: stats.heapCapacity,
			external: stats.extraMemorySize,
			arrayBuffers: 0,
		};
	}
	const mem = process.memoryUsage();
	return {
		heapUsed: mem.heapUsed,
		heapTotal: mem.heapTotal,
		external: mem.external,
		arrayBuffers: mem.arrayBuffers,
	};
};

const redraw = () => {
	const gcAvailable = forceGc();
	if (!gcAvailable) {
		state.gcAvailable = false;
	}

	const rss = process.memoryUsage().rss;
	const heapStats = getHeapStats();
	const now = new Date();

	const total = heapStats.heapUsed + heapStats.external;

	state.lastGcTime = formatTime(now);
	state.rssSamples.push(rss);
	if (state.rssSamples.length > RING_SIZE) {
		state.rssSamples.shift();
	}
	state.totalSamples.push(total);
	if (state.totalSamples.length > RING_SIZE) {
		state.totalSamples.shift();
	}

	const sparkline = buildSparkline(state.rssSamples);
	const totalSparkline = buildSparkline(state.totalSamples);
	const uptime = formatUptime(Date.now() - state.startTime);
	const runtimeLabel = getRuntimeLabel();

	const gcStatus = state.gcAvailable
		? `lastGc: ${state.lastGcTime}   forcedGc: \x1b[32myes\x1b[0m`
		: `forcedGc: \x1b[31mno (pass --expose-gc)\x1b[0m`;

	const modeColor = state.mode === "effect" ? "\x1b[35m" : "\x1b[36m";
	const modeLabel = `${modeColor}${state.mode}\x1b[0m`;

	const lines = [
		`\x1b[1mInngest Memory Leak Repro — ${runtimeLabel}   mode: ${modeLabel}\x1b[0m`,
		`uptime: ${uptime}   runs: ${state.runCount}   ${gcStatus}`,
		"",
		`${padRight("RSS", 12)}${padRight(formatBytes(rss), 12)}${sparkline}`,
		"",
		`${padRight("total", 12)}${padRight(formatBytes(total), 12)}${totalSparkline}`,
		"",
		`${padRight("heapUsed", 12)}${formatBytes(heapStats.heapUsed)}`,
		`${padRight("heapTotal", 12)}${formatBytes(heapStats.heapTotal)}`,
		`${padRight("external", 12)}${formatBytes(heapStats.external)}`,
		`${padRight("arrayBuf", 12)}${formatBytes(heapStats.arrayBuffers)}`,
		"",
		"Press Ctrl-C to exit",
	];

	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[2J\x1b[H");
		process.stdout.write(lines.join("\n") + "\n");
	} else {
		// Bun keeps step payloads in `external` (ArrayBuffers) rather than the JS
		// heap, so reporting heapUsed alone is misleading — include external too.
		process.stdout.write(
			`[${formatTime(now)}] mode=${state.mode} runs=${state.runCount} rss=${formatBytes(rss)} total=${formatBytes(total)} heapUsed=${formatBytes(heapStats.heapUsed)} external=${formatBytes(heapStats.external)}\n`,
		);
	}
};

export const startMonitor = (): (() => void) => {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[?25l"); // hide cursor
	}

	const interval = setInterval(redraw, 1_000);
	redraw(); // draw immediately

	return () => {
		clearInterval(interval);
		if (process.stdout.isTTY) {
			process.stdout.write("\x1b[?25h"); // restore cursor
			process.stdout.write("\x1b[2J\x1b[H");
		}
	};
};
