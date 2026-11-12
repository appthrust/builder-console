import { useLayoutEffect, useRef } from 'react'

/** Distance from the bottom, in pixels, still treated as "reading the newest line". */
const FOLLOW_SLACK = 8

/**
 * The AI's live activity: every line received, in a box that scrolls.
 * New lines keep the newest in view until the reader scrolls up to read earlier ones.
 */
export function ActivityLog({ lines, label, className }: { lines: string[]; label: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const following = useRef(true)
  const text = lines.join('\n')
  useLayoutEffect(() => {
    const box = ref.current
    if (box && following.current) box.scrollTop = box.scrollHeight
  }, [text])
  if (!lines.length) return null
  return <pre
    ref={ref}
    aria-label={label}
    tabIndex={0}
    onScroll={(event) => {
      const box = event.currentTarget
      following.current = box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK
    }}
    className={`overflow-auto whitespace-pre-wrap break-words rounded bg-stone-50 font-mono text-xs leading-relaxed text-stone-600 ${className ?? ''}`}
  >{text}</pre>
}
