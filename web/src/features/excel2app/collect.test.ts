import { expect, test } from 'bun:test'
import { ApplicationDraftWorkbookLimits } from '@appthrust/api-schema/platform-api'
import { filesFromDrop, filesFromList, isIgnoredWorkbookPath, isWorkbookFile, workbookBudget } from './collect'

test('workbook extensions are case-insensitive; owner and hidden paths are ignored', () => {
  for (const name of ['ledger.xlsx', 'ledger.XLSM']) expect(isWorkbookFile(name)).toBe(true)
  for (const name of ['ledger.xls', 'notes.txt', '~$ledger.xlsx', '.ledger.xlsx', 'folder/.hidden/ledger.xlsx']) expect(isWorkbookFile(name)).toBe(false)
  expect(isIgnoredWorkbookPath('folder/~$ledger.xlsx')).toBe(true)
  const files = ['a.xlsx', '~$a.xlsx', '.a.xlsx', 'notes.txt'].map((name) => new File([], name))
  expect(filesFromList(files).map((file) => file.name)).toEqual(['a.xlsx', 'notes.txt'])
  expect(filesFromList(null)).toEqual([])
})

function fileEntry(name: string): FileSystemEntry {
  return { name, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(new File([], name)) } as unknown as FileSystemEntry
}

function directory(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
  return { name, isFile: false, isDirectory: true, createReader: () => {
    let index = 0
    return { readEntries: (resolve: (entries: FileSystemEntry[]) => void) => resolve(batches[index++] ?? []) }
  } } as unknown as FileSystemEntry
}

test('folder traversal exhausts every directory batch and preserves order while skipping hidden folders', async () => {
  const root = directory('ledgers', [
    [fileEntry('April.xlsx'), directory('.private', [[fileEntry('secret.xlsx')]])],
    [directory('May', [[fileEntry('May.xlsm'), fileEntry('~$May.xlsm')]])],
  ])
  const transfer = { items: [{ kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null }], files: [] } as unknown as DataTransfer
  expect((await filesFromDrop(transfer)).map((file) => file.name)).toEqual(['April.xlsx', 'May.xlsm'])
})

test('browsers without entry support use the complete file list', async () => {
  const files = [new File([], 'April.xlsx'), new File([], 'May.xlsx')]
  const transfer = { items: files.map((file) => ({ kind: 'file', getAsFile: () => file })), files } as unknown as DataTransfer
  expect(await filesFromDrop(transfer)).toEqual(files)
})

test('mixed entry and file drops do not lose files without an entry', async () => {
  const loose = new File([], 'master.xlsx')
  const transfer = { items: [
    { kind: 'file', webkitGetAsEntry: () => directory('ledgers', [[fileEntry('April.xlsx')]]), getAsFile: () => null },
    { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => loose },
  ], files: [loose] } as unknown as DataTransfer
  expect((await filesFromDrop(transfer)).map((file) => file.name)).toEqual(['April.xlsx', 'master.xlsx'])
})

test('the budget counts persisted grid bytes and sheets using shared API limits', () => {
  const summary = { id: 'wb-000000000001', fileName: 'a.xlsx', sheetCount: 3, rowCount: 20, truncated: false, bytes: 1024, digest: 'a'.repeat(64), addedAt: '2026-11-01T00:00:00Z' }
  expect(workbookBudget([summary, { ...summary, id: 'wb-000000000002', bytes: 2048, sheetCount: 2 }])).toEqual({
    files: 2, bytes: 3072, sheets: 5,
    maxFiles: ApplicationDraftWorkbookLimits.maxWorkbooks,
    maxBytes: ApplicationDraftWorkbookLimits.maxSetBytes,
    maxSheets: ApplicationDraftWorkbookLimits.maxSetSheets,
    maxWorkbookBytes: ApplicationDraftWorkbookLimits.maxWorkbookBytes,
  })
  expect(workbookBudget([]).bytes).toBe(0)
})
