# Deployment (maintainer only)

Forma Studio runs on **Vercel**: the web app is static files, and the accounts and sync
API is a handful of Vercel Functions in `api/` (all logic in `server/app.js`). Accounts and
synced designs are stored in **Neon Postgres** (serverless, free tier), connected through the
Vercel Marketplace. No secret is ever in this repository.

## How storage works

Everything is local-first. The app never waits for the network to save.

- **No account**: designs are saved in the browser's IndexedDB, and presets, the bit kit,
  units and the Systainer layout in localStorage. They survive closing the tab and the
  browser. On the first save the app asks the browser to keep its storage persistently.
- **Storage spaces**: each browser keeps one space for "no account" (`local`) and one per
  account (`u:<account id>`). Signing in switches the page to the account's space. Designs
  made without an account stay in `local`, untouched and out of sight, and show again after
  signing out. Several accounts on one device never mix.
- **Sync**: in an account space, a background engine (`src/storage/sync.ts`) pushes local
  changes and pulls other devices' changes: on start, after edits, on focus, when back
  online, and every minute. Each item carries a server revision. When a design changed on
  two devices, nothing is lost: the other device's version is kept as
  "<name> (from another device)". Settings: the device in use wins.
- **Moving designs into an account**: when signed in, the Designs page and the account page
  offer "Copy to account" for designs made without an account. The originals stay.
- **Signing out**: pending changes are pushed first. If they cannot be (offline), the person
  is asked; unsynced changes then stay on the device and sync on the next sign-in. Otherwise
  the account's copy is removed from the device (it is in the account), which suits shared
  computers.
- **Expired sessions**: the account stays selected, designs stay visible and editable, and
  syncing resumes after signing in again. Sessions refresh themselves while in use.

## One-time setup

1. **Vercel project.** At vercel.com (signed in as the repository owner), *Add New → Project*,
   import `Pyram1nx/Forma-Studio`. Vercel reads `vercel.json`; keep the defaults.
2. **Database.** In the project: *Storage → Create Database → Neon (Serverless Postgres)*, free
   plan, region **Frankfurt (fra1)**, the region `vercel.json` runs the API in (change both
   together, or every query crosses an ocean). Set **Auth to False**: the app has its own
   accounts, and Neon Auth would only add unused tables and variables. Realtime stays False.
   On *Connect a Project*: Environments **Production** only; under *Create database branch for
   deployment* **untick both** Production and Preview (production must use the main branch,
   not a fresh copy per deployment); Custom Prefix **`DATABASE`**, so it adds `DATABASE_URL`;
   Sensitive **on**. Afterwards check *Settings → Environment Variables* lists `DATABASE_URL`
   for Production only. Tables are created on the first request; nothing to run by hand.
3. **Environment variables** (*Settings → Environment Variables*), all **Production only**,
   marked *Sensitive*:

   | Name | Value |
   | --- | --- |
   | `SESSION_SECRET` | output of `openssl rand -base64 48` |
   | `VITE_API_URL` | `/api` |
   | `ALLOWED_ORIGINS` | `tauri://localhost,http://tauri.localhost,https://tauri.localhost` (desktop app) |
   | `USER_QUOTA_MB` | optional, default `50` |

   `VITE_API_URL` switches accounts on in the build. Preview builds do not get it, so they
   run accounts-off, and they never receive the database URL or the session secret.
4. **Domain** (optional): *Settings → Domains*.
5. **Fork protection**: *Settings → Git* → keep *Git Fork Protection* on (the default), so
   pull requests from forks only build after you approve them.
6. **Desktop app**: in GitHub, *Settings → Secrets and variables → Actions → Variables*, set
   `VITE_API_URL` to `https://<your domain>/api`. The release workflow builds the
   installers with it.
7. Redeploy once (*Deployments → … → Redeploy*) so the build picks up the variables.

## Deploying

Merging a pull request into `main` deploys production automatically. `main` is protected
(pull request, review and CI), so only you decide what ships. Pull requests get preview
deployments (accounts off). To deploy by hand: `npx vercel --prod` from an up-to-date `main`.

## Who can reach what

- **Database and secrets**: only in the Vercel project's Production environment and the Neon
  console, both under your account. Contributors never see them, and nothing in the
  repository or in a pull request can read them: preview builds have no access, and fork
  builds wait for your approval.
- **Deployments**: only from `main` (protected) or your own Vercel CLI login.
- **Releases**: unchanged (tag ruleset and the owner check in `release.yml`).
- **API protections**: scrypt password hashes, HMAC-signed bearer tokens (no cookies, so no
  CSRF), per-IP and per-email rate limits on sign-in, sizes and quotas checked server-side,
  every query scoped to the signed-in account, and CORS only for the desktop app's origins.

## Moving off AWS

1. Export the old users (on your machine): `aws s3 sync s3://<users bucket>/users ./aws-users`
2. Import them, keeping their passwords:
   `DATABASE_URL='<Neon production URL>' node scripts/import-aws-users.mjs ./aws-users`,
   then delete `./aws-users`.
3. Point the domain at Vercel and check sign-in.
4. Delete the AWS stack: `aws cloudformation delete-stack --stack-name <stack>` (empty its
   S3 buckets first if the delete stops on them).

People who were signed in on the old site sign in once more; their designs were always
saved on their device, so nothing is lost.

## Limits worth knowing

- Neon's free plan has a storage cap (1 GB per project when this was written); the default
  quota of 50 MB per account and 3 MB per design keeps usage well inside it for small
  numbers of users. Check the current limits on neon.tech.
- Vercel's free Hobby plan is for non-commercial use. A commercial site needs Pro.
- Safari may clear website storage after weeks without a visit. People who rely on Safari
  should sign in (designs then live in the account) or use Save to keep `.forma` files.
- There is no password reset by email yet (it needs an email service).
