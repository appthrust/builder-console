// `GET /config` from cmd/server: the installed project, and optionally the
// Dashboard's Team settings page. The project id must be a DNS label; a
// Dashboard link the config cannot vouch for (not an absolute http(s) URL) is
// dropped, since it is only a link to render.
import { z } from 'zod'
import type { ConsoleConfig } from '../../../model/contracts/console'
import { consoleContract } from '../define'

/** An absolute http(s) URL, else undefined: a link the config cannot vouch for is not rendered. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

const configReader: z.ZodType<ConsoleConfig> = z
  .object({
    projectId: z.string().max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
    dashboardUrl: z.unknown().optional(),
  })
  .transform((config): ConsoleConfig => {
    const dashboardUrl = httpUrl(config.dashboardUrl)
    return dashboardUrl ? { projectId: config.projectId, dashboardUrl } : { projectId: config.projectId }
  })

export const configContract = consoleContract({
  operationId: 'consoleGetConfig',
  source: 'config',
  method: 'GET',
  routeTemplate: '/config',
  successStatuses: [200],
  reader: configReader,
  request: () => ({ method: 'GET', path: '/config', cache: 'no-store' }),
})
