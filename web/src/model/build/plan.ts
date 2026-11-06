import type { ApplicationDraftCreationPlan } from '@appthrust/api-schema/platform-api'

/** AI plans use the same default public destination as the create wizard. */
export function withDefaultPublish(plan: ApplicationDraftCreationPlan, { domain, appName }: { domain?: string; appName?: string }): ApplicationDraftCreationPlan {
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

/** Rename only newly created destinations; adopted sources and tool payload references stay intact. */
export function renameCreationPlan(plan: ApplicationDraftCreationPlan, name: string, { domain }: { domain?: string } = {}): ApplicationDraftCreationPlan {
  const repository = plan.applicationSourceRepositoryRequest
  const stack = plan.applicationStackRequest
  const renamedRepository = repository?.destination ? {
    ...repository,
    destination: { ...repository.destination, repositoryName: name },
    ...(repository.image?.imagePath ? { image: { ...repository.image, imagePath: repository.image.imagePath.replace(/[^/]+$/, name) } } : {}),
  } : repository
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
