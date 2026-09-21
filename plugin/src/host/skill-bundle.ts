/**
 * Ship the knowledge-base RAG skills with the plugin.
 *
 * A session that retrieves from this plugin needs two things the harness cannot
 * infer: the retrieval loop the plugin's own knobs support (which collection,
 * whether the served snapshot covers the question, what the tool cannot change),
 * and the citation discipline that makes an answer checkable. Both are written as
 * skills and live in `skills/` next to this package, so installing the plugin
 * gives a session them without a second install step.
 *
 * **Why registration rather than a discovery root.** DSH discovers skills under
 * `<gitRoot>/.dsh/skills`, `<gitRoot>/.agents/skills`, `customSkillDirs`,
 * `$DSH_HOME/skills`, `$DSH_AGENTS_HOME/skills`, and the bundled directory — never
 * an arbitrary package's own tree. `customSkillDirs` is resolved against the
 * process working directory, so a deployment's YAML cannot name a path inside an
 * installed package. `ctx.skills.register()` is the one channel that carries a
 * package-relative directory, and it also hands the consumer a `resourceBase`,
 * which is how a skill's own `scripts/` stays reachable.
 *
 * **Rank.** A runtime registration sits at rank 250, behind `<gitRoot>/.dsh/skills`
 * (100) and `<gitRoot>/.agents/skills` (200). A project that wants its own version
 * of these instructions drops a copy in either of those roots and wins; this file
 * is the fallback that ships with the plugin, not the last word.
 *
 * **Failure posture.** A skill file that is missing or unparseable throws. The
 * package is the only producer of those files, `npm run verify:skill` compares them
 * against their repository sources and exercises this exact registration on every
 * `npm run verify`, so a defect here is a broken build rather than a session that
 * quietly lost its guidance.
 *
 * @module dsh-zvec-knowledge/host/skill-bundle
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The kebab-case form the skill registry accepts as a skill name. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** One `SKILL.md` reduced to the fields this module contributes. */
export interface SkillMarkdown {
  /** Kebab-case skill name, taken from frontmatter and checked against its directory. */
  name: string,
  /** Routing description the model sees when deciding whether to load the skill. */
  description: string,
  /** Optional extra routing guidance. */
  whenToUse?: string,
  /** Markdown body with the frontmatter block removed. */
  body: string,
}

/** Structural view of the `skills` service, so the plugin needs no dependency on it. */
export interface SkillRegistryLike {
  /**
   * Register one runtime skill and return its disposer.
   * @param skill - definition fields; `invocation` and `provider` are omitted so the
   *   registry applies its own defaults (both surfaces invocable, `runtime` provider).
   * @returns a disposer that removes this registration.
   */
  register(skill: {
    name: string,
    description: string,
    content: string,
    source: string,
    path?: string,
    whenToUse?: string,
    resourceBase?: { kind: 'directory', path: string },
  }): () => void
}

/** Optional logger surface, narrowed to what this module reports. */
export interface SkillLogger {
  /** @param message - registration outcome. */
  info?: (message: string) => void
}

/** What {@link registerKbSkills} contributes. */
export interface SkillRegistrationResult {
  /** Registered skill names, in directory order. */
  names: readonly string[],
  /** Removes every registration this call made. */
  dispose: () => void,
}

/** The directory this package ships its skills in, resolved from the built module. */
export function defaultSkillsDir(): string {
  return fileURLToPath(new URL('../../skills', import.meta.url))
}

/**
 * Parse the frontmatter subset a `SKILL.md` is allowed to use.
 * @param text - full file text.
 * @param origin - path quoted into every failure message.
 * @returns the fields needed for registration.
 * @throws when the block is absent, the name is not kebab-case or does not match the
 *   containing directory, or the description is empty.
 */
export function parseSkillMarkdown(text: string, origin: string): SkillMarkdown {
  const opened = text.startsWith('---\n') ? 4 : -1
  if (opened === -1) throw new Error(`${origin}: 缺少 YAML frontmatter（首行须是 ---）`)
  const closed = text.indexOf('\n---\n', opened - 1)
  if (closed === -1) throw new Error(`${origin}: frontmatter 未闭合`)
  const block = text.slice(opened, closed + 1)
  const body = text.slice(closed + 5).replace(/^\r?\n/, '')

  const fields = new Map<string, string>()
  for (const line of block.split(/\r?\n/)) {
    // Indented lines belong to a nested block (the `metadata:` map) and carry no
    // field this module reads, so skipping them is the whole unmarshalling rule.
    if (/^\s/.test(line) || line === '') continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    if (key === undefined) continue
    const raw = match[2] ?? ''
    const value = /^"(.*)"$/.test(raw) || /^'(.*)'$/.test(raw) ? raw.slice(1, -1) : raw
    fields.set(key, value)
  }

  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (!SKILL_NAME.test(name)) throw new Error(`${origin}: name「${name}」不是 kebab-case，DSH 会拒绝该 skill`)
  if (description === '') throw new Error(`${origin}: ${name} 缺 description，DSH 会拒绝该 skill`)
  const directory = origin.split(/[\\/]/).slice(-2)[0] ?? ''
  if (directory !== name) throw new Error(`${origin}: name「${name}」与所在目录「${directory}」不一致`)
  const whenToUse = fields.get('when_to_use') ?? fields.get('whenToUse') ?? ''
  return {
    name,
    description,
    ...(whenToUse === '' ? {} : { whenToUse }),
    body,
  }
}

/**
 * Register every skill this package ships.
 *
 * Reads one level of directories under `skillsDir` and requires a `SKILL.md` in
 * each, matching how DSH's own filesystem provider walks a discovery root: a
 * nested `SKILL.md` deeper than one directory is not a supported shape, so a skill
 * directory never hides inside another.
 * @param skills - the host's `skills` service.
 * @param options - `skillsDir` defaults to this package's own `skills/`; `source`
 *   labels the discovery source shown by `ctx.skills.list()`.
 * @returns the registered names and one disposer for all of them.
 */
export function registerKbSkills(
  skills: SkillRegistryLike,
  options: { skillsDir?: string, source?: string, logger?: SkillLogger } = {},
): SkillRegistrationResult {
  const skillsDir = options.skillsDir ?? defaultSkillsDir()
  const source = options.source ?? 'zvec-knowledge'
  if (!existsSync(skillsDir)) {
    throw new Error(`dsh-zvec-knowledge: 找不到 skill 目录 ${skillsDir}（本包应随附 skills/<name>/SKILL.md）`)
  }

  const names: string[] = []
  const disposers: (() => void)[] = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue
    const directory = join(skillsDir, entry.name)
    const file = join(directory, 'SKILL.md')
    if (!existsSync(file)) {
      throw new Error(`dsh-zvec-knowledge: ${directory} 下没有 SKILL.md`)
    }
    const skill = parseSkillMarkdown(readFileSync(file, 'utf8'), file)
    disposers.push(skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.body,
      source,
      path: file,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      resourceBase: { kind: 'directory', path: directory },
    }))
    names.push(skill.name)
  }
  options.logger?.info?.(`dsh-zvec-knowledge: registered ${names.length} skill(s): ${names.join(', ')}`)
  return {
    names,
    dispose: () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}
