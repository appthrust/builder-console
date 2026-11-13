// App data domain values that arrive through the response boundary
// (api/contracts/platform/data.ts): the app database's tables, their column
// metadata, rows pages, written rows and database changes. Feature and model
// code reads these types, never the wire.
//
// Each type keeps only the fields the console reads (the reader drops the
// rest). Server enums a newer Platform may extend are open values: an unknown
// value is `{ kind: 'unknown' }`, never mapped onto a known one, and never
// reads as applied, approvable, retryable or editable.
import type { OpenValue } from '../../api/boundary'

/** Relation kinds the Platform describes (platform-api internal/k8s/database_table_schema.go:148). */
export type RelationType = 'table' | 'view'
export type DatabaseChangePhase = 'Pending' | 'Blocked' | 'ReviewFailed' | 'AwaitingApproval' | 'Rejected' | 'ReadyToRun' | 'Running' | 'Succeeded' | 'Failed'
export type DatabaseChangeRisk = 'Low' | 'Medium' | 'High'
export type DatabaseChangeRunPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed'

/** One entry of the table list (`schema`.`name`); its description is a separate read. */
export interface DatabaseTableRef {
  schema: string
  name: string
}

export interface DatabaseColumn {
  name: string
  /** PostgreSQL type name as the database reports it; an open vocabulary model/data-catalog.ts interprets. */
  type: string
  nullable: boolean
  hasDefault: boolean
  primaryKey: boolean
  description?: string
  /** Labels of an enum column; `[]` for every other column. */
  enumValues: string[]
  references?: { schema: string; table: string; column: string }
}

/** A table or view as the Platform describes it. */
export interface DatabaseTable {
  schema: string
  name: string
  type: OpenValue<RelationType>
  description?: string
  primaryKey: string[]
  columns: DatabaseColumn[]
  /** The server allows row writes (a table with exactly one key column). */
  editable: boolean
  rowCountEstimate?: number
}

/** One row as the database returned it: column name → stored JSON value. */
export type RowValues = Readonly<Record<string, unknown>>

/**
 * The row a write answered, read back under the key the console addresses it
 * by (the 表's single key column, as the `{key}` path segment). A write whose
 * answer carries no such row, or another row, is unconfirmed, never this.
 */
export interface WrittenRow {
  key: string
  values: RowValues
}

/** One page of a table's rows. */
export interface DatabaseRowsPage {
  rows: RowValues[]
  /** More rows follow this page. */
  truncated: boolean
  /** Planner estimate of the matching rows; absent when the database gave none. */
  totalEstimate?: number
}

export interface DatabaseChangeRun {
  phase?: OpenValue<DatabaseChangeRunPhase>
  message?: string
  retryable?: boolean
}

/** A database change (migration) as the overview's 「データベースの変更」 reads it. */
export interface DatabaseChange {
  id: string
  /** The migration file the change came from. */
  path?: string
  phase?: OpenValue<DatabaseChangePhase>
  risk?: OpenValue<DatabaseChangeRisk>
  /** Review finding messages; `[]` when the review found nothing (or there was none). */
  findings: string[]
  latestRun?: DatabaseChangeRun
  archived: boolean
  createdAt?: string
}

/** The change an approval or retry was recorded for. */
export interface DatabaseChangeAccepted {
  id: string
  phase?: OpenValue<DatabaseChangePhase>
}
