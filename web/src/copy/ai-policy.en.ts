export const aiPolicyCopyEn = {
  title: 'AI policy needs attention',
  policy: (name?: string) => `This Project's AI policy${name ? ` “${name}”` : ''}`,
  reasons: {
    ai_policy_pending: ' is waiting to be applied. ',
    ai_policy_denied: ' does not allow AI use. ',
    ai_model_denied: ' has no permitted model available. ',
    ai_model_unresolved: ' has no permitted model available. ',
    ai_approval_policy_denied: ' does not allow unattended execution. ',
  },
  unknown: ' prevents AI use. ',
  contact: 'Contact your platform administrator.',
}
