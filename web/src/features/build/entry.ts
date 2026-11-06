import { createDraft, listDrafts } from '../../api/build'
import { membershipRoots, type Group, type Me } from '../../api/console'
import { findResumableDraft } from '../../model/build/resume'
import { initialSession, readBuildSession, saveBuildSession, titleFromIntent } from './session'
import { text } from './copy'

/** AI creation needs a membership, never an arbitrary visible directory group. */
export function resolveBuildGroup(me: Pick<Me, 'effectiveGroupIds'>, groups: readonly Group[], currentGroup?: Pick<Group, 'id'>): string | undefined {
  return currentGroup?.id ?? membershipRoots(me, groups)[0]?.id ?? me.effectiveGroupIds[0]
}

/** Resumes the caller's unfinished draft with these exact words when there is one; otherwise starts a new draft. */
export async function beginBuild(projectId: string, intent: string, options: { groupId: string; ownerSubject: string }) {
  if (!options.groupId) throw new Error(text.page.noGroup.body)
  const existing = findResumableDraft((await listDrafts(projectId)).data, intent)
  if (existing) {
    if (!readBuildSession(existing.id)) saveBuildSession(existing.id, initialSession({ projectId, ownerSubject: options.ownerSubject, groupId: options.groupId, baseIntent: existing.intent }))
    return existing
  }
  const draft = await createDraft(projectId, { title: titleFromIntent(intent), intent: intent.trim() })
  saveBuildSession(draft.id, initialSession({ projectId, ownerSubject: options.ownerSubject, groupId: options.groupId, baseIntent: intent.trim() }))
  return draft
}
