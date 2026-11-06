// GitLab-style resource URLs (ux-design §7.1.1): any path that is not a fixed
// screen is a group, an app or its directory entry, optionally followed by
// `/-/<sub-page>`. Resolve decides the resource kind; the route validates its tabs.

/** First segments owned by fixed screens, the edge (`/logout`, `/oauth2`) or the proxy (`/api`). */
const RESERVED_FIRST_SEGMENTS: Record<string, true> = {
  mine: true,
  company: true,
  new: true,
  help: true,
  logout: true,
  api: true,
  oauth2: true,
  '-': true,
}

export type ResourcePath = { path: string; sub: string | null }

/**
 * Parses the splat of the catch-all route ("sales/east/team-a/-/members").
 * Returns null for reserved first segments and malformed `/-/` suffixes, which
 * must render 404 instead of reaching resolve.
 */
export function parseResourcePath(splat: string): ResourcePath | null {
  let segments: string[]
  try {
    segments = splat.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
  const [first] = segments
  if (!first || Object.hasOwn(RESERVED_FIRST_SEGMENTS, first)) return null
  const dash = segments.indexOf('-')
  if (dash === -1) return { path: segments.join('/'), sub: null }
  // `/-/` must be followed by exactly one sub-page segment.
  if (segments.length !== dash + 2) return null
  return { path: segments.slice(0, dash).join('/'), sub: segments[dash + 1] }
}

/** Only groups already visible to this caller can be offered as a 404 recovery destination. */
export function nearestGroupAncestor<T extends { path: string }>(pathname: string, groups: readonly T[]): T | undefined {
  let path: string
  try {
    path = pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/')
  } catch {
    return undefined
  }
  let nearest: T | undefined
  for (const group of groups) {
    if (path.startsWith(`${group.path}/`) && (!nearest || group.path.length > nearest.path.length)) nearest = group
  }
  return nearest
}
