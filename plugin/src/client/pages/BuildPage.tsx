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
  /** Documents not yet built, which an incremental build would embed. */
  pendingDocuments?: number
  /** Documents in the collection. */
  totalDocuments?: number
  /**
   * Whether the host can build incrementally with the current parameters.
   *
   * `null` while it is still being asked. `possible: false` is not an error — the
   * strategy changed, so every document must be re-cut — and its `reason` is what
   * the page shows, instead of offering a choice the host would override.
   */
  incrementalPlan?: { possible: boolean, reason: string } | null
  /** A statement about the build: nothing to rebuild, or a forced full rebuild. */
  buildNotice?: string | null
  /** Submit the strategy and rebuild, in the chosen mode. */
  onSubmit: (mode: 'incremental' | 'full') => void
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
 * the field the user is editing, not only after a round trip. The two agree on
 * order as well as on wording: checking `overlap >= chunk` first reported the
 * overlap as the problem when the user had only lowered the chunk size, naming a
 * parameter they had not touched. Rules about a single field come first; the
 * cross-field overlap rule comes last.
 * @param draft - the chunking draft.
 * @returns `null` when acceptable, otherwise the reason.
 */
export function validateChunkingDraft(draft: ChunkingDraft): string | null {
  if (draft.minChunkTokens > draft.chunkTokens) {
    return `最小分片（${draft.minChunkTokens}）不能大于分片长度（${draft.chunkTokens}），否则所有分片都会被丢弃`
  }
  if (draft.overlapTokens >= draft.chunkTokens) {
    return `重叠长度（${draft.overlapTokens}）必须小于分片长度（${draft.chunkTokens}），否则切分无法终止`
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
  servingPreviousSnapshot, hasDocuments,
  pendingDocuments = 0, totalDocuments = 0, incrementalPlan = null, buildNotice = null,
  onSubmit, onCancel, onRetry, onReset,
}: BuildPageProps): React.JSX.Element {
  const [logOpen, setLogOpen] = useState(false)
  // Which documents to embed. Defaults to the cheap path, because the common
  // action here is "I uploaded something, index it" — and the host downgrades to a
  // full rebuild anyway when the parameters no longer allow reuse.
  const [mode, setMode] = useState<'incremental' | 'full'>('incremental')
  const chunkingError = useMemo(() => validateChunkingDraft(chunking), [chunking])
  const model = models.find(item => item.id === index.model)

  // Whether the host will actually build incrementally. Asked rather than assumed:
  // the page cannot see the stored strategy, and only two conditions allow reuse.
  const incrementalAllowed = incrementalPlan === null || incrementalPlan.possible

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

  if (collectionId === null) {
    return (
      <EmptyState
        icon="database"
        title="尚未选择知识库"
        description="请先在「总览」中选择一个知识库，再配置它的索引策略。"
      />
    )
  }

  const submitDisabled = running || chunkingError !== null || !hasDocuments

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

        {/* Read-only parameter grid: these are not user-editable (§5.6), which is
            precisely why a wrong value here is unrecoverable for the user — the
            dimension must come from the host rather than a client-side default. */}
        <dl className={styles.readonly}>
          <div className={styles.readonlyItem}>
            <dt className={styles.readonlyLabel}>向量维度</dt>
            {/* An em dash until the host reports it. The previous fallback was the
                literal 1024, which silently misreported a 2560-wide deployment as
                a 1024 one; "not known yet" and "1024" are different statements and
                only one of them is true. */}
            <dd className={`kb-mono ${styles.readonlyValue}`}>{model?.dimension ?? '—'}</dd>
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

        {/*
          The hybrid weights control used to sit here. It is gone because it did
          nothing: the pair was validated (must sum to 1), stored in the draft and
          rendered as two number fields, but never reached `IndexConfig`, was never
          persisted, and was never read by `search()` — which fuses with the
          engine's own RRF, a ranker that takes no weights at all.

          A control that gates submission while having no effect on results is
          worse than a missing one: it advertises a capability the plugin does not
          have. Measured, RRF also ranks the ground-truth chunk better than the
          engine's weighted ranker (mean position 0.67 vs 5.50 over six queries,
          with one query losing its correct hit entirely under weighting), so
          wiring the weights up would have made retrieval worse. The spec's §5.6
          weight row is therefore recorded as not applicable to RRF fusion rather
          than implemented.
        */}
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

      {/* 5. The action row, after both columns and the estimate.
          The mode is an explicit choice rather than something inferred, because
          "which documents get re-embedded" changes what the user is paying for and
          how long it takes — and the host can only tell whether it is *allowed*,
          not whether the user wanted it. */}
      <div className={styles.submit}>
        <div className={styles.submitChoice}>
          <SegmentedControl
            label="构建范围"
            options={[
              {
                value: 'incremental',
                // The label states the cost, not just the mode: "只构建新文档" is what
                // the user is choosing between, and the count makes it concrete.
                label: incrementalPlan?.possible === false
                  ? '仅新增（不可用）'
                  : `仅新增${pendingDocuments > 0 ? `（${pendingDocuments} 篇）` : ''}`,
              },
              { value: 'full', label: `全部重建${totalDocuments > 0 ? `（${totalDocuments} 篇）` : ''}` },
            ]}
            value={incrementalAllowed ? 'incremental' : 'full'}
            onChange={value => { setMode(value as 'incremental' | 'full') }}
          />
          <Button
            variant="primary"
            icon="refresh"
            onClick={() => onSubmit(mode)}
            loading={running}
            loadingLabel="构建中…"
            disabled={submitDisabled}
          >
            保存并重建索引
          </Button>
        </div>

        {/* Why the cheap option is unavailable. Shown beside the control the user
            would otherwise reach for, so "it is greyed out" is never unexplained. */}
        {incrementalPlan?.possible === false && (
          <p className={styles.submitHint}>
            <Icon name="info" size={14} /> {incrementalPlan.reason}，本次将全量重建。
          </p>
        )}
        {pendingDocuments === 0 && incrementalAllowed && hasDocuments && (
          <p className={styles.submitHint}>
            <Icon name="info" size={14} /> 所有文档均已构建，选择「仅新增」将没有需要嵌入的内容。
          </p>
        )}
        {buildNotice !== null && (
          <p className={styles.submitHint} role="status">
            <Icon name="info" size={14} /> {buildNotice}
          </p>
        )}
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
