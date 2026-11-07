// Forma Studio accounts and sync API. Framework-free: handle(Request) -> Response, so the
// same code runs as Vercel Functions (see api/), in tests, and anywhere with Web Fetch.
//
// Routes (all under /api):
//   POST   /auth/signup          { email, password }            -> session
//   POST   /auth/login           { email, password }            -> session
//   GET    /auth/me                                             -> session (token refreshed when old)
//   DELETE /account              { password }                   -> deletes the account and its data
//   GET    /items?since=REV                                     -> changed item metadata, paged
//   GET    /item?kind=K&id=ID                                   -> one item with its data
//   PUT    /item?kind=K&id=ID    { name, shapes, updatedAt, data, baseRev }
//   DELETE /item?kind=K&id=ID&baseRev=REV
//   GET    /icons/search?q=      GET /icons/svg?id=   GET /icons/sets   (Find Art, no sign-in)
//
// Env: DATABASE_URL (Neon Postgres), SESSION_SECRET (32+ random bytes), ALLOWED_ORIGINS
//      (comma list, for the desktop app), TOKEN_TTL_DAYS (default 30), USER_QUOTA_MB (default 50).
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createNeonDb } from './db.js'
import { iconSetsRoute, iconSvgRoute, searchIconsRoute } from './icons.js'

const scryptAsync = promisify(scrypt)
// Same parameters and encoding as the previous AWS accounts API, so imported users keep their passwords.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_LEN = 64
const MIN_PASSWORD = 8
const MAX_PASSWORD = 256
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/

const MAX_BODY = 4 * 1024 * 1024 // Vercel refuses request bodies over 4.5 MB.
const MAX_ITEM = 3 * 1024 * 1024
const MAX_ITEMS = 2000
const PAGE = 200
const KINDS = new Set(['design', 'setting'])
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })

/** The default runtime: Neon from DATABASE_URL, created once per instance. */
let defaultDb = null
function envDb(env) {
  if (!env.DATABASE_URL) return null
  defaultDb ??= createNeonDb(env.DATABASE_URL)
  return defaultDb
}

/**
 * Make a request handler. Tests pass an in-memory db and an env; Vercel uses the default,
 * which reads process.env on each request.
 */
export function createHandler({ db: fixedDb, env: fixedEnv } = {}) {
  return async function handle(request) {
    const env = fixedEnv ?? process.env
    const origins = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)
    const cors = corsHeaders(request, origins)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api(?=\/)/, '').replace(/\/+$/, '')
    const route = ROUTES[`${request.method} ${path}`]
    let res
    try {
      if (!route) throw new HttpError(404, 'Not found.')
      const ctx = { request, url, env, db: null }
      if (route.needsDb) {
        ctx.db = fixedDb ?? envDb(env)
        if (!ctx.db || !env.SESSION_SECRET) throw new HttpError(503, 'Accounts are not set up on this server.')
        await ctx.db.ready()
      }
      res = await route.fn(ctx)
    } catch (err) {
      if (err instanceof HttpError) res = json(err.status, { error: err.message })
      else {
        console.error('request failed', request.method, path, err?.name, err?.message)
        res = json(500, { error: 'Something went wrong. Please try again.' })
      }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  }
}

// Requests are authenticated with a bearer token, never cookies, so CORS only needs to
// let the desktop app (a different origin) read responses. The web app is same-origin.
function corsHeaders(request, origins) {
  const origin = request.headers.get('origin')
  if (!origin || !origins.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

// ---------- request helpers ----------

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0)
  if (len > MAX_BODY) throw new HttpError(413, 'That is too large to save to your account.')
  const text = await request.text()
  if (text.length > MAX_BODY) throw new HttpError(413, 'That is too large to save to your account.')
  try {
    const v = JSON.parse(text || '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    return v
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.')
  }
}

const clientIp = (request) => (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown').split(',')[0].trim()

/** Slow down password guessing: per IP and per email, per 15 minutes. */
async function limit(ctx, key, max) {
  const n = await ctx.db.hit(key, 15 * 60)
  if (n > max) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.')
}

// ---------- passwords and tokens ----------

const normalizeEmail = (raw) => String(raw ?? '').trim().toLowerCase()

function checkCredentials(body) {
  const email = normalizeEmail(body.email)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.')
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters for the password.`)
  if (password.length > MAX_PASSWORD) throw new HttpError(400, 'That password is too long.')
  return { email, password }
}

const hashPassword = async (password, salt) => (await scryptAsync(password, salt, KEY_LEN, SCRYPT)).toString('base64')

async function passwordMatches(user, password) {
  // Hash even when the account is missing, so response time does not reveal which emails exist.
  const salt = user ? Buffer.from(user.salt, 'base64') : randomBytes(16)
  const candidate = Buffer.from(await hashPassword(password, salt), 'base64')
  const stored = Buffer.from(user?.hash ?? '', 'base64')
  return !!user && stored.length === candidate.length && timingSafeEqual(stored, candidate)
}

const sign = (env, payload) => createHmac('sha256', env.SESSION_SECRET).update(payload).digest()

function issueToken(env, user) {
  const ttlDays = Number(env.TOKEN_TTL_DAYS || 30)
  const now = Date.now()
  const exp = now + ttlDays * 24 * 60 * 60 * 1000
  const payload = Buffer.from(JSON.stringify({ sub: user.id, email: user.email, iat: now, exp })).toString('base64url')
  return { token: `${payload}.${sign(env, payload).toString('base64url')}`, expiresAt: new Date(exp).toISOString() }
}

function verifyToken(env, token) {
  const [payload, sig] = (token || '').split('.')
  if (!payload || !sig) return null
  const given = Buffer.from(sig, 'base64url')
  const expected = sign(env, payload)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof claims.sub === 'string' && claims.exp > Date.now() ? claims : null
  } catch {
    return null
  }
}

/** The signed-in user, or a 401. Also checks the account still exists. */
async function requireUser(ctx) {
  const auth = ctx.request.headers.get('authorization') || ''
  const claims = verifyToken(ctx.env, auth.replace(/^Bearer\s+/i, ''))
  const user = claims && (await ctx.db.userById(claims.sub))
  if (!user) throw new HttpError(401, 'Please sign in again.')
  return { user, claims }
}

const sessionBody = (env, user) => ({ id: user.id, email: user.email, createdAt: user.createdAt, ...issueToken(env, user) })

// ---------- auth routes ----------

async function signup(ctx) {
  const creds = checkCredentials(await readJson(ctx.request))
  await limit(ctx, `signup:${clientIp(ctx.request)}`, 10)
  const salt = randomBytes(16)
  const user = {
    id: randomUUID(),
    email: creds.email,
    salt: salt.toString('base64'),
    hash: await hashPassword(creds.password, salt),
    createdAt: new Date().toISOString(),
  }
  if (!(await ctx.db.createUser(user))) throw new HttpError(409, 'An account with this email already exists. Sign in instead.')
  return json(201, sessionBody(ctx.env, user))
}

async function login(ctx) {
  const creds = checkCredentials(await readJson(ctx.request))
  await limit(ctx, `login-ip:${clientIp(ctx.request)}`, 30)
  await limit(ctx, `login:${createHash('sha256').update(creds.email).digest('hex')}`, 10)
  const user = await ctx.db.userByEmail(creds.email)
  if (!(await passwordMatches(user, creds.password))) throw new HttpError(401, 'Email or password is incorrect.')
  return json(200, sessionBody(ctx.env, user))
}

async function me(ctx) {
  const { user, claims } = await requireUser(ctx)
  // Sliding sessions: someone who opens the app at least once a month stays signed in.
  const fresh = Date.now() - (claims.iat ?? 0) > REFRESH_AFTER_MS ? issueToken(ctx.env, user) : {}
  return json(200, { id: user.id, email: user.email, createdAt: user.createdAt, expiresAt: new Date(claims.exp).toISOString(), ...fresh })
}

async function deleteAccount(ctx) {
  const { user } = await requireUser(ctx)
  const body = await readJson(ctx.request)
  await limit(ctx, `delete:${user.id}`, 10)
  if (!(await passwordMatches(user, typeof body.password === 'string' ? body.password : ''))) throw new HttpError(401, 'That password is not right.')
  await ctx.db.deleteUser(user.id)
  return json(200, { deleted: true })
}

// ---------- sync routes ----------

function itemKey(url) {
  const kind = url.searchParams.get('kind') ?? ''
  const id = url.searchParams.get('id') ?? ''
  if (!KINDS.has(kind) || !ID_RE.test(id)) throw new HttpError(400, 'Unknown item.')
  return { kind, id }
}

const revParam = (v) => {
  const n = Number(v ?? 0)
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'Bad revision.')
  return n
}

async function listItems(ctx) {
  const { user } = await requireUser(ctx)
  const since = revParam(ctx.url.searchParams.get('since'))
  const items = await ctx.db.listItems(user.id, since, PAGE + 1)
  const more = items.length > PAGE
  const page = items.slice(0, PAGE)
  return json(200, { items: page, cursor: page.length ? page[page.length - 1].rev : since, more })
}

async function getItem(ctx) {
  const { user } = await requireUser(ctx)
  const { kind, id } = itemKey(ctx.url)
  const item = await ctx.db.getItem(user.id, kind, id)
  if (!item) throw new HttpError(404, 'Not found.')
  return json(200, item)
}

async function putItem(ctx) {
  const { user } = await requireUser(ctx)
  const { kind, id } = itemKey(ctx.url)
  const body = await readJson(ctx.request)
  if (typeof body.data !== 'string') throw new HttpError(400, 'Missing data.')
  const size = Buffer.byteLength(body.data, 'utf8')
  if (size > MAX_ITEM) throw new HttpError(413, 'This design is too large to save to your account. Save it to your computer instead.')
  const updatedAt = Date.parse(body.updatedAt)
  const item = {
    name: String(body.name ?? '').slice(0, 200),
    shapes: Math.max(0, Math.min(1e6, Math.round(Number(body.shapes) || 0))),
    updatedAt: new Date(Number.isFinite(updatedAt) ? updatedAt : Date.now()).toISOString(),
    data: body.data,
    size,
  }
  const baseRev = revParam(body.baseRev)

  const quotaMb = Number(ctx.env.USER_QUOTA_MB || 50)
  const [usage, existing] = await Promise.all([ctx.db.usage(user.id), ctx.db.getItem(user.id, kind, id)])
  const bytesAfter = usage.bytes - (existing?.size ?? 0) + size
  const itemsAfter = usage.items + (existing && !existing.deleted ? 0 : 1)
  if (bytesAfter > quotaMb * 1024 * 1024 || itemsAfter > MAX_ITEMS) {
    throw new HttpError(507, 'Your account is full. Delete some designs, or save them to your computer.')
  }

  const out = await ctx.db.putItem(user.id, kind, id, item, baseRev)
  if (out.conflict) return json(409, { error: 'Changed on another device.', rev: out.rev })
  return json(200, { rev: out.rev })
}

async function deleteItem(ctx) {
  const { user } = await requireUser(ctx)
  const { kind, id } = itemKey(ctx.url)
  const out = await ctx.db.deleteItem(user.id, kind, id, revParam(ctx.url.searchParams.get('baseRev')))
  if (out.conflict) return json(409, { error: 'Changed on another device.', rev: out.rev })
  return json(200, { rev: out.rev })
}

// ---------- icon search (Find Art) ----------

// Forma's own icon index (server/icons.js): open-licensed sets, searched and served from this
// origin. Results are the same for everyone, so the CDN caches them.
async function iconRoute(fn, ctx, cache) {
  const out = await fn(ctx.url)
  if (out.error) throw new HttpError(out.status, out.error)
  if (out.svg) {
    return new Response(out.svg, {
      status: 200,
      headers: { 'content-type': 'image/svg+xml', 'cache-control': cache, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
    })
  }
  return json(200, out.body, { 'cache-control': cache })
}

const iconSearch = (ctx) => iconRoute(searchIconsRoute, ctx, 'public, max-age=3600, s-maxage=86400')
const iconSvg = (ctx) => iconRoute(iconSvgRoute, ctx, 'public, max-age=604800, s-maxage=31536000')
const iconSets = (ctx) => iconRoute(iconSetsRoute, ctx, 'public, max-age=3600, s-maxage=86400')

const ROUTES = {
  'POST /auth/signup': { fn: signup, needsDb: true },
  'POST /auth/login': { fn: login, needsDb: true },
  'GET /auth/me': { fn: me, needsDb: true },
  'DELETE /account': { fn: deleteAccount, needsDb: true },
  'GET /items': { fn: listItems, needsDb: true },
  'GET /item': { fn: getItem, needsDb: true },
  'PUT /item': { fn: putItem, needsDb: true },
  'DELETE /item': { fn: deleteItem, needsDb: true },
  'GET /icons/search': { fn: iconSearch },
  'GET /icons/svg': { fn: iconSvg },
  'GET /icons/sets': { fn: iconSets },
}

/** The production handler (Vercel Functions in api/ call this). */
export const handle = createHandler()
