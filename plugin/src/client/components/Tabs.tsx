/**
 * Tabs — design spec §4.6.
 *
 * Tabs are for switching a deeper region (the collection detail's 文档 / 索引配置 /
 * 构建日志 panes); same-view switches use {@link SegmentedControl} instead. The
 * spec draws that line by appearance, so the two components keep separate
 * selected treatments rather than sharing a configurable one.
 *
 * Arrow-key navigation between tabs is implemented here because `role="tablist"`
 * promises it to assistive technology: a tablist whose tabs are only reachable
 * with Tab would announce a widget it does not behave like.
 */

import { useRef } from 'react'
import styles from './Tabs.module.css'

/** One tab. */
export interface TabItem<T extends string> {
  /** Value reported on selection. */
  value: T
  /** Visible text. */
  label: string
  /** Optional count shown as a badge, e.g. the document total. */
  count?: number
}

/** Options accepted by {@link Tabs}. */
export interface TabsProps<T extends string> {
  /** Accessible name of the tab list. */
  label: string
  /** Currently selected value. */
  value: T
  /** Called with the next selected value. */
  onChange: (value: T) => void
  /** Tabs in display order. */
  items: readonly TabItem<T>[]
  /** Busy state: blocks switching. */
  loading?: boolean
  /** Disables every tab. */
  disabled?: boolean
}

/**
 * Render a tab list.
 * @param props - list label, selection, items and flags.
 * @returns the tab list element.
 */
export function Tabs<T extends string>({
  label, value, onChange, items, loading = false, disabled = false,
}: TabsProps<T>): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const inert = disabled || loading

  /**
   * Move selection with the arrow keys, wrapping at both ends as the tablist
   * pattern requires.
   * @param delta - +1 for the next tab, -1 for the previous one.
   */
  const step = (delta: number): void => {
    const index = items.findIndex(item => item.value === value)
    if (index === -1) return
    const next = items[(index + delta + items.length) % items.length]
    if (next === undefined) return
    onChange(next.value)
    const buttons = listRef.current?.querySelectorAll('button')
    buttons?.[items.indexOf(next)]?.focus()
  }

  return (
    <div
      className={`${styles.list} ${loading ? styles.loading : ''}`.trim()}
      role="tablist"
      aria-label={label}
      ref={listRef}
      onKeyDown={event => {
        if (event.key === 'ArrowRight') { event.preventDefault(); step(1) }
        if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1) }
      }}
    >
      {items.map(item => (
        <button
          key={item.value}
          type="button"
          role="tab"
          className={`${styles.tab} ${item.value === value ? styles.selected : ''}`.trim()}
          aria-selected={item.value === value}
          aria-busy={loading || undefined}
          tabIndex={item.value === value ? 0 : -1}
          disabled={inert}
          onClick={() => { onChange(item.value) }}
        >
          {item.label}
          {item.count !== undefined && <span className={styles.count}>{item.count > 99 ? '99+' : item.count}</span>}
        </button>
      ))}
    </div>
  )
}
