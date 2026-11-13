// Test seam: the production gateway over injected network calls, so tests and
// fixture replays exercise the real transports and decoders, not casts.
import type { ReportFailure } from '../boundary'
import { createPlatformTransport } from '../client'
import { createConsoleTransport } from '../console'
import { createApiGateway, type ApiGateway } from '../gateway'

export function createTestGateway(options: {
  consoleFetch?: Parameters<typeof createConsoleTransport>[0]
  platformFetch?: (request: Request) => Promise<Response>
  reportFailure?: ReportFailure
} = {}): ApiGateway {
  return createApiGateway({
    platformTransport: createPlatformTransport({ fetch: options.platformFetch, origin: () => 'http://console.test' }),
    consoleTransport: createConsoleTransport(options.consoleFetch),
    reportFailure: options.reportFailure ?? (() => {}),
  })
}
