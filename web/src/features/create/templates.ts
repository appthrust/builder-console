import type { ApplicationTemplateSummary } from '@appthrust/api-schema/platform-api'
import { CalendarDays, ClipboardCheck, Package, TableProperties, type LucideIcon } from 'lucide-react'
import { text } from './copy'

export interface BusinessTemplate {
  id: string
  name: string
  /** "URL になる名前" when the app's name has no readable letters (kanji only). */
  urlWord: string
  icon: LucideIcon
  lead: string
  includes: readonly [string, string, string]
  seed: string
}

export const businessTemplates: readonly BusinessTemplate[] = [
  businessTemplate('biz-inventory-postgres', 'inventory', Package),
  businessTemplate('biz-master-postgres', 'master', TableProperties),
  businessTemplate('biz-approval-postgres', 'approval', ClipboardCheck),
  businessTemplate('biz-reservation-postgres', 'reservation', CalendarDays),
]

/** Keep metadata stable while every text read follows the current language. */
function businessTemplate(id: keyof typeof text.templates, urlWord: string, icon: LucideIcon): BusinessTemplate {
  return {
    id,
    urlWord,
    icon,
    get name() { return text.templates[id].name },
    get lead() { return text.templates[id].lead },
    get includes() { return text.templates[id].includes },
    get seed() { return text.templates[id].seed },
  }
}

export function businessTemplateById(id: string | undefined): BusinessTemplate | undefined {
  return businessTemplates.find((template) => template.id === id)
}

/** The platform catalog is authoritative: absent cards disappear, unavailable ones explain why. */
export function joinBusinessTemplates(catalog: readonly ApplicationTemplateSummary[]) {
  return businessTemplates.flatMap((metadata) => {
    const template = catalog.find((item) => item.id === metadata.id && item.category === 'business')
    return template ? [{ ...metadata, availability: template.availability, sourceKinds: template.sourceKinds, githubTemplate: template.githubTemplate }] : []
  })
}
