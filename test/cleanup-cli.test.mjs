#!/usr/bin/env node
/**
 * cleanup-cli.test.mjs —— `bin/cleanup.mjs` 完全清理自测。
 *
 * 目标契约：卸载（pnpm remove）自己不跑我们的代码，所以磁盘残留必须靠
 * 这个独立 CLI 收回；而且它要在**插件已经不在本地**时也能跑。
 * 这里在临时 DSH_HOME 里造一份“被插件污染过”的 profile，验证：
 *   · --dry-run 只报告、不动盘；
 *   · 真跑会清掉托管块（新/旧标记）、旧条目、设置文件（新/旧）、旧重启器、.bak；
 *   · 用户自己写的条目与别人的同名文件绝不碰；
 *   · 重复运行是幂等的（第二次报“已经是干净的”）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TMP = join(HERE, '.tmp', `cleanup-${String(process.pid)}`)
const HOME = join(TMP, 'dsh-home')
const PROFILE = join(HOME, 'profiles', 'web')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const { internals } = await import(new URL('../index.js', import.meta.url).href)

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${name}\n        ${String(error?.stack ?? error).split('\n').join('\n        ')}`)
  }
}

/** 运行 CLI；把输出落文件再读，避免管道（受限环境里 spawnSync+pipe 会 EPERM）。 */
function runCli(args) {
  const log = join(TMP, `cli-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.log`)
  const fd = openSync(log, 'w')
  const result = spawnSync(process.execPath, [join(ROOT, 'bin', 'cleanup.mjs'), ...args], {
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    cwd: ROOT,
  })
  closeSync(fd)
  return { status: result.status, output: readFileSync(log, 'utf8') }
}

function seed() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  // 用户自己的条目 + 我们的托管块（新标记）
  const patch = [
    '# 用户自己的补丁层',
    '- id: some-plugin',
    '  config:',
    '    keep: true',
    '',
    internals.renderManagedBlock('0.0.0.0', 3080),
    '',
  ].join('\n')
  writeFileSync(PATCH, patch)
  writeFileSync(`${PATCH}.bak`, '# 用户自己的补丁层\n[]\n')
  writeFileSync(join(PROFILE, internals.SETTINGS_FILENAME), '{"mode":"all","ips":[],"port":3080,"disableAuth":true}\n')
  writeFileSync(join(PROFILE, internals.LEGACY_SETTINGS_FILENAME), '{"mode":"ips","ips":[],"port":3080,"disableAuth":false}\n')
  writeFileSync(join(HOME, internals.LEGACY_RESTART_HELPER_FILENAME), '#!/usr/bin/env node\n/* dsh-web-advanced-settings 重启器（由插件自动生成，请勿手工编辑） */\n')
  writeFileSync(join(HOME, 'unrelated.txt'), 'not ours\n')
}

console.log('cleanup-cli.test.mjs')

test('--dry-run 只报告，不动盘', () => {
  seed()
  const result = runCli(['--home', HOME, '--dry-run'])
  assert.equal(result.status, 0, result.output)
  assert.ok(result.output.includes('未写盘'), result.output)
  assert.ok(result.output.includes('托管块'), result.output)
  assert.ok(existsSync(join(PROFILE, internals.SETTINGS_FILENAME)), 'dry-run 不应删设置文件')
  assert.ok(existsSync(join(HOME, internals.LEGACY_RESTART_HELPER_FILENAME)), 'dry-run 不应删旧重启器')
  assert.ok(readFileSync(PATCH, 'utf8').includes('托管块'), 'dry-run 不应改 patch')
})

test('真跑：清掉托管块/设置文件/旧设置文件/旧重启器/.bak，保留用户条目', () => {
  seed()
  const result = runCli(['--home', HOME])
  assert.equal(result.status, 0, result.output)
  const patch = readFileSync(PATCH, 'utf8')
  assert.ok(!patch.includes('托管块'), `托管块应被移除：\n${patch}`)
  assert.ok(patch.includes('some-plugin'), '用户自己的条目必须保留')
  assert.ok(!existsSync(join(PROFILE, internals.SETTINGS_FILENAME)), '新设置文件应被删除')
  assert.ok(!existsSync(join(PROFILE, internals.LEGACY_SETTINGS_FILENAME)), '旧设置文件应被删除')
  assert.ok(!existsSync(join(HOME, internals.LEGACY_RESTART_HELPER_FILENAME)), '旧重启器应被删除')
  assert.ok(!existsSync(`${PATCH}.bak`), '.bak 应被删除')
  assert.ok(existsSync(join(HOME, 'unrelated.txt')), '别人的文件不能碰')
})

test('--keep-backup 保留 .bak', () => {
  seed()
  const result = runCli(['--home', HOME, '--keep-backup'])
  assert.equal(result.status, 0, result.output)
  assert.ok(existsSync(`${PATCH}.bak`), '.bak 应保留')
})

test('v1.x 旧标记的托管块也能清', () => {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  writeFileSync(PATCH, `# 用户自己的补丁层\n[]\n\n${internals.LEGACY_MANAGED_BEGIN}\n- id: webserver\n  config:\n    host: 0.0.0.0\n${internals.LEGACY_MANAGED_END}\n`)
  const result = runCli(['--home', HOME])
  assert.equal(result.status, 0, result.output)
  const patch = readFileSync(PATCH, 'utf8')
  assert.ok(!patch.includes('托管块'), `v1.x 托管块应被移除：\n${patch}`)
  assert.ok(patch.includes('[]'), '清空后文档应补回空数组字面量')
})

test('幂等：第二次运行报“已经是干净的”', () => {
  seed()
  assert.equal(runCli(['--home', HOME]).status, 0)
  const second = runCli(['--home', HOME])
  assert.equal(second.status, 0, second.output)
  assert.ok(second.output.includes('已经是干净的'), second.output)
})

test('别人的同名重启器不动（签名校验）', () => {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  const foreign = join(HOME, internals.LEGACY_RESTART_HELPER_FILENAME)
  writeFileSync(foreign, 'module.exports = 1\n')
  const result = runCli(['--home', HOME])
  assert.equal(result.status, 0, result.output)
  assert.ok(existsSync(foreign), '非我们的同名文件不能被删')
  assert.ok(result.output.includes('已经是干净的'), result.output)
})

test('未知参数给出用法并以 2 退出', () => {
  const result = runCli(['--nope'])
  assert.equal(result.status, 2)
  assert.ok(result.output.includes('用法'), result.output)
})

try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  // 清理失败不影响结果
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
