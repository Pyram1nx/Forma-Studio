// Storage for the accounts API. Two adapters with the same methods:
//   createNeonDb(url): Neon serverless Postgres over HTTP (production, on Vercel).
//   createMemoryDb():  in-process, for tests and for running the API without a database.
//
// Data model: one row per user, and one row per synced item. An item is a design
// (kind 'design') or a settings blob (kind 'setting', id 'prefs' / 'bits' / ...). Every
// write takes the next value of one global sequence as the item's `rev`, so a client can
// ask for "everything changed since rev N" and use rev as an optimistic-concurrency check.
// Deleted items stay as tombstones (no data) so other devices learn about the delete.
import { neon } from '@neondatabase/serverless'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS forma_users (
     id uuid PRIMARY KEY,
     email text NOT NULL UNIQUE,
     salt text NOT NULL,
     hash text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE SEQUENCE IF NOT EXISTS forma_rev`,
  `CREATE TABLE IF NOT EXISTS forma_items (
     user_id uuid NOT NULL REFERENCES forma_users(id) ON DELETE CASCADE,
     kind text NOT NULL,
     id text NOT NULL,
     name text NOT NULL DEFAULT '',
     shapes integer NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL,
     data text,
     size integer NOT NULL DEFAULT 0,
     deleted boolean NOT NULL DEFAULT false,
     rev bigint NOT NULL,
     PRIMARY KEY (user_id, kind, id)
   )`,
  `CREATE INDEX IF NOT EXISTS forma_items_user_rev ON forma_items (user_id, rev)`,
  `CREATE TABLE IF NOT EXISTS forma_rate (
     key text PRIMARY KEY,
     window_start timestamptz NOT NULL,
     count integer NOT NULL
   )`,
]

const iso = (v) => (v instanceof Date ? v : new Date(v)).toISOString()

const toUser = (r) => r && { id: r.id, email: r.email, salt: r.salt, hash: r.hash, createdAt: iso(r.created_at) }

const toMeta = (r) => ({
  kind: r.kind,
  id: r.id,
  name: r.name,
  shapes: Number(r.shapes),
  updatedAt: iso(r.updated_at),
  size: Number(r.size),
  deleted: !!r.deleted,
  rev: Number(r.rev),
})

/** Postgres via Neon's HTTP driver. Each call is one stateless HTTP request, which suits serverless. */
export function createNeonDb(url) {
  const sql = neon(url)
  const q = (text, params = []) => sql.query(text, params)
  let ready = null

  async function migrate() {
    for (const stmt of SCHEMA) {
      try {
        await q(stmt)
      } catch (err) {
        // Two cold starts creating the schema at once: the loser sees a duplicate. Harmless.
        if (!/already exists|duplicate key/i.test(String(err?.message))) throw err
      }
    }
  }

  return {
    /** Create the tables on first use, once per cold start. */
    ready() {
      ready ??= migrate().catch((err) => {
        ready = null
        throw err
      })
      return ready
    },

    async createUser(u) {
      const rows = await q(
        `INSERT INTO forma_users (id, email, salt, hash, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [u.id, u.email, u.salt, u.hash, u.createdAt],
      )
      return rows.length === 1
    },

    async userByEmail(email) {
      return toUser((await q(`SELECT * FROM forma_users WHERE email = $1`, [email]))[0])
    },

    async userById(id) {
      return toUser((await q(`SELECT * FROM forma_users WHERE id = $1`, [id]))[0])
    },

    async deleteUser(id) {
      // Items go with it (ON DELETE CASCADE).
      await q(`DELETE FROM forma_users WHERE id = $1`, [id])
    },

    async listItems(userId, since, limit) {
      const rows = await q(
        `SELECT kind, id, name, shapes, updated_at, size, deleted, rev FROM forma_items
         WHERE user_id = $1 AND rev > $2 ORDER BY rev LIMIT $3`,
        [userId, since, limit],
      )
      return rows.map(toMeta)
    },

    async getItem(userId, kind, id) {
      const r = (await q(`SELECT * FROM forma_items WHERE user_id = $1 AND kind = $2 AND id = $3`, [userId, kind, id]))[0]
      return r ? { ...toMeta(r), data: r.data } : null
    },

    async usage(userId) {
      const r = (
        await q(`SELECT coalesce(sum(size), 0) AS bytes, count(*) FILTER (WHERE NOT deleted) AS items FROM forma_items WHERE user_id = $1`, [userId])
      )[0]
      return { bytes: Number(r.bytes), items: Number(r.items) }
    },

    /**
     * Write an item if its current rev is baseRev (0 when the client has never seen it).
     * Returns { rev } on success, or { conflict: true, rev } with the server's rev.
     */
    async putItem(userId, kind, id, item, baseRev) {
      const rows = await q(
        `INSERT INTO forma_items (user_id, kind, id, name, shapes, updated_at, data, size, deleted, rev)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, nextval('forma_rev'))
         ON CONFLICT (user_id, kind, id) DO UPDATE SET
           name = excluded.name, shapes = excluded.shapes, updated_at = excluded.updated_at,
           data = excluded.data, size = excluded.size, deleted = false, rev = excluded.rev
         WHERE forma_items.rev = $9
         RETURNING rev`,
        [userId, kind, id, item.name, item.shapes, item.updatedAt, item.data, item.size, baseRev],
      )
      if (rows.length) return { rev: Number(rows[0].rev) }
      const cur = await q(`SELECT rev FROM forma_items WHERE user_id = $1 AND kind = $2 AND id = $3`, [userId, kind, id])
      return { conflict: true, rev: Number(cur[0]?.rev ?? 0) }
    },

    /** Turn an item into a tombstone if its rev is baseRev. Missing items count as deleted. */
    async deleteItem(userId, kind, id, baseRev) {
      const rows = await q(
        `UPDATE forma_items SET deleted = true, data = NULL, size = 0, updated_at = now(), rev = nextval('forma_rev')
         WHERE user_id = $1 AND kind = $2 AND id = $3 AND rev = $4 RETURNING rev`,
        [userId, kind, id, baseRev],
      )
      if (rows.length) return { rev: Number(rows[0].rev) }
      const cur = await q(`SELECT rev, deleted FROM forma_items WHERE user_id = $1 AND kind = $2 AND id = $3`, [userId, kind, id])
      if (!cur.length) return { rev: 0 }
      if (cur[0].deleted) return { rev: Number(cur[0].rev) }
      return { conflict: true, rev: Number(cur[0].rev) }
    },

    /** Count one hit for a rate-limit key in a fixed window. Returns the count so far. */
    async hit(key, windowSeconds) {
      const rows = await q(
        `INSERT INTO forma_rate (key, window_start, count) VALUES ($1, now(), 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN forma_rate.window_start < now() - make_interval(secs => $2) THEN 1 ELSE forma_rate.count + 1 END,
           window_start = CASE WHEN forma_rate.window_start < now() - make_interval(secs => $2) THEN now() ELSE forma_rate.window_start END
         RETURNING count`,
        [key, windowSeconds],
      )
      // Now and then, drop windows that ended long ago so the table stays small.
      if (Math.random() < 0.01) await q(`DELETE FROM forma_rate WHERE window_start < now() - interval '1 day'`)
      return Number(rows[0].count)
    },
  }
}

/** Same interface, kept in memory. Used by the tests. */
export function createMemoryDb() {
  const users = new Map()
  const items = new Map()
  const rate = new Map()
  let seq = 0
  const key = (u, k, i) => `${u}\u0000${k}\u0000${i}`
  const meta = (r) => ({ kind: r.kind, id: r.id, name: r.name, shapes: r.shapes, updatedAt: r.updatedAt, size: r.size, deleted: r.deleted, rev: r.rev })

  return {
    ready: async () => {},
    async createUser(u) {
      if ([...users.values()].some((x) => x.email === u.email)) return false
      users.set(u.id, { ...u })
      return true
    },
    userByEmail: async (email) => [...users.values()].find((u) => u.email === email) ?? null,
    userById: async (id) => users.get(id) ?? null,
    async deleteUser(id) {
      users.delete(id)
      for (const [k, r] of items) if (r.userId === id) items.delete(k)
    },
    async listItems(userId, since, limit) {
      return [...items.values()]
        .filter((r) => r.userId === userId && r.rev > since)
        .sort((a, b) => a.rev - b.rev)
        .slice(0, limit)
        .map(meta)
    },
    async getItem(userId, kind, id) {
      const r = items.get(key(userId, kind, id))
      return r ? { ...meta(r), data: r.data } : null
    },
    async usage(userId) {
      let bytes = 0
      let n = 0
      for (const r of items.values()) {
        if (r.userId !== userId) continue
        bytes += r.size
        if (!r.deleted) n++
      }
      return { bytes, items: n }
    },
    async putItem(userId, kind, id, item, baseRev) {
      if (!users.has(userId)) throw new Error('foreign key violation')
      const k = key(userId, kind, id)
      const cur = items.get(k)
      if (cur && cur.rev !== baseRev) return { conflict: true, rev: cur.rev }
      const rev = ++seq
      items.set(k, { userId, kind, id, ...item, deleted: false, rev })
      return { rev }
    },
    async deleteItem(userId, kind, id, baseRev) {
      const k = key(userId, kind, id)
      const cur = items.get(k)
      if (!cur) return { rev: 0 }
      if (cur.deleted) return { rev: cur.rev }
      if (cur.rev !== baseRev) return { conflict: true, rev: cur.rev }
      const rev = ++seq
      items.set(k, { ...cur, data: null, size: 0, deleted: true, updatedAt: new Date().toISOString(), rev })
      return { rev }
    },
    async hit(k) {
      const n = (rate.get(k) ?? 0) + 1
      rate.set(k, n)
      return n
    },
  }
}
