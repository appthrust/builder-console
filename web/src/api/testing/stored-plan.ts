// Shape of the APT-1109 captured Platform draft; prose and identities are shortened.
export const storedPlanWire = {
  summary: 'Track equipment loans', markdown: 'Equipment loans',
  representation: ['SourceRepository', 'ApplicationStack', 'Application', 'Component', 'Database', 'Publish'],
  applicationStackRequest: {
    templateId: 'biz-reservation-postgres', applicationName: 'equipment-loan',
    source: { kind: 'application-source-repository', sourceRepositoryId: 'created-source-repository' },
    web: { componentName: 'web', port: 3000 }, database: { componentName: 'postgres' }, connection: { connectionName: 'database' },
    publish: { enabled: false, subdomain: '…' },
  },
  applicationSourceRepositoryRequest: {
    template: { repository: 'appthrust/template-biz-reservation', ref: 'main' },
    destination: { repositoryName: 'equipment-loan', visibility: 'private' },
    image: { tagFilter: 'edge-', versioningScheme: 'Alphabetical' }, build: { mode: 'observed-image', ref: 'main' }, destinationRevision: 'revision-1',
  },
  implementationHandoff: {
    summary: 'Build the loan screen', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'created-source-repository',
    tasks: [{ title: 'Loans', description: 'Record a loan', acceptanceCriteria: ['A loan is saved'] }],
  },
}

export const storedDraftWire = {
  id: 'draft-loans', projectId: 'commerce', title: 'Loans', intent: 'Track loans', specMarkdown: '', architectureMarkdown: '', phase: 'planned', ownerUserId: 'owner',
  createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', creationPlan: storedPlanWire,
}
