#!/usr/bin/env node
// One-off move of accounts from the old AWS accounts API (one JSON file per user in S3)
// into the Postgres database. Password hashes use the same scrypt settings, so people keep
// their passwords; they only have to sign in again once.
//
//   aws s3 sync s3://<users-bucket>/users ./aws-users      (owner, on their own machine)
//   DATABASE_URL=postgres://... node scripts/import-aws-users.mjs ./aws-users
//
// Safe to run twice: existing emails are skipped. Delete ./aws-users afterwards.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createNeonDb } from '../server/db.js'

const dir = process.argv[2]
if (!dir || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=... node scripts/import-aws-users.mjs <folder of user JSON files>')
  process.exit(1)
}

const db = createNeonDb(process.env.DATABASE_URL)
await db.ready()

let added = 0
let skipped = 0
for (const name of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
  const u = JSON.parse(await readFile(join(dir, name), 'utf8'))
  if (!u.id || !u.email || !u.salt || !u.hash) {
    console.warn('skipping malformed file', name)
    skipped++
    continue
  }
  const ok = await db.createUser({ id: u.id, email: u.email, salt: u.salt, hash: u.hash, createdAt: u.createdAt ?? new Date().toISOString() })
  if (ok) added++
  else skipped++
}
console.log(`Imported ${added} account(s), skipped ${skipped}.`)
