import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// Accounts in local dev (all optional; set in .env.development.local, which is git-ignored):
//
//   FORMA_LOCAL_API=memory   Run the accounts API (server/app.js) inside the dev server with an
//                            in-memory database. Zero setup; accounts vanish on restart.
//   FORMA_LOCAL_API=db       Same, against DATABASE_URL (e.g. your own free Neon database or a
//                            Neon dev branch) with SESSION_SECRET.
//   FORMA_API_TARGET=<url>   Proxy /api/* to a deployed API instead (owner only; never commit it).
//
// With none of these, accounts are off and everything else works, which is the default for
// contributors.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const pick = (k: string) => process.env[k] || env[k]
  const localApi = pick('FORMA_LOCAL_API')
  const apiTarget = pick('FORMA_API_TARGET')
  const accountsOn = !!localApi || !!apiTarget
  return {
    plugins: [react(), ...(localApi ? [localApiPlugin(localApi, { DATABASE_URL: pick('DATABASE_URL'), SESSION_SECRET: pick('SESSION_SECRET') })] : [])],
    // The client finds the API at /api whenever one of the options above is on.
    define: accountsOn ? { 'import.meta.env.VITE_API_URL': JSON.stringify('/api') } : {},
    server: {
      // Allow Cloudflare quick tunnels (dev sharing).
      allowedHosts: ['.trycloudflare.com'],
      ...(apiTarget && !localApi ? { proxy: { '/api': { target: apiTarget, changeOrigin: true } } } : {}),
    },
    build: {
      // three.js (3D Carve) is code-split into its own chunk; it's large by nature.
      chunkSizeWarningLimit: 800,
    },
  }
})

/** Serve /api/* from server/app.js inside the Vite dev server. */
function localApiPlugin(kind: string, dbEnv: { DATABASE_URL?: string; SESSION_SECRET?: string }): Plugin {
  return {
    name: 'forma-local-api',
    apply: 'serve',
    async configureServer(server) {
      const { createHandler } = await import('./server/app.js')
      const { createMemoryDb, createNeonDb } = await import('./server/db.js')
      const memory = kind === 'memory'
      if (!memory && !dbEnv.DATABASE_URL) throw new Error('FORMA_LOCAL_API=db needs DATABASE_URL (and SESSION_SECRET) in .env.development.local')
      const handle = createHandler({
        db: memory ? createMemoryDb() : createNeonDb(dbEnv.DATABASE_URL!),
        env: { SESSION_SECRET: dbEnv.SESSION_SECRET || 'local-dev-only-secret-not-for-production' },
      })
      server.config.logger.info(`  ➜  Accounts API: /api (${memory ? 'in-memory database, reset on restart' : 'DATABASE_URL'})`)
      server.middlewares.use('/api', (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse) => {
        void (async () => {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
          const method = req.method ?? 'GET'
          const out = await handle(
            new Request(`http://${req.headers.host}${req.originalUrl ?? req.url}`, {
              method,
              headers,
              body: method === 'GET' || method === 'HEAD' || !chunks.length ? undefined : Buffer.concat(chunks),
            }),
          )
          res.statusCode = out.status
          out.headers.forEach((v: string, k: string) => res.setHeader(k, v))
          res.end(Buffer.from(await out.arrayBuffer()))
        })().catch((err) => {
          server.config.logger.error(String(err))
          res.statusCode = 500
          res.end()
        })
      })
    },
  }
}
