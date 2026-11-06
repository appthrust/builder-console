import { localized } from '../shell/language'
import { aiPolicyCopyEn } from './ai-policy.en'

export const aiPolicyCopyJa = {
  title: 'AI ポリシーの確認が必要です',
  policy: (name?: string) => `この Project の AI ポリシー${name ? `「${name}」` : ''}`,
  reasons: {
    ai_policy_pending: 'の適用待ちです。',
    ai_policy_denied: 'では、AI の利用が許可されていません。',
    ai_model_denied: 'では、利用できるモデルが許可されていません。',
    ai_model_unresolved: 'では、利用できるモデルが許可されていません。',
    ai_approval_policy_denied: 'では、自動実行（unattended）が許可されていません。',
  },
  unknown: 'により、AI を利用できません。',
  contact: '基盤の担当者に確認してください。',
}

export const aiPolicyCopy = localized({ ja: aiPolicyCopyJa, en: aiPolicyCopyEn })

/** Shared by creation-tools gates and structured/legacy AI failures. */
export function aiPolicyExplanation(reason: unknown, policy?: unknown): string | undefined {
  if (typeof reason !== 'string' || !reason.startsWith('ai_')) return undefined
  const detail = Object.hasOwn(aiPolicyCopy.reasons, reason)
    ? aiPolicyCopy.reasons[reason as keyof typeof aiPolicyCopy.reasons]
    : aiPolicyCopy.unknown
  return aiPolicyCopy.policy(typeof policy === 'string' ? policy : undefined) + detail + aiPolicyCopy.contact
}
