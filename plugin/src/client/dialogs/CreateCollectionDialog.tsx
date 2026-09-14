/**
 * CreateCollectionDialog — the single-step create flow (design spec §5.1, §6.2).
 *
 * The spec explicitly defers the multi-step wizard (issue list §6 item 1: "本期未
 * 纳入，用户明确暂缓"), so this is one dialog with three fields. That is a real
 * constraint and not a simplification: adding steps here would be implementing a
 * thing the business side has not agreed to build.
 *
 * The identifier is shown and editable rather than hidden, because the spec's
 * identifier rule ("业务域缩写 + 短哈希") is something an operator may need to
 * align with an existing naming scheme. It is prefilled from the name and
 * regenerated as the name changes *only while the user has not edited it*, so a
 * deliberate override is never silently overwritten.
 *
 * Validation reports a reason per field rather than a single "invalid" flag —
 * the spec's rule that negative validation must explain itself.
 *
 * @module dsh-zvec-knowledge/client/dialogs/CreateCollectionDialog
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { Icon } from '../components/Icon.tsx'
import { TextField } from '../components/TextField.tsx'
import { buildCollectionId, validateCollectionId, validateCollectionName } from '../collection-id.ts'
import styles from './CreateCollectionDialog.module.css'

/** Options accepted by {@link CreateCollectionDialog}. */
export interface CreateCollectionDialogProps {
  /** Whether the dialog is open. */
  open: boolean
  /** Called to close without creating. */
  onClose: () => void
  /**
   * Called with the validated values.
   *
   * May return a promise; a rejection is shown in the dialog so the user can
   * correct the input rather than losing it.
   */
  onCreate: (values: { name: string, collectionId: string, description: string }) => Promise<void> | void
  /** Existing identifiers, so a collision is caught before submitting. */
  existingIds: string[]
}

/**
 * Render the create dialog.
 * @param props - open state, submit handler and existing ids.
 * @returns the dialog, or nothing when closed.
 */
export function CreateCollectionDialog({
  open, onClose, onCreate, existingIds,
}: CreateCollectionDialogProps): React.JSX.Element | null {
  const [name, setName] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [description, setDescription] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  // Each open starts a clean draft; a stale draft from a cancelled attempt is
  // more confusing than retyping one line.
  useEffect(() => {
    if (!open) return
    setName('')
    setCollectionId('')
    setDescription('')
    setIdEdited(false)
    setSubmitting(false)
    setSubmitError(null)
    setTouched(false)
  }, [open])

  // Follow the name until the user takes over the identifier.
  useEffect(() => {
    if (idEdited || !open) return
    setCollectionId(name.trim() === '' ? '' : buildCollectionId(name))
  }, [name, idEdited, open])

  const nameError = useMemo(() => (touched ? validateCollectionName(name) : null), [name, touched])
  const idError = useMemo(() => {
    if (!touched) return null
    const format = validateCollectionId(collectionId)
    if (format !== null) return format
    if (existingIds.includes(collectionId)) return `集合标识 ${collectionId} 已存在，请换一个`
    return null
  }, [collectionId, existingIds, touched])

  if (!open) return null

  /** Validate, then hand the values up. */
  const submit = async (): Promise<void> => {
    setTouched(true)
    if (validateCollectionName(name) !== null || validateCollectionId(collectionId) !== null) return
    if (existingIds.includes(collectionId)) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onCreate({ name: name.trim(), collectionId, description: description.trim() })
    } catch (error) {
      setSubmitError(String(error instanceof Error ? error.message : error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.backdrop} role="presentation" onClick={event => { if (event.target === event.currentTarget && !submitting) onClose() }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="kb-create-title">
        <header className={styles.header}>
          <h2 id="kb-create-title" className={styles.title}>创建知识库</h2>
          <button type="button" className={styles.close} aria-label="关闭" onClick={onClose} disabled={submitting}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <TextField
            label="名称"
            value={name}
            onChange={setName}
            placeholder="例如：产品文档"
            invalid={nameError !== null}
            error={nameError ?? undefined}
            hint="用于界面展示，可随时修改"
          />
          <TextField
            label="集合标识"
            value={collectionId}
            onChange={value => { setIdEdited(true); setCollectionId(value) }}
            placeholder="kb_prod_2f8a"
            invalid={idError !== null}
            error={idError ?? undefined}
            hint="写入 zvec Collection 元数据，创建后不可修改；用于日志对账"
          />
          <TextField
            label="说明"
            value={description}
            onChange={setDescription}
            placeholder="这个知识库收录什么内容"
            variant="textarea"
            hint="选填，会显示在总览页"
          />
          {submitError !== null && (
            <p className={styles.submitError} role="alert">
              <Icon name="alert" size={14} /> 创建失败：{submitError}
            </p>
          )}
        </div>

        <footer className={styles.footer}>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          {/* The only primary in the dialog, matching the page's single primary rule. */}
          <Button variant="primary" onClick={submit} loading={submitting} loadingLabel="创建中…">
            创建
          </Button>
        </footer>
      </div>
    </div>
  )
}
