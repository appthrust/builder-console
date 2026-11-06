// Builder-console story E2E against the deterministic in-memory mock
// (`src/dev/mock-server.ts`) behind the Vite dev server, exactly the surface
// `bun run dev` serves. Vite proxies `/api` to the mock, so the browser's
// requests (and Playwright's request assertions) go through one origin.
import { defineConfig } from '@playwright/test'

const host = process.env.CONSOLE_E2E_HOST ?? '127.0.0.1'
const port = Number.parseInt(process.env.CONSOLE_E2E_PORT ?? '5209', 10)
const mockPort = Number.parseInt(process.env.CONSOLE_E2E_MOCK_PORT ?? '54395', 10)
const retries = Number.parseInt(process.env.APPTHRUST_E2E_RETRIES ?? '0', 10)
const testTimeout = Number.parseInt(process.env.APPTHRUST_E2E_TEST_TIMEOUT_MS ?? '30000', 10)
const reuse = process.env.APPTHRUST_E2E_REUSE_SERVER === '1'

export default defineConfig({
  testDir: './stories',
  outputDir: './results',
  timeout: testTimeout,
  retries,
  // The mock is one in-memory state; stories reset it (support/fixtures.ts)
  // and therefore run serially.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: `http://${host}:${port}`,
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    screenshot: 'only-on-failure',
    launchOptions: process.env.APPTHRUST_E2E_CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.APPTHRUST_E2E_CHROME_EXECUTABLE_PATH }
      : undefined,
  },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  webServer: [
    {
      command: `CONSOLE_MOCK_PORT=${mockPort} bun src/dev/mock-server.ts`,
      cwd: process.cwd(),
      port: mockPort,
      reuseExistingServer: reuse,
      timeout: 30_000,
    },
    {
      command: `CONSOLE_MOCK_PORT=${mockPort} CONSOLE_PORT=${port} VITE_CONSOLE_DEVTOOLS=0 bun x vite --host ${host} --port ${port} --strictPort`,
      cwd: process.cwd(),
      port,
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
  ],
})
