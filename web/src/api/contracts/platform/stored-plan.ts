import { ApplicationDraftCreationApprovalSnapshot, ApplicationDraftCreationPlan } from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import type { CreationApproval, CreationPlan } from '../../../model/contracts/build'
import { registerDelegates } from '../../boundary/issues'

/** A stored disabled publish means omission, exactly as in Platform's plan prompt. Requests remain strict. */
function storedPlan<P extends { applicationStackRequest?: object }>(canonical: z.ZodType<P>) {
  const disabled = z.object({ applicationStackRequest: z.object({ publish: z.object({ enabled: z.literal(false) }) }) })
  const reader = z.unknown().transform((wire, ctx) => {
    const unpublished = disabled.safeParse(wire).success
    let input = wire
    if (unpublished && typeof wire === 'object' && wire !== null && 'applicationStackRequest' in wire) {
      const stack = wire.applicationStackRequest as Record<string, unknown>
      const { publish: _publish, ...rest } = stack
      input = { ...wire, applicationStackRequest: rest }
    }
    const parsed = canonical.safeParse(input)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue as never)
      return z.NEVER
    }
    return parsed.data
  })
  registerDelegates(reader, [canonical])
  return reader
}

export const creationPlanReader: z.ZodType<CreationPlan> = storedPlan(ApplicationDraftCreationPlan)
export const creationApprovalReader: z.ZodType<CreationApproval> = storedPlan(ApplicationDraftCreationApprovalSnapshot)
