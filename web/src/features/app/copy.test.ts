import { expect, test } from 'bun:test'
import type { ApplicationDraftImplementationRun } from '@appthrust/api-schema/platform-api'
import { appSecondLine, type ConsoleApp } from '../../model/app'
import { deriveAccess } from '../../model/access'
import { shareSentence } from '../../model/share'
import { preserveLanguage } from '../../../test/language'
import { setLanguage } from '../../shell/language'
import { text } from './copy'

const platform: ConsoleApp = {
  id: 'app', name: 'App', status: 'deploying', statusText: '', branchId: 'production',
  facts: { webReady: false, everReleased: false, hasPublish: false },
}
const run: ApplicationDraftImplementationRun = {
  id: 'run', status: 'running', devWorkspaceId: 'workspace', startedAt: '2026-10-13T00:00:00Z',
  currentTaskId: 'screen', step: 'working', taskIds: ['screen'],
  tasks: [{ id: 'screen', title: 'Customers', status: 'running' }],
}

// Resolve after import, including a return to Japanese; module-load snapshots must not pin the language.
test('app wording switches at access time and preserves Japanese punctuation', () => {
  const restoreLanguage = preserveLanguage()
  try {
    setLanguage('ja')
    expect(text.header.tabsLabel).toBe('アプリのページ')
    expect(text.overview.ask(['山田', '田中'])).toBe('担当者に聞く（山田、田中）')
    expect(text.overview.emailSubject('見積')).toBe('見積について')
    expect(text.settings.envEditLabel('TOKEN')).toBe('TOKEN の値を変える')
    expect(text.settings.envRemoveLabel('TOKEN')).toBe('TOKEN を削除')
    expect(text.settings.personAction('山田', text.settings.ownerAddShort)).toBe('山田 を担当にする')
    setLanguage('en')
    expect(text.header.tabsLabel).toBe('App pages')
    expect(text.overview.ask(['Alex', 'Sam'])).toBe('Contact owners (Alex, Sam)')
    expect(text.overview.emailSubject('Quotes')).toBe('About Quotes')
    expect(text.settings.envEditLabel('TOKEN')).toBe('Change value for TOKEN')
    expect(text.settings.envRemoveLabel('TOKEN')).toBe('Remove TOKEN')
    expect(text.settings.personAction('Alex', text.settings.ownerAddShort)).toBe('Make owner: Alex')
    expect(text.settings.envPending(1)).toBe('You have 1 unsaved change.')
    expect(text.settings.envPending(2)).toBe('You have 2 unsaved changes.')
    setLanguage('ja')
    expect(text.settings.envPending(2)).toBe('保存していない変更が 2 件あります。')
  } finally {
    restoreLanguage()
  }
})

test('build model sentences use the current language without changing status rules', () => {
  const restoreLanguage = preserveLanguage()
  try {
    setLanguage('en')
    const build = { draftId: 'draft', taskCount: 1, run }
    expect(appSecondLine(platform, [], 0, build)).toBe('Building the “Customers” screen')
    expect(appSecondLine(platform, [], 0, { ...build, run: { ...run, step: 'pushing' } })).toBe('Saving')
    expect(appSecondLine(platform, [], 0, { ...build, run: { ...run, status: 'failed' } })).toBe('Stopped')
    expect(appSecondLine(platform, [], 0, { ...build, run: { ...run, status: 'cancelled' } })).toBe('Stopped')
    expect(appSecondLine(platform, [], 0, { ...build, run: { ...run, status: 'succeeded' } })).toBe('Stopped')
    expect(appSecondLine(platform, [], 0, { ...build, run: { ...run, status: 'succeeded', tasks: [{ ...run.tasks[0]!, status: 'done' }] } })).toBe('Getting ready to publish')
    expect(appSecondLine(platform, [], 0, { ...build, run: { ...run, status: 'succeeded', tasks: [] } })).toBe('No screens built yet')
    const technical = { ...build, run: { ...run, tasks: [{ ...run.tasks[0]!, title: 'Codex workspace' }] } }
    expect(appSecondLine(platform, [], 0, technical)).toBe('Building the “App” screen')
    setLanguage('ja')
    expect(appSecondLine(platform, [], 0, technical)).toBe('画面「アプリ」を作っています')
  } finally {
    restoreLanguage()
  }
})

test('group lists localize separators without translating user-supplied names', () => {
  const restoreLanguage = preserveLanguage()
  const groups = [{ id: 'sales', name: 'Sales' }, { id: 'support', name: 'Support' }]
  const app = { share: { scope: 'group' as const, groupIds: ['sales', 'support'], extraPersonIds: [] }, owners: [{ id: 'owner' }] }
  const access = { mode: 'Authenticated' as const, authorization: { defaultAction: 'Allow' as const, ruleCount: 0, external: { appInstallation: 'builder-console', path: '/authz' } } }
  try {
    setLanguage('ja')
    expect(shareSentence(app.share, groups)).toBe('Sales・Support に公開')
    expect(deriveAccess(access, app, groups).label).toBe('限定（1 人・Sales、Support）')
    setLanguage('en')
    expect(shareSentence(app.share, groups)).toContain('Sales, Support')
    expect(deriveAccess(access, app, groups).label).toContain('Sales, Support')
  } finally {
    restoreLanguage()
  }
})
