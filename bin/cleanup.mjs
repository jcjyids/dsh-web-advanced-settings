#!/usr/bin/env node
/**
 * 完全清理：把 dsh-advanced-listening-settings 在 profile 与 DSH 主目录里
 * 留下的一切收回到“装前状态”。**不需要插件还装着**也能跑。
 *
 * 用法：
 *   dsh-advanced-listening-cleanup [--profile web] [--home <DSH_HOME>] [--dry-run] [--keep-backup]
 *   npx -y dsh-advanced-listening-settings cleanup        # 卸载之后才想起来也能清
 *   npx -y dsh-advanced-listening-settings cleanup --dry-run
 *
 * 清什么：
 *   1. profile 的 cordis.patch.yml 里的托管块（新旧标记都认）；
 *   2. 早期 dsh-lan-open 脚本留下的条目；
 *   3. advanced-listening-settings.json 与 v1.x 的 web-advanced-settings.json；
 *   4. v1.x 留在 DSH 主目录的重启器 web-advanced-restart.cjs；
 *   5. 我们写 patch 时产生的 <cordis.patch.yml>.bak（--keep-backup 可保留）。
 *
 * 不碰：profile 的 package.json / node_modules（那是 pnpm 的事，卸载命令自己会清）、
 * 用户自己在 cordis.patch.yml 里写的条目、其它插件的任何文件。
 * 注意：.bak 是本插件每次改 patch 前写的安全网，默认会被删；想留就加 --keep-backup。
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { internals } from '../index.js'

const HELP = `完全清理 dsh-advanced-listening-settings 在磁盘上的残留。

用法：dsh-advanced-listening-cleanup [选项]

  --profile <名>   只清某个 profile（缺省：扫 profiles/ 下所有 profile）
  --home <目录>    DSH 主目录（缺省：$DSH_HOME，再缺省 ~/.dsh）
  --dry-run        只报告会删什么，不写盘
  --keep-backup    保留 cordis.patch.yml.bak（本插件写的安全网，默认删）
  -h, --help       显示本帮助
`

function parseArgs(argv) {
  const options = { profile: null, home: null, dryRun: false, keepBackup: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    // `npx <包名> cleanup` 会把动作名当位置参数传进来：忽略它。
    if (arg === 'cleanup') continue
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--keep-backup') options.keepBackup = true
    else if (arg === '--profile') options.profile = argv[++index] ?? null
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--home') options.home = argv[++index] ?? null
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length)
    else {
      console.error(`未知参数：${arg}\n`)
      console.error(HELP)
      process.exit(2)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(HELP)
  process.exit(0)
}

const home = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profilesRoot = join(home, 'profiles')
const actions = []
const errors = []

function act(kind, target) {
  actions.push({ kind, target })
}

function drop(path, kind) {
  if (!existsSync(path)) return
  if (!options.dryRun) {
    try {
      unlinkSync(path)
    } catch (error) {
      errors.push(`${path}: ${String(error?.message ?? error)}`)
      return
    }
  }
  act(kind, path)
}

function profiles() {
  if (typeof options.profile === 'string' && options.profile !== '') {
    const dir = resolve(profilesRoot, options.profile)
    return existsSync(dir) ? [dir] : []
  }
  if (!existsSync(profilesRoot)) return []
  return readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(profilesRoot, entry.name))
}

function readPatch(patchPath) {
  try {
    return readFileSync(patchPath, 'utf8')
  } catch {
    return ''
  }
}

function cleanProfile(profileDir) {
  const name = basename(profileDir)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const managed = existsSync(patchPath) ? internals.findManagedSpan(readPatch(patchPath)) : null
  if (managed !== null) {
    if (!options.dryRun) {
      try {
        internals.removeManagedBlock(patchPath)
      } catch (error) {
        errors.push(`${patchPath}: ${String(error?.message ?? error)}`)
      }
    }
    act('托管块', `${patchPath}（profile=${name}${managed.legacy ? '，v1.x 旧标记' : ''}）`)
  }

  if (existsSync(patchPath)) {
    let legacyCount = 0
    try {
      legacyCount = internals.findLegacyEntries(patchPath).length
    } catch (error) {
      errors.push(`${patchPath}: ${String(error?.message ?? error)}`)
    }
    if (legacyCount > 0) {
      if (!options.dryRun) {
        try {
          internals.removeLegacyEntries(patchPath)
        } catch (error) {
          errors.push(`${patchPath}: ${String(error?.message ?? error)}`)
        }
      }
      act('旧条目', `${patchPath}（${String(legacyCount)} 个）`)
    }
  }

  drop(join(profileDir, internals.SETTINGS_FILENAME), '设置文件')
  drop(join(profileDir, internals.LEGACY_SETTINGS_FILENAME), '旧设置文件')

  const backup = `${patchPath}.bak`
  if (!options.keepBackup) drop(backup, 'patch 备份（本插件写的安全网）')
}

for (const profileDir of profiles()) cleanProfile(profileDir)

// v1.x 曾把重启器写到 DSH 主目录；按文件头签名判断，绝不误删同名他人文件。
const helperPath = join(home, internals.LEGACY_RESTART_HELPER_FILENAME)
if (internals.isOurLegacyRestartHelper(home)) {
  if (!options.dryRun) {
    try {
      internals.removeLegacyRestartHelper(home)
    } catch (error) {
      errors.push(`${helperPath}: ${String(error?.message ?? error)}`)
    }
  }
  act('v1.x 重启器', helperPath)
}

const mode = options.dryRun ? '（--dry-run，未写盘）' : ''
if (actions.length === 0 && errors.length === 0) {
  console.log(`已经是干净的：${home} 下没有找到本插件的任何残留。${mode}`)
} else {
  console.log(`DSH 主目录：${home}${mode}`)
  for (const item of actions) console.log(`  · 已清理 ${item.kind}：${item.target}`)
}
for (const message of errors) console.error(`  ! 失败：${message}`)
if (errors.length > 0) process.exit(1)
