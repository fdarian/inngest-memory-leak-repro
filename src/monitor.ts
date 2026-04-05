import { forceGc, getRuntimeLabel } from './runtime.ts'

const SPARKLINE_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const RING_SIZE = 60

type MonitorState = {
  rssSamples: number[]
  runCount: number
  lastGcTime: string
  gcAvailable: boolean
  startTime: number
  mode: string
}

const state: MonitorState = {
  rssSamples: [],
  runCount: 0,
  lastGcTime: '--:--:--',
  gcAvailable: true,
  startTime: Date.now(),
  mode: 'effect',
}

export const incrementRunCount = () => {
  state.runCount++
}

export const setMode = (mode: string) => {
  state.mode = mode
}

const formatBytes = (bytes: number): string => {
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`
  }
  return `${mb.toFixed(1)} MB`
}

const formatUptime = (ms: number): string => {
  const totalSecs = Math.floor(ms / 1000)
  const h = Math.floor(totalSecs / 3600)
  const m = Math.floor((totalSecs % 3600) / 60)
  const s = totalSecs % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const formatTime = (d: Date): string => {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const buildSparkline = (samples: number[]): string => {
  if (samples.length === 0) return ''
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  const range = max - min
  return samples
    .map((v) => {
      if (range === 0) return SPARKLINE_CHARS[3]
      const idx = Math.round(((v - min) / range) * (SPARKLINE_CHARS.length - 1))
      return SPARKLINE_CHARS[idx]
    })
    .join('')
}

const padRight = (s: string, len: number): string => s.padEnd(len, ' ')

const redraw = () => {
  const gcAvailable = forceGc()
  if (!gcAvailable) {
    state.gcAvailable = false
  }

  const mem = process.memoryUsage()
  const now = new Date()

  state.lastGcTime = formatTime(now)
  state.rssSamples.push(mem.rss)
  if (state.rssSamples.length > RING_SIZE) {
    state.rssSamples.shift()
  }

  const sparkline = buildSparkline(state.rssSamples)
  const uptime = formatUptime(Date.now() - state.startTime)
  const runtimeLabel = getRuntimeLabel()

  const gcStatus = state.gcAvailable
    ? `lastGc: ${state.lastGcTime}   forcedGc: \x1b[32myes\x1b[0m`
    : `forcedGc: \x1b[31mno (pass --expose-gc)\x1b[0m`

  const modeColor = state.mode === 'effect' ? '\x1b[35m' : '\x1b[36m'
  const modeLabel = `${modeColor}${state.mode}\x1b[0m`

  const lines = [
    `\x1b[1mInngest Memory Leak Repro — ${runtimeLabel}   mode: ${modeLabel}\x1b[0m`,
    `uptime: ${uptime}   runs: ${state.runCount}   ${gcStatus}`,
    '',
    `${padRight('RSS', 12)}${padRight(formatBytes(mem.rss), 12)}${sparkline}`,
    `${padRight('heapUsed', 12)}${formatBytes(mem.heapUsed)}`,
    `${padRight('heapTotal', 12)}${formatBytes(mem.heapTotal)}`,
    `${padRight('external', 12)}${formatBytes(mem.external)}`,
    `${padRight('arrayBuf', 12)}${formatBytes(mem.arrayBuffers)}`,
    '',
    'Press Ctrl-C to exit',
  ]

  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H')
    process.stdout.write(lines.join('\n') + '\n')
  } else {
    const rss = formatBytes(mem.rss)
    const heap = formatBytes(mem.heapUsed)
    process.stdout.write(
      `[${formatTime(now)}] mode=${state.mode} runs=${state.runCount} rss=${rss} heapUsed=${heap}\n`,
    )
  }
}

export const startMonitor = (): (() => void) => {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?25l') // hide cursor
  }

  const interval = setInterval(redraw, 1_000)
  redraw() // draw immediately

  return () => {
    clearInterval(interval)
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?25h') // restore cursor
      process.stdout.write('\x1b[2J\x1b[H')
    }
  }
}
