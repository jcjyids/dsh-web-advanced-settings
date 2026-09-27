#!/usr/bin/env node
/**
 * patch-rewrite.test.mjs —— 组合层补丁（cordis.patch.yml）改写的离线自测。
 *
 * 覆盖点：
 *   · 托管块文本严格复述官方 webserver 行的 5 个 config 键；
 *   · 模板 `[]` / 已有条目 / 已有托管块 三种落盘形态；
 *   · 幂等写入、移除后文档仍是合法补丁数组；
 *   · CRLF 文件的行偏移不漂移（v1.0.0 的老 bug）。
 *
 * 有 js-yaml 时做真实 YAML 解析校验（!!js 标签按官方 dialect 注册），
 * 找不到 js-yaml 时退化为结构化校验并在末尾提示。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const TMP = join(HERE, '.tmp', `patch-${String(process.pid)}`)

const { internals } = await import(new URL('../index.js', import.meta.url).href)

/* ── 真实 YAML 校验（可用时） ── */

function findModuleDir(name) {
  const roots = []
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'profiles', 'node_modules'))
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  if (process.env.DSH_INSTALL_DIR) roots.push(join(process.env.DSH_INSTALL_DIR, 'node_modules'))
  let dir = process.cwd()
  for (let index = 0; index < 10; index += 1) {
    roots.push(join(dir, 'node_modules'))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const root of roots) {
    const candidate = join(root, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

function loadYaml() {
  const dir = findModuleDir('js-yaml')
  if (dir === null) return null
  try {
    const require = createRequire(join(dir, 'package.json'))
    return require(dir)
  } catch {
    return null
  }
}

const yaml = loadYaml()
const JsExpr = yaml === null ? null : new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const YAML_SCHEMA = yaml === null ? null : yaml.JSON_SCHEMA.extend(JsExpr)

/** 解析 patch 文本；没有 js-yaml 时返回 undefined 表示“只做结构检查”。 */
function parsePatch(text) {
  if (yaml === null) return undefined
  return yaml.load(text, { schema: YAML_SCHEMA })
}

/** 结构化兜底：顶层必须是块序列，且不与 `[]` 共存。 */
function assertStructuralPatch(text) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
  const significant = lines.map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  assert.ok(!significant.includes('[]'), '块序列文档里不能再出现 [] 字面量')
  assert.ok(significant.some((line) => line.startsWith('- ') || line === '-'), '文档里应至少有一个顶层条目')
  for (const line of significant) {
    assert.ok(!/^\s{0,1}\S/.test(line) || line.startsWith('- ') || line.startsWith('-') || /^[\w"'@.-]+:/.test(line),
      `可疑的非序列行：${line}`)
  }
}

function checkPatch(text) {
  const parsed = parsePatch(text)
  if (parsed === undefined) assertStructuralPatch(text)
  else {
    assert.ok(Array.isArray(parsed), '补丁文档必须是顶层数组')
    for (const entry of parsed) assert.ok(entry !== null && typeof entry === 'object' && !Array.isArray(entry), '每个补丁条目必须是映射')
  }
  return parsed
}

function freshProfile(patchText) {
  mkdirSync(TMP, { recursive: true })
  const dir = join(TMP, `p-${String(Math.random()).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, patchText)
  return patchPath
}

const TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${name}\n        ${String(error?.stack ?? error).split('\n').join('\n        ')}`)
  }
}

console.log(`patch-rewrite.test.mjs（js-yaml: ${yaml === null ? '未找到，结构化校验' : '已加载'}）`)

await test('renderManagedBlock 复述官方 webserver 的 5 个 config 键', () => {
  const block = internals.renderManagedBlock('0.0.0.0', 9000)
  for (const key of ['host:', 'port:', 'compression:', 'compressionLevel:', 'compressionThresholdBytes:']) {
    assert.ok(block.includes(key), `托管块缺少 ${key}`)
  }
  assert.ok(block.includes("host: !!js ctx.webStartup.host ?? '0.0.0.0'"))
  assert.ok(block.includes('port: !!js ctx.webStartup.port ?? 9000'))
  assert.ok(block.includes('inject: [webStartup]'))
  assert.throws(() => internals.renderManagedBlock('192.168.1.5', 3080), /非法监听地址/)
  assert.throws(() => internals.renderManagedBlock('0.0.0.0', 70000), /非法端口/)
})

await test('模板 [] → 写入托管块后是合法补丁数组且不含 []', () => {
  const patchPath = freshProfile(TEMPLATE)
  const result = internals.writeManagedBlock(patchPath, '0.0.0.0', 3080)
  assert.equal(result.changed, true)
  const text = readFileSync(patchPath, 'utf8')
  checkPatch(text)
  assert.ok(text.includes(internals.renderManagedBlock('0.0.0.0', 3080)))
  const parsed = parsePatch(text)
  if (parsed !== undefined) assert.equal(parsed.length, 1)
  assert.ok(!text.split('\n').some((line) => line.trim() === '[]'))
})

await test('重复写入同一绑定是幂等的', () => {
  const patchPath = freshProfile(TEMPLATE)
  internals.writeManagedBlock(patchPath, '0.0.0.0', 3080)
  const first = readFileSync(patchPath, 'utf8')
  const second = internals.writeManagedBlock(patchPath, '0.0.0.0', 3080)
  assert.equal(second.changed, false)
  assert.equal(readFileSync(patchPath, 'utf8'), first)
})

await test('已有用户条目时追加托管块并保留原条目', () => {
  const existing = [
    '# 用户自己的补丁层',
    '- id: system-prompt',
    '  config:',
    "    personaSuffix: 'hello'",
    '',
  ].join('\n')
  const patchPath = freshProfile(existing)
  internals.writeManagedBlock(patchPath, '127.0.0.1', 3080)
  const text = readFileSync(patchPath, 'utf8')
  const parsed = checkPatch(text)
  assert.ok(text.includes('- id: system-prompt'))
  if (parsed !== undefined) {
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0].id, 'system-prompt')
    assert.equal(parsed[1].id, 'webserver')
  }
})

await test('替换已有托管块不会重复堆叠', () => {
  const patchPath = freshProfile(TEMPLATE)
  internals.writeManagedBlock(patchPath, '0.0.0.0', 3080)
  internals.writeManagedBlock(patchPath, '127.0.0.1', 4567)
  const text = readFileSync(patchPath, 'utf8')
  assert.equal(text.split('>>> dsh-advanced-listening-settings 托管块').length - 1, 1)
  const parsed = checkPatch(text)
  if (parsed !== undefined) assert.equal(parsed.length, 1)
  assert.ok(text.includes("host: !!js ctx.webStartup.host ?? '127.0.0.1'"))
  assert.ok(text.includes('port: !!js ctx.webStartup.port ?? 4567'))
})

await test('removeManagedBlock：纯托管块文档恢复为 []', () => {
  const patchPath = freshProfile(TEMPLATE)
  internals.writeManagedBlock(patchPath, '0.0.0.0', 3080)
  assert.equal(internals.removeManagedBlock(patchPath), true)
  const text = readFileSync(patchPath, 'utf8')
  assert.ok(!text.includes('托管块'))
  const parsed = parsePatch(text)
  if (parsed !== undefined) assert.deepEqual(parsed, [])
  else assert.ok(text.split('\n').some((line) => line.trim() === '[]'))
})

await test('removeManagedBlock：保留用户条目', () => {
  const existing = ['- id: system-prompt', '  config:', "    personaSuffix: 'hello'", ''].join('\n')
  const patchPath = freshProfile(existing)
  internals.writeManagedBlock(patchPath, '0.0.0.0', 3080)
  assert.equal(internals.removeManagedBlock(patchPath), true)
  const text = readFileSync(patchPath, 'utf8')
  const parsed = checkPatch(text)
  assert.ok(text.includes('- id: system-prompt'))
  if (parsed !== undefined) assert.equal(parsed.length, 1)
})

await test('CRLF 补丁：行偏移不漂移，旧条目能被识别且托管块不被误删', () => {
  const crlf = [
    '# 文件头注释',
    '- id: system-prompt',
    '  config:',
    "    personaSuffix: 'hi'",
    '# dsh-lan-open：旧脚本留下的条目',
    '- id: lan-open-legacy',
    '  config:',
    '    host: 0.0.0.0',
    '',
  ].join('\r\n')
  const patchPath = freshProfile(crlf)
  internals.writeManagedBlock(patchPath, '0.0.0.0', 3080)
  const before = readFileSync(patchPath, 'utf8')
  const legacy = internals.findLegacyEntries(patchPath)
  assert.equal(legacy.length, 1, '应找到 1 个旧条目')
  assert.ok(legacy[0].text.includes('lan-open-legacy'))
  assert.ok(!legacy[0].text.includes('托管块'), '托管块标记行不能被当成旧条目')
  const result = internals.removeLegacyEntries(patchPath)
  assert.equal(result.removed, 1)
  const after = readFileSync(patchPath, 'utf8')
  assert.ok(!after.includes('lan-open-legacy'))
  assert.ok(after.includes('>>> dsh-advanced-listening-settings 托管块'), '托管块必须原样保留')
  assert.ok(before.includes('lan-open-legacy'))
  checkPatch(after)
})

await test('splitPatchGroups 把文件头注释算进第一个组', () => {
  const content = ['# header', '# header2', '- id: a', '  x: 1', '', '- id: b', '  y: 2', ''].join('\n')
  const { groups } = internals.splitPatchGroups(content)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].headStart, 0)
  assert.ok(groups[0].text.startsWith('# header'))
  assert.equal(groups[1].headStart, groups[1].bodyStart)
})

/* ── v2.0.0：默认态零残留的判定 + v1.x 旧标记迁移 ── */

await test('isDefaultDesiredState：只有全默认才算出厂态', () => {
  const base = { mode: 'loopback', ips: [], port: 3080, disableAuth: false }
  assert.equal(internals.isDefaultDesiredState(base), true)
  assert.equal(internals.isDefaultDesiredState({ ...base, port: 4000 }), false, '非默认端口必须落盘')
  assert.equal(internals.isDefaultDesiredState({ ...base, mode: 'all' }), false)
  assert.equal(internals.isDefaultDesiredState({ ...base, mode: 'ips', ips: ['10.0.0.7'] }), false)
  assert.equal(internals.isDefaultDesiredState({ ...base, disableAuth: true }), false)
})

await test('needsManagedBlockFor：只在组合层默认值不够用时才写块', () => {
  const loopback = { mode: 'loopback', ips: [], port: 3080, disableAuth: false }
  const noCli = { cliPort: null, cliHost: null }
  assert.equal(internals.needsManagedBlockFor(loopback, noCli), false, '回环 + 默认端口不需要块')
  assert.equal(internals.needsManagedBlockFor({ ...loopback, port: 4000 }, noCli), true, '非默认端口需要块')
  assert.equal(internals.needsManagedBlockFor({ ...loopback, mode: 'all' }, noCli), true, '0.0.0.0 必须写块')
  assert.equal(internals.needsManagedBlockFor({ ...loopback, port: 4000 }, { ...noCli, cliPort: 4000 }), false, '命令行已钉端口时不需要块')
  assert.equal(internals.needsManagedBlockFor({ ...loopback, mode: 'all' }, { ...noCli, cliPort: 4000 }), true, '命令行钉端口也挡不住 host 改写')
  assert.equal(internals.isDefaultDesiredState({ ...loopback, mode: 'ips', ips: ['10.0.0.7'] }), false)
})

await test('v1.x 旧标记的托管块能被识别、升级成新标记、也能移除', () => {
  const legacyDoc = ['# 用户自己的补丁层', internals.LEGACY_MANAGED_BEGIN, '- id: webserver', '  config:', "    host: !!js ctx.webStartup.host ?? '0.0.0.0'", '    port: !!js ctx.webStartup.port ?? 3080', internals.LEGACY_MANAGED_END, ''].join('\n')
  const patchPath = freshProfile(legacyDoc)
  const span = internals.findManagedSpan(readFileSync(patchPath, 'utf8'))
  assert.ok(span !== null && span.legacy === true, '旧标记必须被识别为 legacy')
  assert.deepEqual(internals.readManagedBinding(patchPath), { host: '0.0.0.0', port: 3080 })

  internals.writeManagedBlock(patchPath, '0.0.0.0', 4000)
  const upgraded = readFileSync(patchPath, 'utf8')
  assert.ok(!upgraded.includes('dsh-web-advanced-settings 托管块'), '旧标记应被升级掉')
  assert.equal(upgraded.split(internals.MANAGED_BEGIN).length - 1, 1, '只应剩一段新托管块')
  checkPatch(upgraded)

  assert.equal(internals.removeManagedBlock(patchPath), true)
  const cleaned = readFileSync(patchPath, 'utf8')
  assert.ok(!cleaned.includes('托管块'))
  assert.ok(cleaned.includes('[]'), '清空后应补回空数组字面量')
  checkPatch(cleaned)
})

try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  // 清理失败不影响结果
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
