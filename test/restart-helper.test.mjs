#!/usr/bin/env node
/**
 * restart-helper.test.mjs —— 内联重启器自测。
 *
 * v2.0.0 起重启器**不落盘**：宿主用 `node -e <源码> stage1 <JSON>` 启动，
 * stage1 再用环境变量里的同一份源码孵化 stage2 并退出；由 stage2 杀旧进程、
 * 等端口释放、按原 argv 拉起新实例。这样宿主被 taskkill /T 连带清理时
 * 不会误杀重启器自己，同时 `~/.dsh` 下不再有任何 helper 文件。
 *
 * 本测试用真实 node 进程做一次完整交接：dummy 进程扮演“旧宿主”，
 * 新实例的 argv 换成一个只写 marker 文件的 -e 脚本。
 * 需要 netstat / taskkill（Windows）或 lsof（POSIX）。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '.tmp', `restart-${String(process.pid)}`)
const RESTART_SOURCE_ENV = 'DSH_ADVANCED_LISTENING_RESTART_SRC'
const { internals } = await import(new URL('../index.js', import.meta.url).href)

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

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolvePromise(port))
    })
  })
}

function waitForFile(file, timeoutMs) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (existsSync(file)) {
        clearInterval(timer)
        resolvePromise(true)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolvePromise(false)
      }
    }, 200)
  })
}

console.log('restart-helper.test.mjs')

await test('重启器源码语法合法（可直接被 node -e 执行），且确实包含两段式交接', () => {
  new vm.Script(internals.RESTART_HELPER_SOURCE, { filename: '[eval]' })
  const body = internals.RESTART_HELPER_SOURCE
  assert.ok(body.includes("stage === 'stage1'"))
  assert.ok(body.includes('stage2'))
  assert.ok(body.includes('listenersOnPort'))
  assert.ok(body.includes('taskkill') || body.includes('SIGTERM'))
  assert.ok(!body.includes("stdio: 'pipe'"), '重启器不应用管道，受限环境里会卡')
  assert.ok(!body.includes('__filename'), '内联执行没有 __filename，不能用它拼路径')
  assert.ok(body.includes(RESTART_SOURCE_ENV), '第二段必须复用环境变量里的同一份源码')
})

await test('源码按 -e 的 argv 约定取参（argv[1]=stage，argv[2]=payload）', () => {
  assert.ok(internals.RESTART_HELPER_SOURCE.includes('process.argv[1]'), 'stage 取 argv[1]')
  assert.ok(internals.RESTART_HELPER_SOURCE.includes('process.argv[2]'), 'payload 取 argv[2]')
})

await test('挂载路径不落任何 helper 文件（v2 零外部文件）', async () => {
  mkdirSync(TMP, { recursive: true })
  const before = readdirSync(TMP)
  assert.equal(before.length, 0, `临时目录一开始应为空：${before.join(',')}`)
  // internals 里不再有 ensureRestartHelper；确认旧接口确实已移除。
  assert.equal(internals.ensureRestartHelper, undefined, 'v2 不应再导出 ensureRestartHelper')
  assert.equal(typeof internals.removeLegacyRestartHelper, 'function', '必须提供旧重启器清理函数')
  assert.equal(internals.LEGACY_RESTART_HELPER_FILENAME, 'web-advanced-restart.cjs')
})

await test('removeLegacyRestartHelper 只删“确属我们”的旧文件', () => {
  mkdirSync(TMP, { recursive: true })
  const foreign = join(TMP, 'web-advanced-restart.cjs')
  // 非我们的文件：不动
  spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(foreign)}, 'someone else')`], { stdio: 'ignore' })
  assert.equal(internals.removeLegacyRestartHelper(TMP), null)
  assert.ok(existsSync(foreign), '别人的同名文件不能被删')
  // 我们的文件：删掉
  spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(foreign)}, '#!/usr/bin/env node\\n/* dsh-web-advanced-settings 重启器（由插件自动生成，请勿手工编辑） */\\n')`], { stdio: 'ignore' })
  assert.equal(internals.removeLegacyRestartHelper(TMP), foreign)
  assert.ok(!existsSync(foreign), 'v1.x 遗留的重启器应被清除')
})

await test('stage1 → stage2 → 新实例 完整交接（真实进程，无 helper 文件）', async () => {
  mkdirSync(TMP, { recursive: true })
  const marker = join(TMP, 'started.txt')
  const log = join(TMP, 'restart.log')
  const port = await freePort()

  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))

  const payload = {
    port,
    pid: dummy.pid,
    execPath: process.execPath,
    argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    cwd: TMP,
    log,
  }

  try {
    const result = spawnSync(
      process.execPath,
      ['-e', internals.RESTART_HELPER_SOURCE, 'stage1', JSON.stringify(payload)],
      { stdio: 'ignore', windowsHide: true, env: { ...process.env, [RESTART_SOURCE_ENV]: internals.RESTART_HELPER_SOURCE } },
    )
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, 'stage1 应立刻以 0 退出')
    const ok = await waitForFile(marker, 20000)
    const logText = existsSync(log) ? readFileSync(log, 'utf8') : '(无日志)'
    assert.ok(ok, `新实例没有按原 argv 被拉起。日志：\n${logText}`)
    assert.equal(readFileSync(marker, 'utf8'), 'started')
    assert.ok(/端口.*(已释放|等待超时)/.test(logText), `日志缺少端口等待记录：\n${logText}`)
  } finally {
    try {
      if (dummy.exitCode === null) dummy.kill()
    } catch {
      // 已被 taskkill 处理
    }
  }
})

try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  // 清理失败不影响结果
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
