// Forma Studio accounts API. Runs as one AWS Lambda behind API Gateway (HTTP API).
// Users are stored as one JSON object per account in S3, keyed by a hash of the email.
// Passwords are hashed with scrypt; sessions are HMAC-signed bearer tokens.
//
// Routes: POST /auth/signup, POST /auth/login, GET /auth/me,
//         GET /icons/search?q=, GET /icons/svg?id=   (icon search for Find Art, no auth)
// Env:    USERS_BUCKET, SESSION_SECRET_ARN, ALLOWED_ORIGINS (comma list),
//         TOKEN_TTL_DAYS (optional, default 30)

import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

const scryptAsync = promisify(scrypt)
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_LEN = 64
const MAX_PASSWORD = 256
const MIN_PASSWORD = 8
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/

const s3 = new S3Client({})
const secrets = new SecretsManagerClient({})
let cachedSecret = null

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
})

// Adds CORS headers when the request comes from an allowed origin (web app, dev server,
// or the desktop app). Requests are authenticated with a bearer token, not cookies.
function withCors(event, res) {
  const origin = event.headers?.origin
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return res
  return {
    ...res,
    headers: {
      ...res.headers,
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  }
}

const fail = (statusCode, error) => json(statusCode, { error })

async function sessionSecret() {
  if (!cachedSecret) {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SESSION_SECRET_ARN }))
    cachedSecret = out.SecretString
  }
  return cachedSecret
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

async function issueToken(user) {
  const ttlDays = Number(process.env.TOKEN_TTL_DAYS || 30)
  const exp = Date.now() + ttlDays * 24 * 60 * 60 * 1000
  const payload = b64url(JSON.stringify({ sub: user.id, email: user.email, created: user.createdAt, exp }))
  const sig = createHmac('sha256', await sessionSecret()).update(payload).digest('base64url')
  return { token: `${payload}.${sig}`, expiresAt: new Date(exp).toISOString() }
}

async function verifyToken(token) {
  const [payload, sig] = (token || '').split('.')
  if (!payload || !sig) return null
  const expected = createHmac('sha256', await sessionSecret()).update(payload).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  return claims.exp > Date.now() ? claims : null
}

const normalizeEmail = (raw) => String(raw ?? '').trim().toLowerCase()
const userKey = (email) => `users/${createHash('sha256').update(email).digest('hex')}.json`

async function readUser(email) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: process.env.USERS_BUCKET, Key: userKey(email) }))
    return JSON.parse(await out.Body.transformToString())
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null
    throw err
  }
}

async function hashPassword(password, salt) {
  return (await scryptAsync(password, salt, KEY_LEN, SCRYPT)).toString('base64')
}

function parseBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || ''
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return null
  }
}

function checkCredentials(body) {
  const email = normalizeEmail(body?.email)
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'Enter a valid email address.' }
  if (password.length < MIN_PASSWORD) return { error: `Use at least ${MIN_PASSWORD} characters for the password.` }
  if (password.length > MAX_PASSWORD) return { error: 'That password is too long.' }
  return { email, password }
}

async function signup(event) {
  const body = parseBody(event)
  if (body === null) return fail(400, 'Request body must be JSON.')
  const creds = checkCredentials(body)
  if (creds.error) return fail(400, creds.error)

  const salt = randomBytes(16)
  const user = {
    id: randomUUID(),
    email: creds.email,
    salt: salt.toString('base64'),
    hash: await hashPassword(creds.password, salt),
    createdAt: new Date().toISOString(),
  }
  try {
    // IfNoneMatch "*" makes S3 refuse the write if the account already exists, so two
    // simultaneous sign-ups for one email cannot both succeed.
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.USERS_BUCKET,
        Key: userKey(creds.email),
        Body: JSON.stringify(user),
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }),
    )
  } catch (err) {
    if (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412) {
      return fail(409, 'An account with this email already exists. Sign in instead.')
    }
    throw err
  }
  const { token, expiresAt } = await issueToken(user)
  return json(201, { email: user.email, token, expiresAt, createdAt: user.createdAt })
}

async function login(event) {
  const body = parseBody(event)
  if (body === null) return fail(400, 'Request body must be JSON.')
  const creds = checkCredentials(body)
  if (creds.error) return fail(400, creds.error)

  const user = await readUser(creds.email)
  // Hash even when the account is missing, so response time does not reveal which emails exist.
  const salt = user ? Buffer.from(user.salt, 'base64') : randomBytes(16)
  const candidate = Buffer.from(await hashPassword(creds.password, salt), 'base64')
  const stored = Buffer.from(user?.hash ?? '', 'base64')
  const ok = !!user && stored.length === candidate.length && timingSafeEqual(stored, candidate)
  if (!ok) return fail(401, 'Email or password is incorrect.')

  const { token, expiresAt } = await issueToken(user)
  return json(200, { email: user.email, token, expiresAt, createdAt: user.createdAt })
}

async function me(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || ''
  const claims = await verifyToken(auth.replace(/^Bearer\s+/i, ''))
  if (!claims) return fail(401, 'Please sign in again.')
  return json(200, { email: claims.email, expiresAt: new Date(claims.exp).toISOString(), createdAt: claims.created })
}

// Icon search for Find Art. Proxies Iconify (open-licensed icon sets, no API key) so the
// editor only talks to this origin. Only solid, filled sets are allowed: stroke-only icons
// do not import as shapes.
const ICON_PREFIXES = 'mdi,bi'
const ICON_ID_RE = /^(mdi|bi):[a-z0-9-]{1,80}$/
const ICONIFY = 'https://api.iconify.design'

async function iconSearch(event) {
  const q = String(event.queryStringParameters?.q ?? '').trim()
  if (q.length < 2 || q.length > 80) return fail(400, 'Search for at least 2 characters.')
  const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit) || 36, 1), 60)
  const params = new URLSearchParams({ query: q, limit: String(limit), prefixes: ICON_PREFIXES })
  const res = await fetch(`${ICONIFY}/search?${params}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) return fail(502, 'Icon search is unavailable right now.')
  const data = await res.json()
  const icons = (data.icons ?? []).filter((id) => ICON_ID_RE.test(id)).map((id) => ({ id }))
  return { statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }, body: JSON.stringify({ icons }) }
}

async function iconSvg(event) {
  const id = String(event.queryStringParameters?.id ?? '')
  if (!ICON_ID_RE.test(id)) return fail(400, 'Unknown icon.')
  const [prefix, name] = id.split(':')
  // Black fill at 24px so the importer reads real geometry, not 1em or currentColor.
  const params = new URLSearchParams({ color: '#000000', width: '24', height: '24' })
  const res = await fetch(`${ICONIFY}/${prefix}/${name}.svg?${params}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) return fail(404, 'Icon not found.')
  return {
    statusCode: 200,
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
    body: await res.text(),
  }
}

const ROUTES = {
  'POST /auth/signup': signup,
  'POST /auth/login': login,
  'GET /auth/me': me,
  'GET /icons/search': iconSearch,
  'GET /icons/svg': iconSvg,
}

export const handler = async (event) => {
  const route = `${event.requestContext?.http?.method} ${event.rawPath}`
  if (event.requestContext?.http?.method === 'OPTIONS') return withCors(event, { statusCode: 204, headers: {}, body: '' })
  const fn = ROUTES[route]
  if (!fn) return withCors(event, fail(404, 'Not found.'))
  try {
    return withCors(event, await fn(event))
  } catch (err) {
    console.error('request failed', route, err?.name, err?.message)
    return withCors(event, fail(500, 'Something went wrong. Please try again.'))
  }
}
