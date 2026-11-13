import type { NewSessionEngine } from './entry'

/**
 * The engine `/new` creates a session with: console-v1 only when the server's `/config` turns the NEW-APP
 * conversation on (`BUILDER_CONSOLE_NEW_APP_CONVERSATION`, resolved for the caller), else the legacy engine.
 * Opening an existing draft never reads this (the resolver decides, routes/build.tsx).
 */
export function newSessionEngine(config: object): NewSessionEngine {
  return 'newAppConversation' in config && config.newAppConversation === true ? 'console-v1' : 'platform-v1'
}
