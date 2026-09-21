#!/usr/bin/env node
/**
 * kb-inspect — read a dsh-zvec-knowledge store from disk, without the host.
 *
 * Why this exists: three questions during a RAG round cannot be answered from
 * `dsh_kb_search` output —
 *
 * 1. is the document the user just uploaded actually in the served snapshot?
 * 2. what score floor and retrieval mode is this collection answering under?
 * 3. did the last build finish, fail, or is it still running (in which case the
 *    search is still serving the *previous* snapshot)?
 *
 * All three are on disk under `<workspace>/<stateDir>` (default `.dsh-kb-zvec`),
 * so reading them here is exact rather than inferred from a search result.
 *
 * The store holds every document's full extracted text in `documents.jsonl`.
 * This script never prints text bodies, and caps the document rows it lists, so
 * its output stays small enough to read straight into a context window.
 *
 * Usage:
 *   node kb-inspect.mjs [storeRoot] [--kb <collectionId>] [--docs <n>] [--json]
 *
 * `storeRoot` defaults to `./.dsh-kb-zvec` and may also come from
 * the `KB_STORE_ROOT` environment variable.
 *
 * Exit codes: 0 inspected; 2 the store root does not exist (the workspace has
 * never had a knowledge base); 1 a read failed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const META_FILE = 'meta.json'
const DOCUMENTS_FILE = 'documents.jsonl'
const BUILD_LOG_FILE = 'build-log.jsonl'
const SOURCES_DIR = 'sources'

/** Parse the command line. */
function parseArgs(argv) {
  const args = { root: undefined, kb: undefined, docs: 10, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--kb') args.kb = argv[++i]
    else if (token === '--docs') args.docs = Number(argv[++i]) || 0
    else if (token === '--json') args.json = true
    else if (!token.startsWith('--')) args.root = token
  }
  args.root = resolve(args.root ?? process.env.KB_STORE_ROOT ?? '.dsh-kb-zvec')
  return args
}

/** Read a JSONL file, dropping a torn trailing line the way the store itself does. */
function readJsonl(path) {
  if (!existsSync(path)) return { rows: [], note: null }
  const raw = readFileSync(path, 'utf8')
  const rows = []
  let dropped = 0
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      dropped += 1
    }
  }
  return { rows, note: dropped > 0 ? `${dropped} 行无法解析（末行撕裂或写入中断）` : null }
}

/** Bytes to a human-readable figure. */
function size(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}

/** Directory size, best effort; an unreadable entry is reported not guessed. */
function dirBytes(path) {
  if (!existsSync(path)) return null
  let total = 0
  let complete = true
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    try {
      total += entry.isDirectory() ? dirBytes(child) ?? 0 : statSync(child).size
    } catch {
      complete = false
    }
  }
  return complete ? total : -total
}

/** ISO timestamps to `YYYY-MM-DD HH:MM`, local-free and comparable. */
function stamp(iso) {
  if (typeof iso !== 'string' || iso === '') return '—'
  return iso.slice(0, 16).replace('T', ' ')
}

/** One collection's report. */
function inspectCollection(dir, maxDocs) {
  const meta = JSON.parse(readFileSync(join(dir, META_FILE), 'utf8'))
  const docs = readJsonl(join(dir, DOCUMENTS_FILE))
  const log = readJsonl(join(dir, BUILD_LOG_FILE))
  const statusCounts = {}
  for (const doc of docs.rows) statusCounts[doc.status ?? 'unknown'] = (statusCounts[doc.status ?? 'unknown'] ?? 0) + 1

  // A document is in the served snapshot only if the last successful build covers
  // it: an upload newer than the snapshot is invisible to retrieval.
  const notServed = meta.builtAt === null
    ? docs.rows
    : docs.rows.filter(doc => (doc.builtAt ?? '') > meta.builtAt || doc.chunks === null || doc.chunks === 0)
  const failed = docs.rows.filter(doc => doc.status === 'failed')
  const servedChunksFromDocs = docs.rows.reduce((sum, doc) => sum + (typeof doc.chunks === 'number' ? doc.chunks : 0), 0)

  const sources = existsSync(join(dir, SOURCES_DIR)) ? readdirSync(join(dir, SOURCES_DIR)).length : 0
  const slots = ['a', 'b'].map(slot => ({ slot, served: meta.active === slot, bytes: dirBytes(join(dir, slot)) }))

  return {
    id: meta.id,
    name: meta.name,
    description: meta.description ?? '',
    served: {
      active: meta.active,
      builtAt: meta.builtAt,
      chunks: meta.chunks,
      docs: meta.docs,
    },
    strategy: {
      index: meta.index,
      chunking: meta.chunking,
      tokenizer: meta.tokenizer,
      retrieval: meta.retrieval,
    },
    documents: {
      logged: docs.rows.length,
      statusCounts,
      sourceCopies: sources,
      chunksFromDocs: servedChunksFromDocs,
      notServed: notServed.slice(0, maxDocs).map(doc => ({
        id: doc.id, name: doc.name, status: doc.status, chunks: doc.chunks,
        uploadedAt: doc.uploadedAt, builtAt: doc.builtAt, error: doc.error ?? null,
      })),
      notServedTotal: notServed.length,
      failed: failed.slice(0, maxDocs).map(doc => ({ id: doc.id, name: doc.name, error: doc.error ?? null })),
      logNote: log.note,
      recentLog: log.rows.slice(-4).map(line => `${stamp(line.at)} [${line.level}] ${line.message}`),
    },
    bytes: Object.fromEntries(slots.map(entry => [entry.slot, entry])),
  }
}

/** Print one collection's report as text. */
function render(report, maxDocs) {
  const out = []
  const index = report.strategy.index ?? {}
  const chunking = report.strategy.chunking ?? {}
  const retrieval = report.strategy.retrieval
  out.push(`■ ${report.name}  (${report.id})${report.description ? `  — ${report.description}` : ''}`)
  out.push(`  服务槽位 ${report.served.active ?? '无（从未成功构建）'}   构建于 ${stamp(report.served.builtAt)}   `
    + `快照 ${report.served.chunks} 片 / ${report.served.docs} 篇`)
  out.push(`  索引 ${index.kind ?? '?'} m=${index.m ?? '-'} ef=${index.efConstruction ?? '-'} 量化 ${index.quantize ?? '-'}   `
    + `切分 ${chunking.mode ?? '?'} chunk=${chunking.chunkTokens ?? '?'} overlap=${chunking.overlapTokens ?? '?'} min=${chunking.minChunkTokens ?? '?'}   `
    + `分词 ${report.strategy.tokenizer ?? '未知（旧库，改动即全量重建）'}`)
  out.push(`  检索策略 ${retrieval === null || retrieval === undefined
    ? '继承部署默认（工具无法改阈值，只能由界面或配置改）'
    : `minScore=${retrieval.minScore} topk=${retrieval.topk} candidates=${retrieval.candidates} mode=${retrieval.mode}`}`)
  const statuses = Object.entries(report.documents.statusCounts).map(([key, value]) => `${key} ${value}`).join(', ')
  out.push(`  文档日志 ${report.documents.logged} 篇（${statuses || '无'}）   快照正文副本 ${report.documents.sourceCopies} 份   `
    + `按篇分片合计 ${report.documents.chunksFromDocs}（快照记 ${report.served.chunks}）`)
  for (const slot of Object.values(report.bytes)) {
    if (slot.bytes === null) continue
    const stale = slot.bytes < 0
    out.push(`  槽位 ${slot.slot}${slot.served ? '（服务中）' : '（滞留，未被服务）'} ${size(Math.abs(slot.bytes))}`
      + (stale ? '  含读不动的条目，实测不完整' : ''))
  }
  if (report.documents.notServedTotal > 0) {
    out.push(`  ⚠ ${report.documents.notServedTotal} 篇不在服务快照里（检索召不到它们）：`)
    for (const doc of report.documents.notServed) {
      out.push(`     ${doc.name}  ${doc.id}  status=${doc.status ?? '?'} chunks=${doc.chunks === null ? '待构建' : doc.chunks}`
        + ` 上传 ${stamp(doc.uploadedAt)} 构建 ${stamp(doc.builtAt)}${doc.error ? `  err=${doc.error}` : ''}`)
    }
    if (report.documents.notServedTotal > maxDocs) out.push(`     …另有 ${report.documents.notServedTotal - maxDocs} 篇未列出`)
  } else if (report.served.active !== null) {
    out.push('  ✓ 日志里的每篇文档都在服务快照里')
  }
  for (const line of report.documents.recentLog) out.push(`  日志 ${line}`)
  if (report.documents.logNote) out.push(`  ⚠ ${report.documents.logNote}`)
  return out.join('\n')
}

const args = parseArgs(process.argv.slice(2))
if (!existsSync(args.root)) {
  console.log(`知识库存储根不存在：${args.root}`)
  console.log('知识库按工作区隔离（默认 <workspace>/.dsh-kb-zvec）。换到别的工作区就是另一个库，不是数据丢了。')
  console.log('要在宿主里核对：界面「知识库」侧栏看集合状态与构建进度；或在该工作区先上传文档并成功构建。')
  process.exit(2)
}

const dirs = readdirSync(args.root, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(args.root, entry.name, META_FILE)))
  .map(entry => entry.name)
  .filter(name => args.kb === undefined || name === args.kb)
  .sort()

if (dirs.length === 0) {
  console.log(`在 ${args.root} 下没有找到任何集合${args.kb ? `（--kb ${args.kb} 无匹配）` : ''}。`)
  process.exit(0)
}

const reports = dirs.map(name => inspectCollection(join(args.root, name), args.docs))
if (args.json) {
  console.log(JSON.stringify({ storeRoot: args.root, collections: reports }, null, 2))
} else {
  console.log(`知识库存储根 ${args.root}   集合 ${reports.length} 个`)
  for (const report of reports) console.log(`\n${render(report, args.docs)}`)
  console.log('\n提示：本脚本只读磁盘快照，不发起检索；构建中的库读到的仍是上一个已发布快照。')
}
