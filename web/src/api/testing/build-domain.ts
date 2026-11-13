// Test seam: build/improve domain values made from wire fixtures by the
// production readers, never by casting a literal to a domain type. A fixture
// the reader rejects fails the test that uses it.
import type { z } from 'zod'
import type { BuildDraft, BuildExecution, BuildGeneration, BuildTurn, ImplementationRun, ImplementationTask, PreviewWorkspace } from '../../model/contracts/build'
import { decodeResponse } from '../boundary'
import { executionReader, generationReader, getApplicationDraftContract, runReader, taskReader, turnReader } from '../contracts/platform/build'
import { getDevWorkspaceContract } from '../contracts/platform/workspace'

function read<D>(reader: z.ZodType<D>, wire: unknown, what: string): D {
  const result = reader.safeParse(wire)
  if (!result.success) throw new Error(`${what} fixture does not match its reader: ${result.error.issues.map((issue) => `${issue.code} /${issue.path.join('/')}`).join(', ')}`)
  return result.data
}

export function draftOf(wire: unknown): BuildDraft {
  const result = decodeResponse(getApplicationDraftContract, wire)
  if (!result.ok) throw new Error(`draft fixture does not match its contract: ${result.error.issues.map((issue) => `${issue.code} ${issue.path}`).join(', ')}`)
  return result.value
}

export const turnOf = (wire: unknown): BuildTurn => read(turnReader, wire, 'turn')
export const generationOf = (wire: unknown): BuildGeneration => read(generationReader, wire, 'generation')
export const executionOf = (wire: unknown): BuildExecution => read(executionReader, wire, 'execution')
export const runOf = (wire: unknown): ImplementationRun => read(runReader, wire, 'run')
export const taskOf = (wire: unknown): ImplementationTask => read(taskReader, wire, 'task')

export function workspaceOf(wire: unknown): PreviewWorkspace {
  const result = decodeResponse(getDevWorkspaceContract, wire)
  if (!result.ok) throw new Error(`workspace fixture does not match its contract: ${result.error.issues.map((issue) => `${issue.code} ${issue.path}`).join(', ')}`)
  return result.value
}

/**
 * `fn` taking a wire fixture as its first argument, read by `of` (undefined
 * passes through): tests keep writing wire literals, the function under test
 * only ever sees what the production reader made of them.
 */
export function readFirst<D, A extends unknown[], R>(of: (wire: unknown) => D, fn: (value: D, ...rest: A) => R): (wire: unknown, ...rest: A) => R {
  return (wire, ...rest) => fn((wire === undefined ? undefined : of(wire)) as D, ...rest)
}

/** Like `readFirst` for a first argument that is a list of wire fixtures. */
export function readEachFirst<D, A extends unknown[], R>(of: (wire: unknown) => D, fn: (values: D[], ...rest: A) => R): (wires: readonly unknown[] | undefined, ...rest: A) => R {
  return (wires, ...rest) => fn((wires === undefined ? undefined : wires.map(of)) as D[], ...rest)
}
