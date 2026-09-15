/**
 * The composer's knowledge-base control.
 *
 * ## Why it does not drive the `@` menu
 *
 * The first implementation opened the input-trigger pipeline's menu through
 * `inputTriggers.sessionOf(...).toggleSource(...)`. That was wrong in a way the
 * types could not catch: `sessionOf` takes a **session-scoped** context, and the
 * `conversation.input.right` slot hands its entry an empty owner share —
 * `renderSlot("conversation.input.right", {})`, verified in the shipped
 * conversation bundle. Resolving a controller therefore needed a session id the
 * slot does not provide, the failure was swallowed by a `catch`, and the button
 * rendered as a control that silently did nothing.
 *
 * The session slot *does* provide the supported path: `SessionStandardProps`
 * carries `useInput` (the input machine's state, including the live draft) and
 * `inputActions`, documented as "Stable public input actions for this Session".
 * `inputActions.setDraft` is the sanctioned way for a composer control to write
 * the draft, so this component uses that and owns its own small picker.
 *
 * The `@` completion path is unaffected and still comes from the trigger source;
 * this button exists for the case where the user knows which base they mean and
 * would rather click than type.
 *
 * @module dsh-zvec-knowledge/client/composer/KbButton
 */

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon.tsx'
import type { KbCandidate } from '../kb-trigger.tsx'
import styles from './KbButton.module.css'

/** Options accepted by {@link KbButton}. */
export interface KbButtonProps {
  /** Whether the composer currently refuses interaction. */
  locked: boolean
  /** The live draft, read through the slot's `useInput` selector. */
  draft: string
  /** Writes the whole draft, through the slot's `inputActions`. */
  setDraft: (text: string) => void
  /** Loads the selectable collections. */
  loadCandidates: () => Promise<KbCandidate[]>
}

/**
 * The reference text this button inserts.
 *
 * A plain `@`-prefixed name rather than a serialized instruction: the mention
 * reads naturally in the draft and survives editing, and the model learns what
 * the marker means from the tool description. Serializing here instead would put
 * a sentence of our own inside the user's message, which is not what they typed.
 * @param name - the collection's display name.
 * @returns the token to insert.
 */
export function kbReferenceToken(name: string): string {
  return `@${name} `
}

/**
 * Render the knowledge-base control.
 * @param props - lock state, draft access and candidate loading.
 * @returns the button and its picker.
 */
export function KbButton({
  locked, draft, setDraft, loadCandidates,
}: KbButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<KbCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  // Load on open rather than on mount: collections change while a session is up,
  // and a list fetched at mount would offer a base that has since been deleted.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void loadCandidates().then(
      next => { if (!cancelled) { setCandidates(next); setLoading(false) } },
      () => { if (!cancelled) { setCandidates([]); setLoading(false) } },
    )
    return () => { cancelled = true }
  }, [open, loadCandidates])

  // Close on an outside press or Escape, the behaviour every composer popup has.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /**
   * Insert one collection's mark at the end of the draft.
   *
   * Read-modify-write on the live draft rather than an append API, because
   * `setDraft` replaces the whole value: anything the user already typed must be
   * preserved, and a separator keeps the mark tokenised.
   */
  const pick = (candidate: KbCandidate): void => {
    const separator = draft === '' || draft.endsWith(' ') ? '' : ' '
    setDraft(`${draft}${separator}${kbReferenceToken(candidate.name)}`)
    setOpen(false)
  }

  /** Toggle the picker: one candidate is unambiguous and needs no menu. */
  const openPicker = (): void => {
    if (locked) return
    void (async () => {
      const list = await loadCandidates()
      if (list.length === 1 && list[0] !== undefined) {
        // The common single-collection deployment never sees a menu.
        pick(list[0])
        return
      }
      setCandidates(list)
      setOpen(true)
    })()
  }

  return (
    <span className={styles.wrap} ref={rootRef}>
      <button
        type="button"
        className={styles.button}
        disabled={locked}
        aria-label="插入知识库引用"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="插入知识库引用（也可以直接输入 @ 检索）"
        onClick={() => { open ? setOpen(false) : openPicker() }}
      >
        <Icon name="database" size={16} />
        <span className={styles.label}>知识库</span>
      </button>

      {open && (
        <div className={styles.menu} role="listbox" aria-label="选择知识库">
          {loading ? (
            <p className={styles.menuNote}>正在加载…</p>
          ) : candidates.length === 0 ? (
            <p className={styles.menuNote}>还没有知识库，请先在知识库面板中创建。</p>
          ) : (
            <ul className={styles.menuList}>
              {candidates.map(candidate => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={styles.menuItem}
                    onClick={() => { pick(candidate) }}
                  >
                    <span className={styles.menuName}>{candidate.name}</span>
                    {/* The built state is stated because an unbuilt base answers
                        nothing, and picking one silently would read as a defect. */}
                    <span className={`kb-mono ${styles.menuMeta}`}>
                      {candidate.built ? candidate.id : `${candidate.id} · 未构建`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </span>
  )
}
