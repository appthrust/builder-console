import type { textJa } from './copy'

export const textEn: typeof textJa = {
  migration: {
    title: 'Move people and groups to Directory',
    body: 'People and groups are now managed in Directory. Move what the console still holds there once. App owners and sharing stay unchanged.',
    counts: (people: number, groups: number, memberships: number) =>
      `${people} ${people === 1 ? 'person' : 'people'} · ${groups} ${groups === 1 ? 'group' : 'groups'} · ${memberships} ${memberships === 1 ? 'membership' : 'memberships'}`,
    start: 'Move to Directory',
    confirmTitle: 'Move people and groups to Directory?',
    confirmBody: 'Existing IDs are kept, so app owners and sharing stay valid. Running it again does not duplicate anything.',
    confirm: 'Move',
    doneTitle: 'Moved to Directory',
    imported: (people: number, groups: number, memberships: number) =>
      `Imported: ${people} ${people === 1 ? 'person' : 'people'} · ${groups} ${groups === 1 ? 'group' : 'groups'} · ${memberships} ${memberships === 1 ? 'membership' : 'memberships'}`,
    conflicts: (n: number) => `${n} ${n === 1 ? 'entry was' : 'entries were'} not moved. Check them in Directory.`,
    conflictsLabel: 'Entries not moved',
    entity: { person: 'Person', group: 'Group', membership: 'Membership' } as Record<string, string>,
    openDirectory: 'Open Directory',
  },
  platform: {
    summaryReady: 'Ready to create apps',
    summaryReadyBody: 'All required connections are set up.',
    summaryMissing: (n: number) => `${n} ${n === 1 ? 'setting' : 'settings'} missing`,
    summaryMissingBody: 'Apps cannot be created yet. Ask your workspace administrator to finish setup.',
    readOnly: 'This page is read-only. Your workspace administrator manages these settings.',
    ready: 'Set up',
    missing: 'Not set up',
    checking: 'Checking',
    unknown: 'Unable to check',
    domain: 'Public domain',
    domainOn: (domain: string) => `App URLs will be https://〈URL name〉.${domain}.`,
    domainOff: 'No public domain is set up. Ask your workspace administrator to add one.',
    domainFailed: 'Could not check the public domain.',
    teamYou: 'You can create apps.',
    teamNotYou: 'You do not have permission to create apps yet. Ask your workspace administrator if you need access.',
    advancedLead: 'Share these details when contacting your workspace administrator.',
  },
}
