import { useEffect, useState } from 'react'

/** The current time, ticking every second while `active`: elapsed labels are the only proof a long step is alive. */
export function useClock(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
