/**
 * App shell: sidebar, topbar, and the navigation that selects a page.
 *
 * The design spec's shell is a two-column frame with a fixed 240px sidebar and a
 * 56px topbar, and the rule that shapes every decision here is §6.1's "主区是页面
 * 唯一视觉重心，外壳不参与信息竞争": the shell must never out-shout the page it
 * frames. Concretely that means no brand fills, no large icons, and no accent
 * colour on anything that is not the current selection.
 *
 * Navigation is internal state rather than a router. The plugin ships a handful
 * of views and the host owns the URL; adding a router here would mean two things
 * deciding what is on screen, and the spec gives no URL contract to honour.
 *
 * The shell is theme-agnostic: it reads only `--kb-*` tokens, so §6.1's dark
 * rules (sidebar and topbar lift one surface step, main area keeps the app
 * background) come from the token layer rather than from a branch in this file.
 *
 * @module dsh-zvec-knowledge/client/shell
 */

import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon.tsx'
import { SearchField } from '../components/SearchField.tsx'
import { StorageUsageCard, type StorageUsage } from '../components/StorageUsageCard.tsx'
import styles from './AppShell.module.css'

/**
 * The primary navigation destinations, in spec order.
 *
 * RAG 问答 is omitted per KB-09's revised scope: RAG lives in the dsh conversation,
 * so a nav entry pointing at a second Q&A surface would be a destination with
 * nothing behind it. 检索测试 is present — it validates chunking and recall, which
 * is a different job from answering.
 */
export const NAV_ITEMS = [
  { id: 'overview', label: '知识库总览', icon: 'collection' },
  { id: 'documents', label: '文档接入', icon: 'file' },
  { id: 'build', label: '索引构建', icon: 'layers' },
  { id: 'retrieval', label: '检索验证', icon: 'search' },
  { id: 'settings', label: '设置', icon: 'settings' },
] as const

/** One navigation destination identifier. */
export type NavId = typeof NAV_ITEMS[number]['id']

/** Options accepted by {@link AppShell}. */
export interface AppShellProps {
  /** Storage figures for the usage card; `null` while they are still loading. */
  usage: StorageUsage | null
  /** Page title shown in the topbar. */
  title: string
  /** The page body. */
  children: ReactNode
  /** Currently selected destination. */
  active: NavId
  /** Called when the user picks another destination. */
  onNavigate: (id: NavId) => void
  /** Global search query, controlled by the owner. */
  query: string
  /** Called as the search query changes. */
  onQueryChange: (value: string) => void
}

/**
 * Render the application frame.
 *
 * `aria-current="page"` is what makes "exactly one item is selected" legible to
 * assistive technology as well as to the eye; the visual treatment is a token
 * pair (tint + border in dark, tint fill in light) so the two themes differ by
 * tokens alone.
 * @param props - navigation state, storage figures, and the page body.
 * @returns the frame.
 */
export function AppShell({
  usage, title, children, active, onNavigate, query, onQueryChange,
}: AppShellProps): React.JSX.Element {
  const [navOpen, setNavOpen] = useState(false)

  return (
    <div className={`kb-root ${styles.shell}`}>
      <aside className={styles.sidebar} aria-label="主导航">
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            <Icon name="database" size={18} />
          </span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>知识库</span>
            <span className={`kb-mono ${styles.brandTech}`}>zvec · local</span>
          </span>
        </div>

        <nav className={styles.nav}>
          <ul className={styles.navList}>
            {NAV_ITEMS.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.navItem}
                  aria-current={active === item.id ? 'page' : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <Icon name={item.icon as IconName} size={16} />
                  <span className={styles.navLabel}>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.sidebarFooter}>
          <StorageUsageCard usage={usage} />
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={styles.navToggle}
            aria-expanded={navOpen}
            aria-label={navOpen ? '收起导航' : '展开导航'}
            onClick={() => setNavOpen(open => !open)}
          >
            <Icon name="menu" size={16} />
          </button>
          <h1 className={styles.pageTitle}>{title}</h1>
          <div className={styles.topbarSearch}>
            <SearchField
              value={query}
              onValueChange={onQueryChange}
              label="全局搜索"
              placeholder="搜索知识库或文档"
            />
          </div>
          <span className={styles.avatar} aria-label="当前用户" role="img">KB</span>
        </header>

        <main className={styles.content}>{children}</main>
      </div>
    </div>
  )
}
