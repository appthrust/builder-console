// Real, separate HTTPS hosts for the preview-origin stories (APT-798).
//
// The Console is opened as `https://console.commerce.appthrust.test` and each
// workspace preview as `https://pv-<32 hex>.commerce.appthrust.test`: two
// origins of one site, exactly as in production (same-site siblings, no port,
// HTTPS so `__Host-` / Secure Cookies behave as they do there). Chromium maps
// the names to local ports with `--host-resolver-rules`:
// - the Console host → a TLS front started here, forwarding HTTP and WebSocket
//   (Vite HMR) to the Vite dev server of the Playwright config;
// - every other `*.commerce.appthrust.test` (and the cross-site
//   `*.commerce.preview-isolation.test` the mock uses to make the browser refuse
//   the session Cookie) → the mock's preview-origin TLS server (mock port + 1).
// Certificates are throwaway self-signed ones (`ignoreHTTPSErrors`).
//
// The `request` fixture keeps the config's http://127.0.0.1 base URL for mock
// control; pages navigate with `consoleUrl(path)`.
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer, type Server } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT = 'commerce'
export const CONSOLE_ORIGIN = `https://console.${PROJECT}.appthrust.test`
const vitePort = Number.parseInt(process.env.CONSOLE_E2E_PORT ?? '5209', 10)
const mockPort = Number.parseInt(process.env.CONSOLE_E2E_MOCK_PORT ?? '54395', 10)
/** mock-server.ts serves the preview origins on CONSOLE_MOCK_PREVIEW_PORT, by default its own port + 1. */
const previewPort = mockPort + 1
const frontPort = Number.parseInt(process.env.CONSOLE_E2E_TLS_PORT ?? String(vitePort + 1), 10)

const hostRules = [
  `MAP console.${PROJECT}.appthrust.test 127.0.0.1:${frontPort}`,
  `MAP *.${PROJECT}.appthrust.test 127.0.0.1:${previewPort}`,
  `MAP *.${PROJECT}.preview-isolation.test 127.0.0.1:${previewPort}`,
].join(', ')

/** `test.use(...)` for a story that opens the Console and its previews on their real hosts. */
export const previewHosts = {
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: [`--host-resolver-rules=${hostRules}`],
    ...(process.env.APPTHRUST_E2E_CHROME_EXECUTABLE_PATH ? { executablePath: process.env.APPTHRUST_E2E_CHROME_EXECUTABLE_PATH } : {}),
  },
}

export const consoleUrl = (path: string) => new URL(path, CONSOLE_ORIGIN).href

function certificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'builder-console-front-tls-'))
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
      '-subj', `/CN=console.${PROJECT}.appthrust.test`, '-addext', `subjectAltName=DNS:console.${PROJECT}.appthrust.test`,
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Vite only answers its own host names; the front forwards with the dev server's host. */
function forwarded(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return { ...headers, host: `127.0.0.1:${vitePort}` }
}

/**
 * A page served on the Console's host name that is not the Console (design R3/N20): it embeds the preview
 * origin given in `?src=` and lays a decoy over it. It reads nothing from the frame; it only shows what a
 * fake Console on the embedding host name could do while the viewer's session Cookie is still valid.
 */
function fakeConsole(src: string): string {
  const safe = src.replace(/[^a-z0-9:/.-]/g, '')
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>偽の Console</title>
<style>body{margin:0;font-family:system-ui,sans-serif}#stage{position:relative;width:640px;height:320px}iframe{width:640px;height:320px;border:0}#decoy{position:absolute;left:24px;top:150px;padding:8px 14px;background:#facc15;font-size:14px;opacity:.85;pointer-events:none}</style></head>
<body><div id="stage"><iframe title="埋め込まれたプレビュー" src="${safe}/" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe><div id="decoy">景品を受け取る</div></div></body></html>`
}

/** Starts the Console's TLS front; resolves to its stop. */
export async function startConsoleFront(): Promise<() => Promise<void>> {
  const server: Server = createServer(certificate(), (request, response) => {
    const url = new URL(request.url ?? '/', CONSOLE_ORIGIN)
    if (url.pathname === '/__fake-console') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(fakeConsole(url.searchParams.get('src') ?? ''))
      return
    }
    const upstream = httpRequest({ host: '127.0.0.1', port: vitePort, method: request.method, path: request.url, headers: forwarded(request.headers) }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    request.pipe(upstream)
  })
  // WebSocket upgrades (Vite HMR) go through as raw bytes after the rewritten request head.
  server.on('upgrade', (request, socket, head) => {
    const upstream = connect(vitePort, '127.0.0.1', () => {
      const headers = Object.entries(forwarded(request.headers)).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`))
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const close = () => { upstream.destroy(); socket.destroy() }
    upstream.on('error', close)
    socket.on('error', close)
  })
  server.listen(frontPort, '127.0.0.1')
  await once(server, 'listening')
  return async () => {
    server.closeAllConnections()
    await promisify(server.close.bind(server))()
  }
}
