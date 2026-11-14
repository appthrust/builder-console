import type { ConsoleConfig } from '../../model/contracts/console'
import type { NewSessionEngine } from './entry'

/**
 * The engine `/new` creates a session with: console-v1 when the server's `/config` turns the NEW-APP
 * conversation on for the caller (the Console administrator setting on 基盤の設定), else the legacy engine.
 * Opening an existing draft never reads this (the resolver decides, routes/build.tsx).
 */
export function newSessionEngine(config: Pick<ConsoleConfig, 'newAppConversation'>): NewSessionEngine {
  return config.newAppConversation ? 'console-v1' : 'platform-v1'
}
