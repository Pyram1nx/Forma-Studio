import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// Local dev can talk to the accounts API through the dev-server proxy: set
// FORMA_API_TARGET and VITE_API_URL=/api in .env.development.local (git-ignored).
// The target URL must not appear in tracked files (see deploy/RUNBOOK.md), and
// without it no proxy is created, so contributor builds stay accounts-off.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = process.env.FORMA_API_TARGET || env.FORMA_API_TARGET
  return {
    plugins: [react()],
    server: {
      // Allow Cloudflare quick tunnels (dev sharing).
      allowedHosts: ['.trycloudflare.com'],
      // Proxy /api/* to the accounts API so the browser stays same-origin
      // (no CORS involved; the Lambda's ALLOWED_ORIGINS is left untouched).
      ...(apiTarget
        ? {
            proxy: {
              '/api': {
                target: apiTarget,
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ''),
              },
            },
          }
        : {}),
    },
    build: {
      // three.js (3D Carve) is code-split into its own chunk; it's large by nature.
      chunkSizeWarningLimit: 800,
    },
  }
})
