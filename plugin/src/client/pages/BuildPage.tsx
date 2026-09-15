/**
 * BuildPage — 链路③ 索引构建（design spec §5.3, §5.5, §5.6, §6.5）.
 *
 * The page's structure *is* the requirement, so the order is deliberate and fixed:
 *
 * 1. chunking strategy
 * 2. chunk preview (recomputed on every parameter change)
 * 3. embedding & index strategy
 * 4. cost estimate
 * 5. **then** the submit button
 *
 * The spec is explicit that the estimate must appear before the submit button
 * ("必须出现在提交按钮之前") and that the preview must not be omitted. Placing
 * them as literal siblings above the action row is what makes that ordering a
 * property of the markup rather than a convention someone can reorder.
 *
 * @module dsh-zvec-knowledge/client/pages/BuildPage
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { ChunkPreview, type PreviewRowData } from '../components/ChunkPreview.tsx'
import { CostEstimate } from '../components/CostEstimate.tsx'
import { BuildPipeline, type LogLine, type StageView } from '../components/BuildPipeline.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { Icon } from '../components/Icon.tsx'
import { NumberField } from '../components/NumberField.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { Select } from '../components/Select.tsx'
import { Switch } from '../components/Switch.tsx'
import styles from './BuildPage.module.css'

/** Chunking strategy as the configurator holds it. */
export interface ChunkingDraft {
  /** Split mode. */
  mode: 'heading' | 'paragraph' | 'fixed'
  /** Target chunk size in tokens. */
  chunkTokens: number
  /** Overlap in tokens. */
  overlapTokens: number
  /** Minimum retained chunk size. */
  minChunkTokens: number
  /** Keep fenced code blocks whole. */
  preserveCodeBlocks: boolean
  /** Split tables by row. */
  splitTablesByRow: boolean
}

/** Index strategy as the configurator holds it. */
export interface IndexDraft {
  /** Embedding model id. */
  model: string
  /** Index family. */
  kind: 'HNSW' | 'IVF' | 'DISKANN'
  /** HNSW `M`. */
  m: number
  /** HNSW `efConstruction`. */
  efConstruction: number
  /** Quantizer. */
  quantize: 'INT8' | 'INT4' | 'FP16' | 'none'
  /** Dense weight in the hybrid blend. */
  denseWeight: number
  /** Full-text weight in the hybrid blend. */
  fullTextWeight: number
}

/** Preview data as the host reports it. */
export interface HostPreview {
  /** Leading chunk rows. */
  rows: PreviewRowData[]
  /** Total retained chunks. */
  totalChunks: number
  /** Mean tokens per chunk. */
  averageTokens: number
  /** Discarded fragments. */
  discarded: number
  /** Total tokens. */
  totalTokens: number
}

/** Cost estimate as the host reports it. */
export interface HostCost {
  /** Chunks to write. */
  chunks: number
  /** Raw vector bytes. */
  rawVectorBytes: number
  /** Quantized vector bytes. */
  vectorBytes: number
  /** Compression ratio. */
  compression: number
  /** Estimated seconds. */
  estimatedSeconds: number
  /** How the duration was derived. */
  basis: string
}

/** Options the host exposes for one embedding model. */
export interface HostModelOption {
  /** Stable id. */
  id: string
  /** Display label. */
  label: string
  /** Output dimension. */
  dimension: number
  /** Distance metric the model is normalized for. */
  metric: string
  /** Free-text note. */
  note: string
}

/** Quantizer option as the host reports it. */
export interface HostQuantizerOption {
  /** Stored value. */
  value: 'INT8' | 'INT4' | 'FP16' | 'none'
  /** Display label. */
  label: string
  /** Compression and recall trade-off, stated in the option copy. */
  tradeoff: string
}

/** Options accepted by {@link BuildPage}. */
export interface BuildPageProps {
  /** Whether a collection is selected. */
  collectionId: string | null
  /** Current chunking draft. */
  chunking: ChunkingDraft
  /** Called as the chunking draft changes. */
  onChunkingChange: (next: ChunkingDraft) => void
  /** Current index draft. */
  index: IndexDraft
  /** Called as the index draft changes. */
  onIndexChange: (next: IndexDraft) => void
  /** Preview for the current chunking draft, or `null` while computing. */
  preview: HostPreview | null
  /** Preview failure reason, if any. */
  previewError?: string | null
  /** Cost estimate for the current drafts, or `null` while computing. */
  cost: HostCost | null
  /** Model options the configurator may choose. */
  models: HostModelOption[]
  /** Quantizer options with their trade-offs. */
  quantizers: HostQuantizerOption[]
  /** Stages of a running or last build. */
  stages: StageView[]
  /** Items processed. */
  processed: number
  /** Total items. */
  total: number
  /** Build fraction in [0, 1]. */
  fraction: number
  /** Build log lines. */
  log: LogLine[]
  /** Whether a build is running. */
  running: boolean
  /** Build failure reason. */
  buildError?: string | null
  /** Whether retrieval is serving the previous snapshot. */
  servingPreviousSnapshot: boolean
  /** Whether the collection has any documents. */
  hasDocuments: boolean
  /** Submit the strategy and rebuild. */
  onSubmit: () => void
  /** Cancel a running build. */
  onCancel: () => void
  /** Retry a failed build. */
  onRetry: () => void
  /** Reset both drafts to the recommended defaults. */
  onReset: () => void
}

/** Split-mode options (§5.5). */
const MODE_OPTIONS = [
  { value: 'heading', label: '按标题层级' },
  { value: 'paragraph', label: '按段落' },
  { value: 'fixed', label: '固定长度' },
] as const

/** Index-family options (§5.6). */
const INDEX_OPTIONS = [
  { value: 'HNSW', label: 'HNSW' },
  { value: 'IVF', label: 'IVF' },
  { value: 'DISKANN', label: 'DiskANN' },
] as const

/**
 * Validate the chunking draft's relational rules.
 *
 * Checked here as well as on the host because the message has to appear next to
 * the field the user is editing, not only after a round trip.
 * @param draft - the chunking draft.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateChunkingDraft(draft: ChunkingDraft): string | null {
  if (draft.overlapTokens >= draft.chunkTokens) {
    return `重叠长度（${draft.overlapTokens}）必须小于分片长度（${draft.chunkTokens}），否则切分无法终止`
  }
  if (draft.minChunkTokens > draft.chunkTokens) {
    return `最小分片（${draft.minChunkTokens}）不能大于分片长度（${draft.chunkTokens}），否则所有分片都会被丢弃`
  }
  return null
}

/**
 * Validate the hybrid weights.
 * @param draft - the index draft.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateWeightsDraft(draft: IndexDraft): string | null {
  const sum = draft.denseWeight + draft.fullTextWeight
  if (Math.abs(sum - 1) > 1e-6) {
    return `稠密与全文权重之和必须为 1，当前为 ${Number(sum.toFixed(2))}`
  }
  return null
}

/**
 * Render the index-build page.
 * @param props - drafts, host data and callbacks.
 * @returns the page.
 */
export function BuildPage({
  collectionId, chunking, onChunkingChange, index, onIndexChange,
  preview, previewError = null, cost, models, quantizers,
  stages, processed, total, fraction, log, running, buildError = null,
  servingPreviousSnapshot, hasDocuments, onSubmit, onCancel, onRetry, onReset,
}: BuildPageProps): React.JSX.Element {
  const [logOpen, setLogOpen] = useState(false)
  const chunkingError = useMemo(() => validateChunkingDraft(chunking), [chunking])
  const weightsError = useMemo(() => validateWeightsDraft(index), [index])
  const model = models.find(item => item.id === index.model)

  // Open the log automatically when a build starts: the user asked for it, and a
  // collapsed log during an active build hides the only running commentary.
  useEffect(() => { if (running) setLogOpen(true) }, [running])

  /** Patch the chunking draft. */
  const patchChunking = useCallback((patch: Partial<ChunkingDraft>): void => {
    onChunkingChange({ ...chunking, ...patch })
  }, [chunking, onChunkingChange])

  /** Patch the index draft. */
  const patchIndex = useCallback((patch: Partial<IndexDraft>): void => {
    onIndexChange({ ...index, ...patch })
  }, [index, onIndexChange])

  /**
   * Move one weight and rebalance the other.
   *
   * The pair must sum to 1, so editing one necessarily moves the other; letting
   * the user drive them independently would mean the invalid state is reachable
   * and the submit button would have to be disabled, which is a worse experience
   * for a constraint with only one degree of freedom.
   * @param key - which weight is being edited.
   * @param value - the new weight.
   */
  const setWeight = (key: 'denseWeight' | 'fullTextWeight', value: number): void => {
    const clamped = Math.max(0, Math.min(1, value))
    const other = Number((1 - clamped).toFixed(2))
    patchIndex(key === 'denseWeight'
      ? { denseWeight: clamped, fullTextWeight: other }
      : { fullTextWeight: clamped, denseWeight: other })
  }

  if (collectionId === null) {
    return (
      <EmptyState
        icon="database"
        title="尚未选择知识库"
        description="请先在「总览」中选择一个知识库，再配置它的索引策略。"
      />
    )
  }

  const submitDisabled = running || chunkingError !== null || weightsError !== null || !hasDocuments

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h3 className={styles.title}>索引策略</h3>
          {/* §5.3: the header must say that parameters need a rebuild to apply. */}
          <p className={styles.description}>
            参数变更需重建才生效。重建期间，会话中的 dsh_kb_search 仍使用上一次构建的索引。
          </p>
        </div>
        <Button variant="ghost" icon="refresh" onClick={onReset}>重置为推荐值</Button>
      </header>

      {/* §6.5 is explicit about the shape: 左栏为切分策略与分片预览，右栏为嵌入与索引
          策略、混合检索权重与代价预估. The two columns are literal siblings so the
          division is a property of the markup rather than a responsive accident.

          The cost estimate stays in the right column (it belongs to the embedding
          and index strategy it describes), and the submit row sits below both, so
          §5.6's "estimate before the submit button" still holds in source order. */}
      <div className={styles.columns}>
        <div className={styles.column}>
          {/* 1. Chunking strategy */}
          <section className={styles.section} aria-label="切分策略">
            <h4 className={styles.sectionTitle}>切分策略</h4>
            <div className={styles.row}>
              <SegmentedControl
                label="切分方式"
                options={MODE_OPTIONS.map(item => ({ value: item.value, label: item.label }))}
                value={chunking.mode}
                onChange={value => patchChunking({ mode: value as ChunkingDraft['mode'] })}
              />
            </div>
            <div className={styles.grid}>
              <NumberField
                label="分片长度（token）"
                value={chunking.chunkTokens}
                onChange={value => patchChunking({ chunkTokens: value })}
                min={64}
                max={8192}
                step={64}
                hint="单个分片的目标 token 数"
              />
              <NumberField
                label="重叠长度（token）"
                value={chunking.overlapTokens}
                onChange={value => patchChunking({ overlapTokens: value })}
                min={0}
                max={4096}
                step={16}
                hint="相邻分片共享的上下文"
              />
              <NumberField
                label="最小分片（token）"
            value={chunking.minChunkTokens}
            onChange={value => patchChunking({ minChunkTokens: value })}
            min={0}
            max={4096}
            step={16}
            hint="低于该值的碎片会被丢弃"
          />
        </div>
        {chunkingError !== null && (
          <p className={styles.error} role="alert">
            <Icon name="alert" size={14} /> {chunkingError}
          </p>
        )}
          <div className={styles.switches}>
            <Switch
              label="保留代码块"
              description="不切断围栏代码块，避免产出无法阅读的片段"
              checked={chunking.preserveCodeBlocks}
              onChange={value => patchChunking({ preserveCodeBlocks: value })}
            />
            <Switch
              label="表格按行拆分"
              description="大表格按行切分，而不是整表作为一个分片"
              checked={chunking.splitTablesByRow}
              onChange={value => patchChunking({ splitTablesByRow: value })}
            />
          </div>
          </section>

          {/* 2. Preview — the only pre-submit quality check (§5.5). It belongs in
              the left column with the chunking strategy, because it is that
              strategy's own output. */}
          <ChunkPreview
            rows={preview?.rows ?? []}
            totalChunks={preview?.totalChunks ?? 0}
            averageTokens={preview?.averageTokens ?? 0}
            discarded={preview?.discarded ?? 0}
            totalTokens={preview?.totalTokens ?? 0}
            loading={preview === null}
            error={previewError}
          />
        </div>

        {/* Right column: embedding and index strategy, the hybrid weights, and the
            cost estimate — per §6.5. */}
        <div className={styles.column}>
          {/* 3. Embedding & index strategy */}
          <section className={styles.section} aria-label="嵌入与索引策略">
            <h4 className={styles.sectionTitle}>嵌入与索引策略</h4>
        <div className={styles.grid}>
          <Select
            label="嵌入模型"
            value={index.model}
            onChange={value => patchIndex({ model: value })}
            options={models.map(item => ({ value: item.id, label: item.label }))}
            hint={model?.note}
          />
        </div>

        {/* Read-only parameter grid: these two are not user-editable (§5.6). */}
        <dl className={styles.readonly}>
          <div className={styles.readonlyItem}>
            <dt className={styles.readonlyLabel}>向量维度</dt>
            <dd className={`kb-mono ${styles.readonlyValue}`}>{model?.dimension ?? 1024}</dd>
          </div>
          <div className={styles.readonlyItem}>
            <dt className={styles.readonlyLabel}>数据类型</dt>
            <dd className={`kb-mono ${styles.readonlyValue}`}>VECTOR_FP32</dd>
          </div>
          <div className={styles.readonlyItem}>
            <dt className={styles.readonlyLabel}>距离度量</dt>
            {/* Shown read-only because the engine defaults to inner product, so
                the value must be pinned rather than left to a user's guess. */}
            <dd className={`kb-mono ${styles.readonlyValue}`}>cosine</dd>
          </div>
        </dl>

        <div className={styles.row}>
          <span className={styles.fieldLabel}>索引类型</span>
          <SegmentedControl
            label="索引类型"
            options={INDEX_OPTIONS.map(item => ({ value: item.value, label: item.label }))}
            value={index.kind}
            onChange={value => patchIndex({ kind: value as IndexDraft['kind'] })}
          />
        </div>

        {/* M and efConstruction are HNSW-only; the other families build with
            their own structural parameters, so showing them would imply an
            effect they do not have. */}
        {index.kind === 'HNSW' && (
          <div className={styles.grid}>
            <NumberField
              label="M"
              value={index.m}
              onChange={value => patchIndex({ m: value })}
              min={4}
              max={128}
              hint="每层邻居数，越大召回越高、内存越多"
            />
            <NumberField
              label="efConstruction"
              value={index.efConstruction}
              onChange={value => patchIndex({ efConstruction: value })}
              min={16}
              max={2048}
              step={16}
              hint="构建时候选集大小"
            />
          </div>
        )}

        <div className={styles.grid}>
          <Select
            label="量化器"
            value={index.quantize}
            onChange={value => patchIndex({ quantize: value as IndexDraft['quantize'] })}
            options={quantizers.map(item => ({ value: item.value, label: item.label }))}
            hint={quantizers.find(item => item.value === index.quantize)?.tradeoff}
          />
        </div>

          <div className={styles.weights}>
            <span className={styles.fieldLabel}>混合检索权重</span>
            <div className={styles.grid}>
              <NumberField
                label="稠密向量"
                value={index.denseWeight}
                onChange={value => setWeight('denseWeight', value)}
                min={0}
                max={1}
                step={0.05}
              />
              <NumberField
                label="全文检索"
                value={index.fullTextWeight}
                onChange={value => setWeight('fullTextWeight', value)}
                min={0}
                max={1}
                step={0.05}
              />
            </div>
            <p className={styles.hint}>两者之和固定为 1，融合方式固定为 RRF</p>
            {weightsError !== null && (
              <p className={styles.error} role="alert">
                <Icon name="alert" size={14} /> {weightsError}
              </p>
            )}
          </div>
          </section>

          {/* 4. Cost estimate — in the same column as the configuration it
              describes, and above the submit row in source order, per §5.6. */}
          {cost !== null && (
            <CostEstimate
              chunks={cost.chunks}
              rawVectorBytes={cost.rawVectorBytes}
              vectorBytes={cost.vectorBytes}
              compression={cost.compression}
              estimatedSeconds={cost.estimatedSeconds}
              basis={cost.basis}
            />
          )}
        </div>
      </div>

      {/* 5. The action row, after both columns and the estimate. */}
      <div className={styles.submit}>
        <Button
          variant="primary"
          icon="refresh"
          onClick={onSubmit}
          loading={running}
          loadingLabel="构建中…"
          disabled={submitDisabled}
        >
          保存并重建索引
        </Button>
        {!hasDocuments && <span className={styles.submitHint}>该知识库还没有文档，请先在「文档」中上传。</span>}
      </div>

      <BuildPipeline
        stages={stages}
        processed={processed}
        total={total}
        fraction={fraction}
        log={log}
        logOpen={logOpen}
        onLogToggle={setLogOpen}
        running={running}
        onCancel={onCancel}
        onRetry={onRetry}
        error={buildError}
        servingPreviousSnapshot={servingPreviousSnapshot}
      />
    </div>
  )
}
