import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

// Dev transport mirrors production: the console server serves `/api/console/*`
// and the app switcher's `/launcher`, and reverse-proxies `/api/v1/*`
// same-origin to the Platform API (Envoy's OIDC edge adds Authorization). In
// dev the target is the in-repo mock (`bun run mock`, src/dev/mock-server.ts),
// which serves all of them and needs no
// token. To exercise a real console instead, point CONSOLE_API_UPSTREAM at it
// and either set CONSOLE_DEV_BEARER to the token the edge would attach (a local
// Go server) or CONSOLE_DEV_COOKIE_FILE to a file holding the `Cookie` header
// of an authenticated browser session (a deployed console behind its OIDC
// edge; the file is re-read per request so a refresher can rotate it). The
// proxy drops the browser Origin so upstreams treat calls as first-party.
const upstream = process.env.CONSOLE_API_UPSTREAM ?? `http://127.0.0.1:${process.env.CONSOLE_MOCK_PORT ?? 54385}`
const devBearer = process.env.CONSOLE_DEV_BEARER
const devCookieFile = process.env.CONSOLE_DEV_COOKIE_FILE
const proxy: ProxyOptions = {
  target: upstream,
  changeOrigin: true,
  configure(server) {
    server.on('proxyReq', (request) => {
      request.removeHeader('origin')
      if (devBearer) request.setHeader('authorization', `Bearer ${devBearer}`)
      if (devCookieFile) request.setHeader('cookie', readFileSync(devCookieFile, 'utf8').trim())
    })
  },
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const projectId = env.VITE_CONSOLE_PROJECT_ID || env.PLATFORM_PROJECT_ID || 'commerce'
  return {
    plugins: [
      tailwindcss(),
      {
        name: 'console-project-config',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.method !== 'GET' || request.url?.split('?')[0] !== '/config') {
              next()
              return
            }
            response.setHeader('Content-Type', 'application/json')
            response.setHeader('Cache-Control', 'no-store')
            response.end(JSON.stringify({ projectId, newAppConversation: false }))
          })
        },
      },
    ],
    esbuild: { jsx: 'automatic' },
    server: {
      port: Number(process.env.CONSOLE_PORT ?? 5199),
      strictPort: true,
      proxy: { '/api': proxy, '/launcher': proxy },
    },
  }
})
