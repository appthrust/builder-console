// The wizard's one TanStack Form: values for every step, the zod schema of
// each step's fields, and the derived values the steps and submit share.
import { useForm, type ReactFormExtendedApi } from '@tanstack/react-form'
import { useState } from 'react'
import { z } from 'zod'
import type { ShareScope } from '../../api/console-unverified'
import { copy } from '../../copy'
import {
  appNameProblem,
  isValidImageReference,
  suggestUrlName,
  urlNameFromRepository,
  type CreateEntry,
  type PickedRepository,
} from '../../model/create'
import { businessTemplateById } from './templates'

export const INTENT_MAX = 8000

export interface CreateValues {
  /** Step 0 choice; the image entry is chosen from 詳しい人向け. */
  entry: Exclude<CreateEntry, 'ai'> | undefined
  imageRef: string
  /** 作ったコードから: the picked repository. */
  repository: PickedRepository | undefined
  /** Build-session entry: 「やりたいこと」 on Step 0 only. */
  intent: string
  /** Business template or the framework selected for an empty app. */
  templateId: string | undefined
  displayName: string
  description: string
  tags: string[]
  groupId: string
  /** "URL になる名前"; follows the suggestion until the user edits it (「変える」). */
  urlName: string
  urlNameEdited: boolean
  scope: ShareScope
  /** null = untouched: the owner group. */
  shareGroupIds: string[] | null
}

export function initialValues(groupId: string): CreateValues {
  return {
    entry: undefined,
    imageRef: '',
    repository: undefined,
    intent: '',
    templateId: undefined,
    displayName: '',
    description: '',
    tags: [],
    groupId,
    urlName: suggestUrlName(''),
    urlNameEdited: false,
    scope: 'group',
    shareGroupIds: null,
  }
}

/** Step 0: the 詳しい人向け image reference. */
export const startSchema = z.object({
  imageRef: z.string().trim().superRefine((value, context) => {
    if (!value) context.addIssue({ code: 'custom', message: copy.create.advanced.imageRequired })
    else if (!isValidImageReference(value)) context.addIssue({ code: 'custom', message: copy.create.advanced.imageInvalid })
  }),
})

/** Step 1: name, URL name and owner group; plus the entry's own first question. */
export const detailsSchema = z.object({
  displayName: z.string().trim().min(1, { error: () => copy.create.details.nameRequired }),
  urlName: z.string().superRefine((value, context) => {
    const problem = appNameProblem(value)
    const messages = {
      empty: copy.create.details.urlNameEmpty,
      tooLong: copy.create.details.urlNameTooLong,
      invalid: copy.create.details.urlNameInvalid,
      reserved: copy.create.details.urlNameReserved,
    }
    if (problem) context.addIssue({ code: 'custom', message: messages[problem] })
  }),
  groupId: z.string().min(1, { error: () => copy.create.details.groupNone }),
  repository: z.custom<PickedRepository | undefined>((value) => value !== undefined, { error: () => copy.create.existing.required }),
})

/** Step 2: a group share needs at least one group (null = the owner group). */
export const shareSchema = z.object({
  shareGroupIds: z.array(z.string()).min(1, { error: () => copy.create.share.groupRequired }).nullable(),
})

/** Fields checked before leaving each step (the entry adds its own on Step 1). */
export function stepFields(step: number, entry: CreateValues['entry']): Array<keyof CreateValues> {
  if (step === 1) {
    return [
      ...(entry === 'existing' ? (['repository'] as const) : []),
      'displayName',
      'groupId',
      'urlName',
    ]
  }
  if (step === 2) return ['shareGroupIds']
  return []
}

/** The null-means-owner-group rule of `shareGroupIds`. */
export function effectiveShareGroupIds(values: Pick<CreateValues, 'shareGroupIds' | 'groupId'>): string[] {
  return values.shareGroupIds ?? (values.groupId ? [values.groupId] : [])
}

/** First message of a field's errors (zod issues, strings, or nested arrays). */
export function firstError(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    if (typeof error === 'string' && error) return error
    if (Array.isArray(error)) {
      const nested = firstError(error)
      if (nested) return nested
    } else if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
  }
  return undefined
}

/** The wizard form: no form-level validators; each field carries its step schema's slice. */
export type CreateFormApi = ReactFormExtendedApi<
  CreateValues,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  never
>

export function useCreateForm(groupId: string, restored?: CreateValues): CreateFormApi {
  // Fixed for the page's lifetime: changed defaults would reset the answers
  // (and the suggested URL name is random for names without letters).
  const [defaultValues] = useState(() => restored ?? initialValues(groupId))
  return useForm({ defaultValues })
}

/**
 * Keeps "URL になる名前" on the suggestion until the user takes it over with
 * 「変える」: from the picked repository (作ったコードから), else from the name;
 * a kanji-only name on a business template takes the template's English word.
 */
export function syncUrlName(form: CreateFormApi): void {
  const values = form.state.values
  if (values.urlNameEdited) return
  const next = suggestedUrlName(values)
  if (next !== values.urlName) form.setFieldValue('urlName', next)
}

export function suggestedUrlName(values: Pick<CreateValues, 'entry' | 'repository' | 'templateId' | 'displayName'>): string {
  if (values.entry === 'existing' && values.repository) return urlNameFromRepository(values.repository.fullName)
  const urlWord = values.entry === 'template' ? businessTemplateById(values.templateId)?.urlWord : undefined
  return urlWord ? suggestUrlName(values.displayName, () => urlWord) : suggestUrlName(values.displayName)
}
