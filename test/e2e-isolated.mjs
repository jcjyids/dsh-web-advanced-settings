#!/usr/bin/env node
/**
 * e2e-isolated.mjs —— 隔离 profile 的端到端验收。
 *
 * 为什么必须隔离：改 webserver host/port 会热重载并重启 webserver 行，重启按钮
 * 更会 taskkill 整棵进程树。绝不能拿用户正在跑的 3080 实例做实验。
 *
 * 本脚本在工作区内的临时 DSH_HOME 里造一个 web profile（base + web-app + 本插件），
 * 用高位端口跑一个真实 dsh 实例，然后逐项验证：
 *   1. 默认仅回环 + token 鉴权（401 / 303+Cookie / 200）；
 *   2. 指定 IP：webserver 保持回环，插件为选中网卡建 TCP 直通监听；
 *   3. 全局 0.0.0.0：从「指定 IP」切过去不撞端口，Host/Origin 围栏仍拦未信任 Host；
 *   4. 取消鉴权：无 token 直接访问；未信任 Host 仍 403（围栏没被一起摘掉）；
 *   5. 改端口：无 --port 命令行固定时可热重载生效；
 *   6. 重启 dsh：设置跨重启保持，原 argv 拉起；
 *   7. 清理：移除托管块后补丁仍合法；
 *   8. 全程不碰正在运行的 3080 实例。
 *
 * 用法：node test/e2e-isolated.mjs
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const { internals } = await import(new URL('../index.js', import.meta.url).href)
const RUN_ID = `${String(Date.now())}-${String(process.pid)}`
const TMP = join(HERE, '.tmp', `e2e-${RUN_ID}`)
const TEST_HOME = join(TMP, 'dsh-home')
const PROFILE_DIR = join(TEST_HOME, 'profiles', 'web')
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')
const SETTINGS_PATH = join(PROFILE_DIR, 'advanced-listening-settings.json')

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

function log(...args) {
  console.log('  ·', ...args)
}

function section(title) {
  console.log(`\n[${title}]`)
}

/* ── 进程 / 网络工具 ── */

function findDshBin() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN
  // 先走零副作用的常见位置，避免为了 `npm root -g` 去 shell 里跑一次 npm。
  const guesses = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null,
    process.env.npm_config_prefix ? join(process.env.npm_config_prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null,
  ].filter((value) => value !== null)
  for (const guess of guesses) if (existsSync(guess)) return guess
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const root = spawnSync(npm, ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true })
  if (root.status === 0 && root.stdout.trim() !== '') {
    const candidate = join(root.stdout.trim(), '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('找不到 @deepseek-ai/dsh/lib/bin.js（可用 DSH_BIN 环境变量指定）')
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port
      server.close(() => resolvePromise(value))
    })
  })
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  else {
    try {
      process.kill(-Number(pid), 'SIGKILL')
    } catch {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  }
}

function request(options) {
  const { connectHost = '127.0.0.1', port, hostHeader, path: requestPath = '/', method = 'GET', headers = {}, cookie, body } = options
  return new Promise((resolvePromise, reject) => {
    const finalHeaders = { ...headers }
    if (hostHeader !== undefined) finalHeaders.Host = hostHeader
    if (cookie !== undefined) finalHeaders.Cookie = cookie
    if (body !== undefined) finalHeaders['content-length'] = Buffer.byteLength(body)
    const req = http.request({
      host: connectHost,
      port,
      path: requestPath,
      method,
      headers: finalHeaders,
      // 我们总是自己给 Host（围栏测试靠它），别让 Node 用连接地址覆盖。
      setHost: hostHeader === undefined,
      timeout: 20000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function waitFor(label, fn, timeoutMs = 40000, intervalMs = 350) {
  const started = Date.now()
  let lastMessage = ''
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastMessage = String(error?.message ?? error)
    }
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}${lastMessage === '' ? '' : `（最后错误：${lastMessage}）`}`)
    await sleep(intervalMs)
  }
}

function firstCookie(res) {
  const raw = res.headers['set-cookie']
  if (raw === undefined) return null
  const value = Array.isArray(raw) ? raw[0] : raw
  return value.split(';')[0]
}

function tokenFrom(textValue) {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(textValue)
  return match === null ? null : match[1]
}

function localIpv4() {
  const seen = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal === true) continue
      if (!seen.includes(entry.address)) seen.push(entry.address)
    }
  }
  return seen
}

/**
 * 把命令输出落到文件再读。
 * 受限沙箱里 Node 用管道捕获子进程输出会 EPERM，所以全程不用 pipe
 * （与重启器同一套做法）。
 */
function captureToFile(command, args) {
  const scratch = join(HERE, '.tmp')
  try {
    mkdirSync(scratch, { recursive: true })
  } catch {
    // 已存在
  }
  const tmp = join(scratch, `capture-${String(process.pid)}-${String(Date.now())}.txt`)
  let text = ''
  try {
    const fd = openSync(tmp, 'w')
    const out = spawnSync(command, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true })
    closeSync(fd)
    if (out.error) return ''
    text = readFileSync(tmp, 'utf8')
  } catch {
    text = ''
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // 不存在
    }
  }
  return text
}

/** 端口上真正处于 LISTENING 的进程 pid 列表（用于确认“换了新进程”）。 */
function listenerPids(portValue) {
  const pids = new Set()
  if (process.platform === 'win32') {
    const text = captureToFile('netstat', ['-ano', '-p', 'tcp'])
    for (const line of text.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      if (!(parts[1] || '').endsWith(':' + String(portValue))) continue
      if (/^\d+$/.test(parts[parts.length - 1])) pids.add(Number(parts[parts.length - 1]))
    }
  } else {
    const text = captureToFile('lsof', ['-ti', `tcp:${String(portValue)}`, '-sTCP:LISTEN'])
    for (const pid of text.split(/\s+/)) if (/^\d+$/.test(pid)) pids.add(Number(pid))
  }
  return [...pids]
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/* ── 主流程 ── */

let passed = 0
let failed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  PASS  ${name}`)
}

let child = null
let port = null
let cookie = null
let token = null
let dshBin = null

async function main() {
  section('环境准备')
  dshBin = findDshBin()
  log('dsh bin：' + dshBin)

  // Windows 释放句柄有延迟，上一次运行可能留下一个空目录：开跑前统一扫掉，
  // 保证 test/.tmp 不会随运行次数累积垃圾。
  try {
    const tmpRoot = join(HERE, '.tmp')
    for (const entry of readdirSync(tmpRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('e2e-')) continue
      spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', join(tmpRoot, entry.name)], { stdio: 'ignore', windowsHide: true })
      log('已扫掉上一次运行遗留的 ' + entry.name)
    }
  } catch {
    // 目录不存在 / 扫描失败都不影响本次运行
  }

  const liveBefore = await request({ port: 3080, hostHeader: '127.0.0.1:3080', path: '/' }).catch(() => null)
  log('运行中的 3080 实例状态：' + (liveBefore === null ? '不可达（可能没在跑）' : String(liveBefore.status)))

  port = await freePort()
  const lanIps = localIpv4()
  assert.ok(lanIps.length > 0, '本机没有非回环 IPv4，无法测试局域网功能')
  const lanIp = lanIps[0]
  const otherIp = lanIps[1] ?? null
  log(`测试端口 ${String(port)}，局域网 IP ${lanIp}${otherIp === null ? '' : `，其它 IP ${otherIp}`}`)

  mkdirSync(join(PROFILE_DIR, 'node_modules'), { recursive: true })
  writeFileSync(join(PROFILE_DIR, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-advanced-listening-settings': `link:${PLUGIN_DIR}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-advanced-listening-settings'], patchReload: 'live' } },
  }, null, 2)}\n`)
  // 预置一个把默认端口挪到高位端口的 webserver 补丁；这样启动时不用 --port，
  // 插件才能演示“改端口”热重载（命令行 --port 会永久压过插件）。
  writeFileSync(PATCH_PATH, [
    '# e2e 预置：把默认端口挪开，避免与真实实例的 3080 冲突',
    '- id: webserver',
    '  inject: [webStartup]',
    '  config:',
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    `    port: !!js ctx.webStartup.port ?? ${String(port)}`,
    '    compression: gzip',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
    '',
    // 顺便预置一段 v1.x 旧标记的托管块 + 旧设置文件，验证改名后的自愈迁移。
    internals.LEGACY_MANAGED_BEGIN,
    '- id: webserver',
    '  inject: [webStartup]',
    '  config:',
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    `    port: !!js ctx.webStartup.port ?? ${String(port)}`,
    '    compression: gzip',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
    internals.LEGACY_MANAGED_END,
    '',
  ].join('\n'))
  writeFileSync(join(PROFILE_DIR, internals.LEGACY_SETTINGS_FILENAME), `${JSON.stringify({ mode: 'loopback', ips: [], port, disableAuth: false }, null, 2)}\n`)

  const linkPath = join(PROFILE_DIR, 'node_modules', 'dsh-advanced-listening-settings')
  try {
    symlinkSync(PLUGIN_DIR, linkPath, 'junction')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }

  section('启动隔离实例')
  // 受限沙箱不允许 Node 用管道捕获子进程 stdio（EPERM），所以子进程输出
  // 重定向到文件，再用 readFileSync 读——这也是重启器一贯的做法。
  const outputPath = join(TMP, 'instance-launch.log')
  const outputFd = openSync(outputPath, 'a')
  const readOutput = () => {
    try {
      return readFileSync(outputPath, 'utf8')
    } catch {
      return ''
    }
  }
  child = spawn(process.execPath, [dshBin, 'web', '--no-open'], {
    // CWD 放在临时目录之外：重启器会按“原命令 + 原 CWD”拉起新实例，
    // 若 CWD 落在 TMP 里，Windows 会因为“目录是某进程的当前目录”而删不掉。
    cwd: PLUGIN_DIR,
    env: { ...process.env, DSH_HOME: TEST_HOME },
    stdio: ['ignore', outputFd, outputFd],
    windowsHide: true,
  })
  closeSync(outputFd)
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) log(`隔离实例退出 code=${String(code)} signal=${String(signal)}`)
  })

  try {
    await waitFor('隔离实例 HTTP 就绪', async () => {
      const res = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/' })
      return res.status === 401 || res.status === 200 || res.status === 303
    }, 120000)
  } catch (error) {
    console.error(readOutput().slice(-4000))
    throw error
  }
  token = tokenFrom(readOutput())
  assert.ok(token !== null, '启动输出里没有拿到 launch token')
  log('已拿到 launch token（' + String(token.length) + ' 字符）')

  section('1. 默认：仅回环 + token 鉴权')
  const anon = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/' })
  check('无 token 访问 / → 401', () => assert.equal(anon.status, 401))

  const exchange = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: `/?token=${encodeURIComponent(token)}` })
  check('带 token 访问 / → 303 换 Cookie', () => {
    assert.equal(exchange.status, 303)
    cookie = firstCookie(exchange)
    assert.ok(cookie !== null && cookie.length > 0, '没有拿到 Cookie')
  })
  const home = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/', cookie })
  check('带 Cookie 访问 / → 200', () => assert.equal(home.status, 200))

  const state0 = JSON.parse((await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/advanced-listening/state', cookie })).body)
  check('默认 desired = loopback / 3080 语义 / 免鉴权关', () => {
    assert.equal(state0.desired.mode, 'loopback')
    assert.equal(state0.effective.host, '127.0.0.1')
    assert.equal(state0.desired.disableAuth, false)
    assert.equal(state0.profile, 'web')
    assert.equal(state0.profileSource, 'ctx.baseUrl')
    assert.equal(resolve(state0.settingsPath), resolve(SETTINGS_PATH))
  })

  const spoofHost = await request({ port, hostHeader: 'evil.example', path: '/advanced-listening/state', cookie })
  check('未信任 Host 访问 /advanced-listening/state → 403（围栏生效）', () => assert.equal(spoofHost.status, 403))

  section('1.5 v1.x → v2 自愈迁移（改名/换存储格式后不留残渣）')
  check('旧设置文件被迁移成新文件名，旧文件删除', () => {
    assert.ok(existsSync(SETTINGS_PATH), '新设置文件应已生成')
    assert.ok(!existsSync(join(PROFILE_DIR, internals.LEGACY_SETTINGS_FILENAME)), '旧设置文件应已删除')
    const migrated = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    assert.equal(migrated.port, port)
    assert.equal(migrated.mode, 'loopback')
    assert.equal(state0.cleanup.legacySettingsExists, false, '状态里不应再报告旧设置文件')
  })
  check('旧托管块标记被升级成新标记（只留一段）', () => {
    const patchText = readFileSync(PATCH_PATH, 'utf8')
    assert.ok(!patchText.includes('dsh-web-advanced-settings 托管块'), '旧标记应已被升级')
    assert.equal(patchText.split(internals.MANAGED_BEGIN).length - 1, 1, '应只剩一段新托管块')
  })
  check('DSH 主目录没有 v1.x 重启器残留', () => {
    assert.ok(!existsSync(join(TEST_HOME, internals.LEGACY_RESTART_HELPER_FILENAME)))
  })

  section('2. 指定 IP：直通监听')
  async function getState() {
    const res = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/advanced-listening/state', cookie })
    return JSON.parse(res.body)
  }
  async function save(payload) {
    try {
      await request({
        port, hostHeader: `127.0.0.1:${String(port)}`, path: '/advanced-listening/save', method: 'POST', cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      // 热重载会掐断响应，靠后续轮询状态兜底
    }
  }

  await save({ mode: 'ips', ips: [lanIp], port, disableAuth: false })
  const stateIps = await waitFor('直通监听建立', async () => {
    const state = await getState()
    return state.frontDoor.some((entry) => entry.address === lanIp && entry.state === 'listening') ? state : null
  })
  check('指定 IP 模式：webserver 仍在回环，直通监听指向该 IP', () => {
    assert.equal(stateIps.effective.host, '127.0.0.1')
    assert.ok(stateIps.frontDoor.some((entry) => entry.address === lanIp && entry.state === 'listening'))
  })

  const lanTokenExchange = await request({
    connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`,
    path: `/?token=${encodeURIComponent(token)}`,
  })
  let lanCookie = null
  check('从局域网 IP 带 token 访问 → 303（直通链路可用）', () => {
    assert.equal(lanTokenExchange.status, 303)
    lanCookie = firstCookie(lanTokenExchange)
    assert.ok(lanCookie !== null)
  })
  const lanIndex = await request({ connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`, path: '/', cookie: lanCookie })
  check('从局域网 IP 带 Cookie 访问 / → 200', () => assert.equal(lanIndex.status, 200))

  if (otherIp !== null) {
    let refused = false
    try {
      await request({ connectHost: otherIp, port, hostHeader: `${otherIp}:${String(port)}`, path: '/' })
    } catch {
      refused = true
    }
    check(`未勾选的 ${otherIp} 连接被拒`, () => assert.equal(refused, true))
  } else {
    log('只有一个非回环 IPv4，跳过“未勾选地址被拒”用例')
  }

  section('2.5 远程访问兼容（Host/Origin 规范化 + 宿主面提示）')
  const whoami = await request({
    connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`, path: '/advanced-listening/whoami', cookie: lanCookie,
    headers: { Origin: `http://${lanIp}:${String(port)}`, 'Sec-Fetch-Site': 'cross-site' },
  })
  const who = JSON.parse(whoami.body)
  check('局域网请求被改写成回环权威（含 Origin 与 Sec-Fetch-Site）', () => {
    assert.equal(whoami.status, 200)
    assert.equal(who.host, `127.0.0.1:${String(port)}`)
    assert.equal(who.origin, `http://127.0.0.1:${String(port)}`)
    assert.equal(who.secFetchSite, 'same-origin')
    assert.equal(who.loopbackAuthority, true)
    assert.equal(who.ingressRewrite, true)
  })
  check('改写后 dsh-plugin 市场 isSameOrigin 判定通过（POST 不再瞬间 403“不可达”）', () => {
    const url = new URL(who.origin)
    const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]'])
    assert.equal(url.host === who.host && localHostnames.has(url.hostname), true)
  })
  const evilWho = await request({ port, hostHeader: 'evil.example', path: '/advanced-listening/whoami', cookie })
  check('未信任 Host 仍被围栏拒绝（DNS rebinding 防线未破）', () => assert.equal(evilWho.status, 403))
  const indexHtml = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/', cookie })
  check('index 头部注入宿主面提示（__DSH_TRANSPORT__.ownsHost）', () => {
    assert.equal(indexHtml.status, 200)
    assert.ok(indexHtml.body.includes('__DSH_TRANSPORT__'), 'index 未包含宿主面提示脚本')
    assert.ok(indexHtml.body.includes('ownsHost'), 'index 未包含 ownsHost 断言')
  })

  section('3. 全局监听（0.0.0.0）')
  await save({ mode: 'all', ips: [], port, disableAuth: false })
  const stateAll = await waitFor('webserver 重新绑定 0.0.0.0', async () => {
    const state = await getState()
    return state.effective.host === '0.0.0.0' ? state : null
  })
  check('切到 0.0.0.0 后直通监听已撤、绑定生效', () => {
    assert.equal(stateAll.effective.host, '0.0.0.0')
    assert.equal(stateAll.frontDoor.length, 0)
  })
  const lanAnonAll = await request({ connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`, path: '/' })
  check('全局监听 + 鉴权开启：局域网无 token → 401', () => assert.equal(lanAnonAll.status, 401))
  const lanTokenAll = await request({
    connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`,
    path: `/?token=${encodeURIComponent(token)}`,
  })
  const lanCookieAll = firstCookie(lanTokenAll)
  const lanIndexAll = await request({ connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`, path: '/', cookie: lanCookieAll })
  check('全局监听 + 鉴权开启：局域网带 token/Cookie → 200', () => {
    assert.equal(lanTokenAll.status, 303)
    assert.equal(lanIndexAll.status, 200)
  })
  const whoAll = await request({
    connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`, path: '/advanced-listening/whoami', cookie: lanCookieAll,
    headers: { Origin: `http://${lanIp}:${String(port)}` },
  })
  check('0.0.0.0 模式下入口改写同样生效（不依赖直通链路）', () => {
    assert.equal(whoAll.status, 200)
    assert.equal(JSON.parse(whoAll.body).host, `127.0.0.1:${String(port)}`)
  })

  section('4. 取消鉴权（Host/Origin 围栏保留）')
  await save({ mode: 'all', ips: [], port, disableAuth: true })
  await waitFor('免鉴权生效', async () => {
    const state = await getState()
    return state.effective.authBypass === true ? state : null
  })
  const noAuthIndex = await request({ connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`, path: '/' })
  check('免鉴权：局域网无 token 访问 / → 200', () => assert.equal(noAuthIndex.status, 200))
  const noAuthApi = await request({
    connectHost: lanIp, port, hostHeader: `${lanIp}:${String(port)}`, path: '/api', method: 'POST',
    headers: { 'content-type': 'application/json', Origin: `http://${lanIp}:${String(port)}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'e2e', method: 'nope', payload: {} }),
  })
  check('免鉴权：/api 不再 401/403（真正放行）', () => {
    assert.notEqual(noAuthApi.status, 401)
    assert.notEqual(noAuthApi.status, 403)
  })
  const noAuthSpoof = await request({ port, hostHeader: 'evil.example', path: '/' })
  check('免鉴权：未信任 Host 访问 / 仍 403（围栏没被摘掉）', () => assert.equal(noAuthSpoof.status, 403))
  const noAuthSpoofApi = await request({ port, hostHeader: 'evil.example', path: '/api', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check('免鉴权：未信任 Host 访问 /api 仍 403', () => assert.equal(noAuthSpoofApi.status, 403))

  section('5. 改端口（无 --port 固定）')
  const port2 = await freePort()
  await save({ mode: 'all', ips: [], port: port2, disableAuth: true })
  const oldPort = port
  port = port2
  cookie = null
  await waitFor('新端口就绪', async () => {
    const res = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/' })
    return res.status === 200 ? res : null
  }, 60000)
  const statePort = await waitFor('状态反映新端口', async () => {
    const res = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/advanced-listening/state' })
    const state = JSON.parse(res.body)
    return state.effective.port === port2 && state.desired.port === port2 ? state : null
  }, 60000)
  check('端口热重载到 ' + String(port2) + '，托管块同步', () => {
    assert.equal(statePort.effective.port, port2)
    const patchText = readFileSync(PATCH_PATH, 'utf8')
    assert.ok(patchText.includes(`?? ${String(port2)}`), '托管块端口没有更新')
    assert.ok(patchText.includes('>>> dsh-advanced-listening-settings 托管块'), '托管块应已写入')
  })
  let oldPortClosed = false
  try {
    await request({ port: oldPort, hostHeader: `127.0.0.1:${String(oldPort)}`, path: '/' })
  } catch {
    oldPortClosed = true
  }
  check('旧端口已释放', () => assert.equal(oldPortClosed, true))

  section('6. 重启 dsh（设置跨重启保持）')
  const restartLog = join(TEST_HOME, 'logs', `dsh-web-${String(port)}.log`)
  const oldPid = child.pid
  const oldListeners = listenerPids(port)
  const restartResponse = await request({
    port, hostHeader: `127.0.0.1:${String(port)}`, path: '/advanced-listening/restart', method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
  })
  check('POST /advanced-listening/restart → 200', () => assert.equal(restartResponse.status, 200))

  // 关键：必须等“端口上的 LISTENING 进程换人”。旧实例在优雅退出前还会响应
  // 一段时间，若只等 HTTP 就绪会读到旧实例——那是假通过。
  const newPid = await waitFor('新实例接管端口', () => {
    const fresh = listenerPids(port).find((pid) => pid !== oldPid && !oldListeners.includes(pid))
    return fresh === undefined ? null : fresh
  }, 120000, 500)
  check('端口监听进程已更换（真重启）', () => assert.notEqual(newPid, oldPid))
  check('旧实例进程已退出', () => assert.equal(processAlive(oldPid), false))

  const stateAfterRestart = await waitFor('重启后状态可读', async () => {
    const res = await request({ port, hostHeader: `127.0.0.1:${String(port)}`, path: '/advanced-listening/state' })
    return res.status === 200 ? JSON.parse(res.body) : null
  }, 60000)
  check('重启后设置保持：mode=all、免鉴权开、端口不变', () => {
    assert.equal(stateAfterRestart.desired.mode, 'all')
    assert.equal(stateAfterRestart.desired.disableAuth, true)
    assert.equal(stateAfterRestart.desired.port, port2)
    assert.equal(stateAfterRestart.effective.host, '0.0.0.0')
    assert.equal(stateAfterRestart.effective.port, port2)
  })
  check('设置文件已落盘', () => {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    assert.equal(saved.mode, 'all')
    assert.equal(saved.disableAuth, true)
    assert.equal(saved.port, port2)
  })
  check('重启日志记录了重新拉起', () => {
    assert.ok(existsSync(restartLog), '缺少重启日志：' + restartLog)
    assert.ok(readFileSync(restartLog, 'utf8').includes('重新启动 dsh'), '重启日志没有拉起记录')
  })

  section('7. 清理与卸载回退')
  const cleanup = await request({
    port, hostHeader: `127.0.0.1:${String(port)}`, path: '/advanced-listening/cleanup', method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, action: 'remove-managed' }),
  })
  check('移除托管块 → 200 且补丁依然合法', () => {
    assert.equal(cleanup.status, 200)
    const patchText = readFileSync(PATCH_PATH, 'utf8')
    assert.ok(!patchText.includes('>>> dsh-advanced-listening-settings 托管块'), '托管块应已被移除')
    assert.ok(patchText.includes('- id: webserver') || patchText.includes('[]'), '补丁应仍有合法内容')
  })

  const purge = await request({
    port, hostHeader: `127.0.0.1:${String(port)}`, path: '/advanced-listening/cleanup', method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, action: 'purge' }),
  })
  check('完全清理（purge）→ 设置文件与托管块全消失', () => {
    assert.equal(purge.status, 200)
    const payload = JSON.parse(purge.body)
    assert.equal(payload.cleanup.settingsExists, false, '设置文件应已删除')
    assert.equal(payload.cleanup.pristine, true, '清理后必须报告“已是出厂态”')
    assert.ok(!existsSync(SETTINGS_PATH), '设置文件仍在磁盘上')
    assert.ok(!readFileSync(PATCH_PATH, 'utf8').includes('托管块'), '托管块仍在')
  })
  check('v2 不在 DSH 主目录留下任何重启器文件（内联 -e）', () => {
    assert.ok(!existsSync(join(TEST_HOME, internals.LEGACY_RESTART_HELPER_FILENAME)), '不应该出现 v1.x 的重启器文件')
    const entries = readdirSync(TEST_HOME).filter((name) => /restart/i.test(name))
    assert.equal(entries.length, 0, 'DSH 主目录不应有 restart 相关文件：' + entries.join(','))
  })

  section('8. 真实实例未受影响')
  if (liveBefore !== null) {
    const liveAfter = await request({ port: 3080, hostHeader: '127.0.0.1:3080', path: '/' }).catch(() => null)
    check('3080 实例仍在正常响应', () => {
      assert.ok(liveAfter !== null && [200, 303, 401].includes(liveAfter.status), `3080 状态异常：${liveAfter === null ? 'unreachable' : String(liveAfter.status)}`)
    })
  } else {
    log('3080 实例本来就不在跑，跳过')
  }

  // 交付时需要一个“活着”的页面地址做视觉复核：E2E_KEEP_ALIVE=1 时保持实例运行，
  // 打印地址后挂起，直到外部 job_kill / Ctrl+C。
  if (process.env.E2E_KEEP_ALIVE === '1' && port !== null) {
    console.log(`\nKEEPALIVE_URL=http://127.0.0.1:${String(port)}/`)
    console.log('（E2E_KEEP_ALIVE=1：实例保持存活，供无头浏览器截图；结束请 job_kill 本任务）')
    // 用 ref 的 interval 顶住事件循环：不能让 Node 因为“没有活动句柄”自行退出。
    await new Promise(() => {
      setInterval(() => {}, 60000)
    })
  }
}

/* ── 入口与清理 ── */

try {
  await main()
} catch (error) {
  failed += 1
  console.error(`\n  FAIL  ${String(error?.stack ?? error)}`)
} finally {
  section('清理')
  if (child !== null && child.exitCode === null) {
    killTree(child.pid)
    log('已终止隔离实例 pid=' + String(child.pid))
  }
  // 重启后的新实例不在 child.pid 的进程树里，必须按端口补杀。
  if (port !== null) {
    const killed = listenerPids(port)
    for (const pid of killed) {
      killTree(pid)
      log(`已终止端口 ${String(port)} 上的实例 pid=${String(pid)}`)
    }
    // 进程的 CWD 就在临时目录里，必须等它真正退出，否则 Windows 删不掉目录。
    for (const pid of killed) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!processAlive(pid)) break
        await sleep(250)
      }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (listenerPids(port).length === 0) break
      await sleep(300)
    }
  }
  await sleep(500)
  // Windows 上 Node 的 rmSync 对一堆 junction 的目录树会 EPERM；交给 cmd rmdir 处理。
  // 刚被杀掉的实例偶尔会在删除后把 logs/ 再建回来，所以删完要“静置一下再确认”。
  const removeTree = () => {
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', TMP], { stdio: 'ignore', windowsHide: true })
    else spawnSync('rm', ['-rf', TMP], { stdio: 'ignore' })
    return !existsSync(TMP)
  }
  let removed = false
  for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
    if (!removeTree()) {
      await sleep(800)
      continue
    }
    await sleep(700)
    removed = !existsSync(TMP)
  }
  if (!removed) {
    // 刚退出的实例偶尔还会把空的 logs/ 再建一次；静置后再补一刀。
    await sleep(1800)
    removed = removeTree()
  }
  log(removed ? '已删除临时目录 ' + TMP : '临时目录清理失败（可手工删除）：' + TMP)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
