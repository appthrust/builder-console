// Application draft reads: the reference Platform vertical. The reader is the
// canonical api-schema `ApplicationDraft` (unknown fields are dropped), with
// one registered compatibility rule: Platform omits an empty
// `creationExecutions` (Go `omitempty`), which reads as `[]`. The canonical
// `.default([])` is not relied on: it only runs when something parses, and
// the policy below is what the wire cases pin. A null or broken list fails.
import { ApplicationDraft } from '@appthrust/api-schema/platform-api'
import type { z } from 'zod'
import type { BuildDraft } from '../../../model/contracts/build'
import { absentMeansEmpty } from '../../boundary'
import { platformContract } from '../define'

const creationExecutions = absentMeansEmpty(ApplicationDraft.shape.creationExecutions.unwrap().unwrap(), {
  path: '/creationExecutions',
  evidence: 'platform-api internal/api/dto_application_draft.go:830 omits an empty list (omitempty); APT-748',
})

const draftReader: z.ZodType<BuildDraft> = ApplicationDraft.extend({ creationExecutions: creationExecutions.schema })

export const getApplicationDraftContract = platformContract({
  operationId: 'platformApiGetApplicationDraft',
  method: 'GET',
  routeTemplate: '/api/v1/projects/{projectId}/application-drafts/{id}',
  successStatuses: [200],
  reader: draftReader,
  fieldPolicies: [creationExecutions.policy],
})
