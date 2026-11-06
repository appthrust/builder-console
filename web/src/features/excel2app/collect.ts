import { ApplicationDraftWorkbookLimits, type ApplicationDraftWorkbookSummary } from '@appthrust/api-schema/platform-api'

export type WorkbookFileState = 'reading' | 'storing' | 'stored' | 'unsupported' | 'unreadable' | 'tooLarge' | 'duplicate' | 'setFull' | 'setTooLarge' | 'invalid' | 'failed'

export interface CollectedWorkbook {
  /** Stable across a failed POST and its retry. */
  key: string
  fileName: string
  state: WorkbookFileState
  workbookId?: string
  location?: { sheet?: string; row?: number }
  problem?: 'busy' | 'created'
}

/** Hidden directories, hidden files and Excel owner files never enter the queue. */
export function isIgnoredWorkbookPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part.startsWith('.') || part.startsWith('~$'))
}

export function isWorkbookFile(name: string): boolean {
  return !isIgnoredWorkbookPath(name) && /\.(xlsx|xlsm)$/i.test(name)
}

/** Keep visible unsupported files so the user sees why each was not stored. */
export function filesFromList(files: FileList | readonly File[] | null): File[] {
  return Array.from(files ?? []).filter((file) => !isIgnoredWorkbookPath(file.webkitRelativePath || file.name))
}

async function entryFiles(entry: FileSystemEntry): Promise<File[]> {
  if (isIgnoredWorkbookPath(entry.name)) return []
  if (entry.isFile) {
    const { promise, resolve, reject } = Promise.withResolvers<File>()
    ;(entry as FileSystemFileEntry).file(resolve, reject)
    return [await promise]
  }
  if (!entry.isDirectory) return []
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const files: File[] = []
  // Chromium returns directory entries in batches; keep reading until the empty batch.
  for (;;) {
    const { promise, resolve, reject } = Promise.withResolvers<FileSystemEntry[]>()
    reader.readEntries(resolve, reject)
    const entries = await promise
    if (entries.length === 0) return files
    for (const child of entries) files.push(...await entryFiles(child))
  }
}

export async function filesFromDrop(transfer: DataTransfer): Promise<File[]> {
  // Capture entries synchronously: DataTransfer is protected after the drop callback returns.
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file')
  const entries = items.map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }))
  if (!entries.some(({ entry }) => entry)) return filesFromList(transfer.files)
  const files: File[] = []
  for (const { entry, file } of entries) {
    if (entry) files.push(...await entryFiles(entry))
    else if (file) files.push(...filesFromList([file]))
  }
  return files
}

export function workbookBudget(workbooks: readonly ApplicationDraftWorkbookSummary[]) {
  return {
    files: workbooks.length,
    bytes: workbooks.reduce((sum, workbook) => sum + workbook.bytes, 0),
    sheets: workbooks.reduce((sum, workbook) => sum + workbook.sheetCount, 0),
    maxFiles: ApplicationDraftWorkbookLimits.maxWorkbooks,
    maxBytes: ApplicationDraftWorkbookLimits.maxSetBytes,
    maxSheets: ApplicationDraftWorkbookLimits.maxSetSheets,
    maxWorkbookBytes: ApplicationDraftWorkbookLimits.maxWorkbookBytes,
  }
}
