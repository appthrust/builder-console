// 「AI と作る」 pressed again with the same words resumes the session it started
// before instead of opening another one: /new keeps the typed intent across
// visits, so a second press (back button, reload, retry) otherwise multiplies
// 作りかけ. A draft whose app was already created is a different thing.
import type { BuildDraft } from '../contracts/build'
import { textJa } from './copy'
import { textEn } from './copy.en'

const INTENT_MARKERS = [textJa.intent, textEn.intent]

/** Read saved replies from either language so switching never creates a duplicate draft. */
function baseIntent(intent: string): string {
  let base = intent
  for (const marker of INTENT_MARKERS) {
    base = base.split(`\n\n${marker.reply}\n\n`, 1)[0]!.split(`\n\n${marker.publish}`, 1)[0]!
  }
  return base.trim()
}

export function findResumableDraft(drafts: readonly BuildDraft[], intent: string): BuildDraft | undefined {
  const wanted = intent.trim()
  if (!wanted) return undefined
  return drafts
    // A phase this console does not know may already be past creation: never resume into it.
    .filter((draft) => baseIntent(draft.intent) === wanted && draft.phase.kind === 'known' && draft.phase.value !== 'created' && draft.phase.value !== 'archived' && !draft.createdApplicationStackId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
}
