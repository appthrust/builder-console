// The 表 list: one Select at the start of the toolbar above the grid, at every width,
// so the grid keeps the full page width for wide 表.
import type { Collection } from '../../../model/data-catalog'
import { Select } from '../../../ui'
import { dataText } from './copy'

export function CollectionNav({
  collections,
  current,
  currentEstimate,
  onSelect,
}: {
  /** Visible collections only. */
  collections: readonly Collection[]
  current: string
  /** The selected 表's latest estimate (from its rows), over the catalog's. */
  currentEstimate: number | undefined
  onSelect: (collectionId: string) => void
}) {
  return (
    <Select
      aria-label={dataText.navLabel}
      value={current}
      onChange={onSelect}
      className="sm:w-72"
      options={collections.map((collection) => {
        const estimate = collection.id === current ? currentEstimate : collection.rowCountEstimate
        return {
          value: collection.id,
          label: estimate !== undefined ? dataText.collectionLabel(collection.label, dataText.rowEstimate(estimate)) : collection.label,
        }
      })}
    />
  )
}
