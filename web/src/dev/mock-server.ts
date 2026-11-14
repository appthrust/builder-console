// Dev-only API mock: `bun src/dev/mock-server.ts` (or `bun run mock`). Serves
// the console contract (`/api/console/*`, ./mock-console), the Platform API
// subset the console uses (`/api/v1/*`, ./mock-platform) and the built-in app
// switcher's `GET /launcher` on one port; Vite proxies `/api` and `/launcher`
// here (vite.config.ts).
//
// The workspaces' preview origins (`https://pv-<hex>.<project>.appthrust.test`,
// ./mock-workspace-http.ts) are a separate HTTPS server on
// CONSOLE_MOCK_PREVIEW_PORT (default: the mock port + 1), with a throwaway
// self-signed certificate made by `openssl` at start. A browser reaches them by
// mapping those hosts to that port (e2e/stories/preview-hosts.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockLauncherHandler, mockLauncherEntries } from '@appthrust/app-launcher'
import { consoleRoutes } from './mock-console'
import { platformRoutes, previewOriginRoutes } from './mock-platform'

const port = Number(process.env.CONSOLE_MOCK_PORT ?? 54385)
const previewPort = Number(process.env.CONSOLE_MOCK_PREVIEW_PORT ?? port + 1)
const launcher = createMockLauncherHandler(mockLauncherEntries('builder-console'))

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    const response = launcher(request) ?? (await platformRoutes(request, url)) ?? (await consoleRoutes(request, url))
    return response ?? Response.json({ error: 'not_found', message: `no mock for ${request.method} ${url.pathname}` }, { status: 404 })
  },
})

/** A self-signed certificate for the preview hosts; nothing outside this process trusts it. */
function previewCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'builder-console-preview-tls-'))
  try {
    const made = Bun.spawnSync([
      'openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
      '-subj', '/CN=preview.appthrust.test', '-addext', 'subjectAltName=DNS:*.commerce.appthrust.test,DNS:*.commerce.preview-isolation.test',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ], { stdout: 'ignore', stderr: 'pipe' })
    if (made.exitCode !== 0) throw new Error(`openssl could not make the preview certificate: ${made.stderr.toString().trim()}`)
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const preview = Bun.serve({
  port: previewPort,
  hostname: '127.0.0.1',
  tls: previewCertificate(),
  async fetch(request, server) {
    return previewOriginRoutes(request, server)
  },
  websocket: {
    // The app's own development socket (an HMR stand-in): it only says hello.
    open(socket) { socket.send('connected') },
    message() {},
  },
})

console.log(`builder-console mock API on http://${server.hostname}:${server.port}, preview origins on https://${preview.hostname}:${preview.port} (MOCK_ROLE=${process.env.MOCK_ROLE ?? 'Admin'})`)
