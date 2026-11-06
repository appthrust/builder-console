import { useBlocker } from '@tanstack/react-router'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { copy } from '../copy'
import { ConfirmDialog } from './overlay'

type RegisterGuard = (message: string) => () => void
const GuardContext = createContext<RegisterGuard | null>(null)

/** One blocker per page tree: multiple dirty settings sections produce one prompt, not one each. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Map<symbol, string>>(() => new Map())
  const register = useCallback<RegisterGuard>((message) => {
    const id = Symbol()
    setMessages((current) => new Map(current).set(id, message))
    return () => setMessages((current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }, [])
  const blocker = useBlocker({
    // Wizard steps and settings anchors retain their forms; only leaving the page discards them.
    shouldBlockFn: ({ current, next }) => messages.size > 0 && current.pathname !== next.pathname,
    withResolver: true,
    // TanStack owns the native beforeunload listener; browsers supply their own prompt wording.
    enableBeforeUnload: messages.size > 0,
    disabled: messages.size === 0,
  })
  return (
    <GuardContext.Provider value={register}>
      {children}
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => { if (!open) blocker.reset?.() }}
        title={copy.unsavedChanges.title}
        body={messages.values().next().value}
        confirmLabel={copy.unsavedChanges.leave}
        cancelLabel={copy.unsavedChanges.stay}
        onConfirm={() => blocker.proceed?.()}
      />
    </GuardContext.Provider>
  )
}

/** Register unsaved work until the form saves or unmounts. Same-page search/hash changes remain usable. */
export function useUnsavedChangesGuard(dirty: boolean, message: string): void {
  const register = useContext(GuardContext)
  if (!register) throw new Error('useUnsavedChangesGuard requires UnsavedChangesProvider')
  useEffect(() => {
    if (dirty) return register(message)
  }, [dirty, message, register])
}
