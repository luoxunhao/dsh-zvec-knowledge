/**
 * UploadDropzone — the drag-and-drop intake (design spec §5.2).
 *
 * Two constraints shape this component, and both are easy to get wrong:
 *
 * - **It must be keyboard reachable with a visible focus state.** A drop zone
 *   that only accepts a mouse drag locks out every keyboard user, and the
 *   accessible fallback is a real `<button>` that opens the file picker. The
 *   zone is therefore a labelled button wrapping the visual area, not a `div`
 *   with a drop handler.
 * - **The copy is two lines.** The primary line explains the action, the
 *   secondary line states the accepted formats and the size ceiling — because a
 *   rejected file has to have been predictable *before* the user picked it.
 *
 * @module dsh-zvec-knowledge/client/components/UploadDropzone
 */

import { useId, useRef, useState, type DragEvent } from 'react'
import { Icon } from './Icon.tsx'
import styles from './UploadDropzone.module.css'

/** Options accepted by {@link UploadDropzone}. */
export interface UploadDropzoneProps {
  /** Called with the chosen files. Validation belongs to the caller. */
  onFiles: (files: File[]) => void
  /** Accepted formats, rendered into the secondary line. */
  accepted: readonly string[]
  /** Human-readable size ceiling, rendered into the secondary line. */
  maxSizeLabel: string
  /** Disables intake, e.g. while no collection is selected. */
  disabled?: boolean
  /**
   * Number of transfers currently in flight.
   *
   * The zone stays enabled while uploading — the spec puts progress in the list
   * rows so a transfer does not block the page — so this is informational, not a
   * lock.
   */
  uploadingCount?: number
}

/**
 * Render the upload intake area.
 * @param props - file handler, accepted formats and limits.
 * @returns the drop zone.
 */
export function UploadDropzone({
  onFiles, accepted, maxSizeLabel, disabled = false, uploadingCount = 0,
}: UploadDropzoneProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const id = useId()
  const busy = uploadingCount > 0

  /** Accept a drop and clear the highlight. */
  const handleDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) onFiles(files)
  }

  return (
    <div className={`${styles.wrap} ${busy ? styles.loading : ''}`.trim()} aria-busy={busy || undefined}>
      <input
        ref={inputRef}
        id={id}
        type="file"
        className={styles.input}
        multiple
        accept={accepted.map(ext => `.${ext}`).join(',')}
        disabled={disabled}
        onChange={event => {
          const files = Array.from(event.target.files ?? [])
          if (files.length > 0) onFiles(files)
          // Reset so re-choosing the same file fires `change` again.
          event.target.value = ''
        }}
      />
      <button
        type="button"
        className={`${styles.zone} ${dragging ? styles.dragging : ''}`.trim()}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onClick={() => inputRef.current?.click()}
        onDragOver={event => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <span className={styles.icon} aria-hidden="true">
          <Icon name="upload" size={24} />
        </span>
        {/* Primary line: what to do. */}
        <span className={styles.primary}>拖拽文件到此处，或点击选择文件</span>
        {/* Secondary line: what is acceptable. Required by §5.2. */}
        <span className={styles.secondary} id={`${id}-hint`}>
          支持 {accepted.join(' / ')}，单个文件不超过 {maxSizeLabel}
        </span>
        {busy && (
          <span className={styles.count} role="status">
            <Icon name="clock" size={12} /> {uploadingCount} 个文件上传中，完成后状态为「待构建」
          </span>
        )}
      </button>
    </div>
  )
}
