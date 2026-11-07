import type { Db } from './db.js'

export interface HandlerOptions {
  /** Storage to use; defaults to Neon from env.DATABASE_URL. */
  db?: Db
  /** Environment; defaults to process.env, read on every request. */
  env?: Record<string, string | undefined>
}

export function createHandler(opts?: HandlerOptions): (request: Request) => Promise<Response>
export const handle: (request: Request) => Promise<Response>
