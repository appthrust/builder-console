import { useEffect } from 'react'
import { copy } from '../copy'

/** Page-owned title, restored on unmount so loading/error routes never retain the previous page. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title
    const next = `${title} – ${copy.product}`
    document.title = next
    return () => {
      if (document.title === next) document.title = previous
    }
  }, [title])
}
