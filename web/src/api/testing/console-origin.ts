// Test seam: the shared happy-dom window opened at the Console's own origin.
// Preview decoders trust only `https://pv-<32 hex>.<project-domain>` beside the
// Console origin `https://console.<project-domain>` they run at.

/** Moves the shared window to `origin`; returns the restore (call it in afterEach / finally). */
export function atConsoleOrigin(origin: string): () => void {
  const happyDOM: unknown = 'happyDOM' in window ? window.happyDOM : undefined
  if (!happyDOM || typeof happyDOM !== 'object' || !('setURL' in happyDOM) || typeof happyDOM.setURL !== 'function') throw new Error('the test window is not happy-dom (test/dom.ts preload)')
  const setURL = happyDOM.setURL.bind(happyDOM) as (url: string) => void
  const previous = window.location.href
  setURL(`${origin}/`)
  return () => setURL(previous)
}
