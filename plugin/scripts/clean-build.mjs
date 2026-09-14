/**
 * Remove build outputs before a build.
 *
 * Only `lib/` is removed. The generated token artifacts under `src/` are
 * deliberately kept: `pnpm verify:tokens` compares them against the token
 * source, and deleting them first would turn a hand-edited generated file into
 * a silent regeneration instead of a failure.
 */

import { existsSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(ROOT, 'lib')

if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true })
  console.log(`removed ${relative(ROOT, target)}`)
} else {
  console.log('nothing to clean')
}
