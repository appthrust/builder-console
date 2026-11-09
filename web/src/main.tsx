import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { queryClient } from './api/queries'
import { router } from './router'
import { useLanguage } from './shell/language'
import { SessionExpiryBoundary } from './ui/session-expired'
import './styles.css'

// A stale deployment chunk gets one full navigation per tab session, never a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'builder-console:preload-reloaded'
  try {
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
  } catch {
    // Without persistent storage a reload cannot be bounded across document loads.
    return
  }
  event.preventDefault()
  window.location.reload()
})

// Dev-only inspectors, loaded on demand so they never reach the production bundle.
// Their floating toggles sit bottom-right over the row Sheet's footer, so the
// story run (e2e/playwright.config.ts) turns them off with VITE_CONSOLE_DEVTOOLS=0.
const Devtools = import.meta.env.DEV && import.meta.env.VITE_CONSOLE_DEVTOOLS !== '0'
  ? lazy(async () => {
      const [{ TanStackRouterDevtools }, { ReactQueryDevtools }] = await Promise.all([
        import('@tanstack/react-router-devtools'),
        import('@tanstack/react-query-devtools'),
      ])
      return {
        default: () => (
          <>
            <TanStackRouterDevtools router={router} position="bottom-right" initialIsOpen={false} toggleButtonProps={{ style: { right: '4.5rem' } }} />
            <ReactQueryDevtools buttonPosition="bottom-right" initialIsOpen={false} />
          </>
        ),
      }
    })
  : null

function LocalizedRouter() {
  const language = useLanguage()
  // TanStack Router memoizes route matches. Remount on a language change so
  // every page and memoized subtree reads fresh copy. Local UI state is lost;
  // the shared router (URL/history) and query client/cache survive the switch.
  return <RouterProvider key={language} router={router} />
}

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionExpiryBoundary><LocalizedRouter /></SessionExpiryBoundary>
      {Devtools ? (
        <Suspense fallback={null}>
          <Devtools />
        </Suspense>
      ) : null}
    </QueryClientProvider>
  </StrictMode>
)
