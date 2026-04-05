// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any

export const isBun: boolean = typeof g.Bun !== 'undefined'

export const forceGc = (): boolean => {
  if (isBun) {
    g.Bun.gc(true)
    return true
  }
  if (typeof g.gc === 'function') {
    g.gc()
    return true
  }
  return false
}

export const getRuntimeLabel = (): string => {
  if (isBun) {
    return `Bun ${g.Bun.version}`
  }
  return `Node ${process.version}`
}
