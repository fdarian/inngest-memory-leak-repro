import { Hono } from 'hono'
import { serve as inngestServe } from 'inngest/hono'
import { isBun } from './runtime.ts'
import type { InngestFunction } from 'inngest'
import { inngest } from './client.ts'

type ServerHandle = {
  baseUrl: string
  stop: () => void
}

export const startServer = async (
  // biome-ignore lint/suspicious/noExplicitAny: inngest function generics are complex
  functions: InngestFunction<any, any, any, any>[],
): Promise<ServerHandle> => {
  const app = new Hono()

  const handler = inngestServe({ client: inngest, functions })
  app.on(['GET', 'POST', 'PUT'], '/api/inngest', (c) => handler(c))

  if (isBun) {
    return startBunServer(app)
  }
  return startNodeServer(app)
}

const startBunServer = async (app: Hono): Promise<ServerHandle> => {
  // @ts-expect-error Bun global
  const server = globalThis.Bun.serve({
    fetch: app.fetch,
    port: 0,
  })
  const baseUrl = `http://localhost:${server.port}`
  return {
    baseUrl,
    stop: () => server.stop(),
  }
}

const startNodeServer = async (app: Hono): Promise<ServerHandle> => {
  const { serve } = await import('@hono/node-server')
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      const baseUrl = `http://localhost:${info.port}`
      resolve({
        baseUrl,
        stop: () => server.close(),
      })
    })
  })
}
