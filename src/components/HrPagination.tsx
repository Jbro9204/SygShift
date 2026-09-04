import { ChevronLeft, ChevronRight } from 'lucide-react'

export type HrPageSize = 5 | 10 | 20

export function HrPagination({
  itemCount,
  label = 'HR records',
  offset,
  onOffsetChange,
  onPageSizeChange,
  pageSize,
}: {
  itemCount: number
  label?: string
  offset: number
  onOffsetChange: (value: number) => void
  onPageSizeChange: (value: HrPageSize) => void
  pageSize: HrPageSize
}) {
  if (itemCount === 0 && offset === 0) return null

  const start = itemCount > 0 ? offset + 1 : 0
  const end = offset + itemCount

  return (
    <nav aria-label={`${label} pages`} className="hr-pagination">
      <div aria-live="polite" className="hr-pagination__summary">
        <span>{itemCount > 0 ? 'Showing' : 'No records on this page'}</span>
        {itemCount > 0 ? <strong>{start}–{end}</strong> : null}
      </div>
      <div className="hr-pagination__controls">
        <label>
          <span>Rows per page</span>
          <select
            aria-label={`${label} rows per page`}
            onChange={(event) => {
              onPageSizeChange(Number(event.target.value) as HrPageSize)
              onOffsetChange(0)
            }}
            value={pageSize}
          >
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="20">20</option>
          </select>
        </label>
        <button className="secondary-button" disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - pageSize))} type="button"><ChevronLeft aria-hidden="true" size={17} />Previous</button>
        <button className="secondary-button" disabled={itemCount < pageSize} onClick={() => onOffsetChange(offset + pageSize)} type="button">Next<ChevronRight aria-hidden="true" size={17} /></button>
      </div>
    </nav>
  )
}
