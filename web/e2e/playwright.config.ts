// Builder-console story E2E against the deterministic in-memory mock
// (`src/dev/mock-server.ts`) behind the Vite dev server, exactly the surface
// `bun run dev` serves. Vite proxies `/api` to the mock, so the browser's
// requests (and Playwright's request assertions) go through one origin.
//
// This is a merge gate (`console-mock-stories` in .github/workflows/ci.yml):
// no retries, no `.only`, one worker against one mock state, and every story
// passes the automatic browser checks in support/fixtures.ts.
import { defineConfig } from '@playwright/test'

const host = process.env.CONSOLE_E2E_HOST ?? '127.0.0.1'
const port = Number.parseInt(process.env.CONSOLE_E2E_PORT ?? '5209', 10)
const mockPort = Number.parseInt(process.env.CONSOLE_E2E_MOCK_PORT ?? '54395', 10)
// Local iteration may reuse already running servers; CI always starts its own.
const reuse = process.env.APPTHRUST_E2E_REUSE_SERVER === '1' && !process.env.CI

export default defineConfig({
  testDir: './stories',
  // Per-test screenshots, traces and attachments (gitignored web/e2e/results/).
  outputDir: './results',
  // Stories that need longer declare it with test.setTimeout (at most 120 s).
  timeout: 30_000,
  retries: 0,
  forbidOnly: true,
  // The mock is one in-memory state; every test resets it (support/fixtures.ts)
  // and therefore runs serially.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: `http://${host}:${port}`,
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.APPTHRUST_E2E_CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.APPTHRUST_E2E_CHROME_EXECUTABLE_PATH }
      : undefined,
  },
  // Reports land in gitignored web/playwright-report/ (HTML) and web/test-results/
  // (JUnit, JSON; CI rejects a JSON report with zero executed or any skipped test).
  reporter: [
    ['list'],
    ['junit', { outputFile: '../test-results/junit.xml' }],
    ['json', { outputFile: '../test-results/results.json' }],
    ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ],
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
