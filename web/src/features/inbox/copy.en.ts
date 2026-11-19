import type { inboxJa } from './copy'

export const inboxEn: typeof inboxJa = {
  title: 'Waiting for you',
  count: (n: number) => (n === 1 ? '1 item' : `${n} items`),
  seeAll: 'See all',
  rowsLabel: 'Items waiting for you',
  pill: {
    problem: () => 'Needs attention',
    proposal: (n: number) => (n === 1 ? '1 proposal' : `${n} proposals`),
    accessRequest: (n: number) => (n === 1 ? '1 access request' : `${n} access requests`),
    feedback: (n: number) => (n === 1 ? '1 comment' : `${n} comments`),
    draft: () => 'Draft',
  },
  note: {
    proposalBy: (name: string) => `A proposal from ${name} is waiting for your review.`,
    proposal: 'A proposal is waiting for your review.',
    accessRequest: 'Someone has asked to use this app.',
    feedback: 'People using this app left new comments.',
    draft: 'Not finished yet. You can pick up where you left off.',
  },
  action: {
    problem: 'Check status',
    proposal: 'View proposal',
    accessRequest: 'View requests',
    feedback: 'View comments',
    draft: 'Continue',
  },
  actionLabel: (action: string, app: string) => `${app}: ${action}`,
}
