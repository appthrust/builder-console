import type { textJa } from './copy'

export const textEn: typeof textJa = {
  stageLabels: { ask: 'Discuss', fix: 'Change', check: 'Check' },
  state: { asking: 'Improving', proposed: 'Change ready', running: 'Improving', failed: 'Stopped', unsupported: 'State unknown' },
  updated: (version?: string) => (version ? `Updated to ${version}` : 'Updated'),
  entry: {
    action: 'Improve with AI',
    title: 'Improve with AI',
    description: (app: string) => `Describe what you want to change in “${app}”. The AI reads how it works today and proposes a change.`,
    label: 'What should change?',
    placeholder: 'e.g. Add filters to the list',
    submit: 'Start',
    noSource: 'This app has no source location, so the AI cannot change it.',
    noReviewers: 'No owner has signed in yet. Ask an owner to sign in, then try again.',
    busy: 'Another conversation is in progress. Wait a moment and try again.',
  },
  page: {
    title: (name: string) => `${name} — Improve with AI`,
    back: (name: string) => `Back to ${name}`,
    drafts: 'Drafts',
    tabs: 'Views',
    sideTab: 'Changes',
  },
  conversation: {
    intro: 'The AI proposes a change from what you discuss. The owners review the finished changes before they are applied.',
    placeholder: 'Describe what to change',
    thinking: 'Reading how the app works',
  },
  proposal: {
    label: 'Proposed change',
    lead: 'This is what will change.',
    apply: 'Make this change',
  },
  run: {
    running: 'Making the change',
    starting: 'Getting ready',
    changed: 'What changed',
    openApp: 'Open the app',
    continue: 'Keep improving',
    preview: 'See the work in progress',
    previewPreparing: 'Preparing the work-in-progress view',
  },
  pane: {
    title: 'What is changing',
    empty: 'Once the change is clear, it appears here.',
    proposal: 'To change',
    progress: 'Progress',
    versions: 'Updates so far',
    appUrl: 'App URL',
    collapse: 'Collapse changes',
    expand: 'Expand changes',
  },
  drafts: {
    resume: 'Continue',
  },
}
