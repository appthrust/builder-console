import type { textJa } from './copy'

export const textEn: typeof textJa = {
  title: 'Proposals', sent: 'Proposal sent', accept: 'Apply', requestChanges: 'Request changes', reject: 'Decline',
  by: (name: string) => `Proposal by ${name}`,
  waiting: 'Waiting for the owners to review', incoming: 'Waiting for your review', outgoing: 'Proposals you sent',
  reviewers: (names: string) => `Reviewers: ${names}`,
  unknownPerson: 'Name unavailable', open: 'View proposal', preview: 'Preview the changes',
  tasks: 'What will change', changes: 'Changes', diff: 'View detailed changes', truncated: 'Only part of the changes is shown.',
  files: (count: number) => `${count} files`, empty: 'No proposals are waiting for review.',
  comment: 'What needs changing?', commentHelp: 'These comments will guide the next changes.',
  feedback: 'Reviewer comments', continue: 'Continue improving', back: 'Back to the app',
  phase: {
    Drafting: 'Preparing', Proposed: 'Awaiting review', ChangesRequested: 'Changes requested', Accepted: 'Apply requested',
    Applying: 'Applying', Applied: 'Applied', ApplyFailed: 'Could not apply', Rejected: 'Declined',
    Withdrawn: 'Withdrawn', Expired: 'Expired',
  },
  branchPreview: 'Preview',
  previewState: {
    Pending: 'Preparing the preview', Building: 'Building the preview', Ready: 'Preview ready',
    Failed: 'Could not build the preview', Deleting: 'Removing the preview',
  },
  previewReason: {
    PreviewBuildUnsupported: 'This app’s build setup does not support previews.',
    PreviewBranchRetired: 'The preview was removed.',
    BuildPending: 'Building the latest change.',
    HeadRevisionPending: 'Waiting for the change to arrive.',
  },
  previewReasonOther: (reason: string) => `Details: ${reason}`,
  openPreviewDetails: 'Open preview details',
  pinned: (sha: string) => `Showing ${sha}`,
  newerHead: (sha: string) => `Building newer change ${sha}`,
  changeRequest: (id: string) => `Pull request #${id}`,
  changeRequestState: { Open: 'Open', Merged: 'Merged', Closed: 'Closed' },
}
