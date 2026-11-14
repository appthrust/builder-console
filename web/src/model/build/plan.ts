import type { CreationPlan } from '../contracts/build'

/** AI plans use the same default public destination as the create wizard. */
export function withDefaultPublish(plan: CreationPlan, { domain, appName }: { domain?: string; appName?: string }): CreationPlan {
  const stack = plan.applicationStackRequest
  const name = appName ?? (stack?.application?.name || stack?.applicationName)
  if (!stack || stack.publish?.enabled || !domain || !name) return plan
  return {
    ...plan,
    applicationStackRequest: {
      ...stack,
      publish: { enabled: true, customDomain: domain, hostnamePattern: 'wildcard', subdomain: name },
    },
  }
}

/** The plan's request for a new repository (not an adoption), when it has one. */
export function newRepositoryRequest(plan: CreationPlan | undefined) {
  const repository = plan?.applicationSourceRepositoryRequest
  return repository?.destination && !repository.existing ? repository : undefined
}

/**
 * The plan with its new-repository request bound to `revision`: the
 * destination the user is shown and approves. Platform rejects an approval
 * without one, and a create whose revision is no longer current.
 */
export function withDestinationRevision(plan: CreationPlan, revision: string): CreationPlan {
  const repository = newRepositoryRequest(plan)
  if (!repository || repository.destinationRevision === revision) return plan
  return { ...plan, applicationSourceRepositoryRequest: { ...repository, destinationRevision: revision } }
}

/**
 * Rename only newly created destinations; adopted sources and tool payload references stay intact.
 * A new repository's image path is Platform's (destination registry namespace + repository name):
 * an `imagePath` the plan still asserts names the old repository, so it is dropped, never rewritten.
 * The destination revision stays: the destination itself does not change with the name.
 */
export function renameCreationPlan(plan: CreationPlan, name: string, { domain }: { domain?: string } = {}): CreationPlan {
  const stack = plan.applicationStackRequest
  const created = newRepositoryRequest(plan)
  let renamedRepository = plan.applicationSourceRepositoryRequest
  if (created) {
    const image = created.image ? { ...created.image } : undefined
    if (image) delete image.imagePath
    renamedRepository = { ...created, destination: { ...created.destination!, repositoryName: name }, ...(image ? { image } : {}) }
  }
  const source = stack?.source.kind === 'github-template' ? {
    ...stack.source,
    githubTemplate: { ...stack.source.githubTemplate, newRepositoryName: name },
    imageRef: stack.source.imageRef.replace(/[^/:@]+(?=[:@][^/]*$|$)/, name),
  } : stack?.source
  return withDefaultPublish({
    ...plan,
    ...(renamedRepository ? { applicationSourceRepositoryRequest: renamedRepository } : {}),
    ...(stack && source ? { applicationStackRequest: {
      ...stack, source,
      application: {
        ...stack.application, name,
        // Runtime validation derives an ID from the name; do not keep that old identity on retry.
        ...(stack.application?.id && stack.application.id === stack.application.name ? { id: name } : {}),
      },
      ...(stack.applicationName !== undefined ? { applicationName: name } : {}),
      ...(stack.publish?.subdomain ? { publish: { ...stack.publish, subdomain: name } } : {}),
    } } : {}),
  }, { domain, appName: name })
}
