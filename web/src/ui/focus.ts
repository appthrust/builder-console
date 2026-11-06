import { useState, type RefObject } from 'react'

/** Move keyboard focus after the new step has committed; headings stay outside the tab order. */
export function focusHeading(id: string): void {
  const heading = document.getElementById(id)
  if (!heading) return
  heading.tabIndex = -1
  heading.focus()
}

/** Capture at the open transition, before a child input's autoFocus can steal the opener. */
export function useReturnFocus(open: boolean, returnFocusRef?: RefObject<HTMLElement | null>) {
  const [wasOpen, setWasOpen] = useState(false)
  const [opener, setOpener] = useState<HTMLElement | null>(null)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      const active = document.activeElement
      if (active instanceof HTMLElement) {
        // A menu item disappears when it opens a dialog. Return to its trigger instead.
        const menu = active.closest('[role="menu"]')
        setOpener(menu?.id
          ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`) ?? active
          : active)
      }
    }
  }
  return {
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      const target = returnFocusRef?.current ?? opener
      if (target?.isConnected) target.focus({ preventScroll: true })
    },
  }
}
