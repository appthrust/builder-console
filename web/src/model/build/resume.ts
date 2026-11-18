// 「AI と作る」 pressed again with the same words resumes the session it started
// before instead of opening another one: /new keeps the typed intent across
// visits, so a second press (back button, reload, retry) otherwise multiplies
// 作りかけ. A draft whose app was already created is a different thing.
import type { BuildDraft } from '../contracts/build'
import { sameBuildOpening } from './questions'

export async function findResumableDraft(drafts: readonly BuildDraft[], intent: string): Promise<BuildDraft | undefined> {
  const wanted = intent.trim()
  if (!wanted) return undefined
  let newest: BuildDraft | undefined
  for (const draft of drafts) {
    if (draft.phase.kind !== 'known' || draft.phase.value === 'created' || draft.phase.value === 'archived' || draft.createdApplicationStackId) continue
    if ((!newest || Date.parse(draft.updatedAt) > Date.parse(newest.updatedAt)) && await sameBuildOpening(draft.intent, wanted)) newest = draft
  }
  return newest
}
