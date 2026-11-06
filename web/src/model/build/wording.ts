// Hidden words (ux-design §4): model-written text that names the platform's
// insides is not shown outside 「詳しい人向け」.
const INFRA_WORDS = /kubernetes|\brepo(?:sitory)?\b|\bbranch\b|workspace|codex|\bimage\b|\bport\b|\bstack\b|next\.js|postgres|リポジトリ|ブランチ|ワークスペース|コンテナ|ポート|スタック/i

/** True when `text` is business language a person who builds apps (not infrastructure) can read. */
export function isProductLanguage(text: string): boolean {
  return !INFRA_WORDS.test(text)
}
