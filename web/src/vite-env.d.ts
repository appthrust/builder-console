/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only Project override for the mock harness; production reads /config. */
  readonly VITE_CONSOLE_PROJECT_ID?: string
}
