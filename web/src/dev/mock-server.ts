// Dev-only API mock: `bun src/dev/mock-server.ts` (or `bun run mock`). Serves
// the console contract (`/api/console/*`, ./mock-console), the Platform API
// subset the console uses (`/api/v1/*`, ./mock-platform) and the built-in app
// switcher's `GET /launcher` on one port; Vite proxies `/api` and `/launcher`
// here (vite.config.ts).
import { createMockLauncherHandler, mockLauncherEntries } from '@appthrust/app-launcher'
import { consoleRoutes } from './mock-console'
import { platformRoutes } from './mock-platform'

const port = Number(process.env.CONSOLE_MOCK_PORT ?? 54385)
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

console.log(`builder-console mock API on http://${server.hostname}:${server.port} (MOCK_ROLE=${process.env.MOCK_ROLE ?? 'Admin'})`)
