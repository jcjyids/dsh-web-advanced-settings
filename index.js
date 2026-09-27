/**
 * dsh-advanced-listening-settings —— 高级监听设置（宿主半边）
 *
 * 在 Web GUI 的「设置 → 高级监听设置」里提供：
 *   1. 全局监听（0.0.0.0）/ 指定本机 IP 监听 / 仅本机；
 *   2. 端口设置（命令行 --port 优先）；
 *   3. 取消 token 鉴权（保留 Host/Origin 围栏）；
 *   4. 重启 dsh（带二次确认）；
 *   5. 访问地址面板 + 旧配置清理。
 *
 * 三条技术事实决定了本文件的形态（均已对 dsh 0.1.5-rc.3 官方源码核对）：
 *   · 官方 webserver 的 host 只接受 127.0.0.1 / 0.0.0.0（schema 硬编码），
 *     所以“只监听某几个网卡 IP”必须由本插件自己建 TCP 直通监听；
 *   · host/port 是组合层（cordis.patch.yml）的配置，只有 Loader 读得到，
 *     因此改绑定必须落盘 + 热重载（或重启）才生效；
 *   · 鉴权在 HostConnectionService 上是两个公开方法（requestRejection /
 *     authorizeIndex），可以在实例上可逆地覆写，不需要改官方源码。
 *
 * 两处远程访问兼容改写（做法对齐社区 dsh-pocket）：
 *   · 入口头规范化：把“Host 是本机局域网 IP”的请求改写回 `127.0.0.1:<port>`
 *     （Host/Origin/Referer/Sec-Fetch-Site），否则 dsh-plugin 市场的
 *     `isSameOrigin()` 只认回环 Origin，所有 POST 会瞬间 403“不可达”；
 *   · index 头部注入 `__DSH_TRANSPORT__ = { ownsHost: true }`（仅在宿主未提供
 *     transport 时），让非回环页面在官方客户端里按宿主面处理，设置文档不再
 *     降级 memory，模型/凭据页可用；
 *   · 两者都只影响“从本机局域网地址进来”的请求，未知 Host 仍由官方围栏拒绝。
 *
 * 卸载可干净回退：
 *   · 重启器不落盘：用 `node -e <源码>` 两段式（源码经环境变量传给第二段），
 *     profile 之外不产生任何文件；
 *   · 默认态零残留：设置文件只在偏离默认时存在，回到默认自动删除；托管块只在
 *     真的需要（0.0.0.0 或非默认端口）时写入，不需要时自动移除；
 *   · 提供面板「完全清理」与 bin/cleanup.mjs（卸载前后都能跑）。
 *
 * @module dsh-advanced-listening-settings
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 稳定插件名（补丁行 id 与包名一致）。 */
export const name = 'advanced-listening-settings'
/** 硬依赖：没有 webServer 就没有可配置的对象。 */
export const inject = ['webServer']

const VERSION = '1.0.1'
const LOG_TAG = '[advanced-listening-settings]'
const ALL_INTERFACES = '0.0.0.0'
const LOOPBACK = '127.0.0.1'
const ROUTE_PREFIX = '/advanced-listening'
const SETTINGS_FILENAME = 'advanced-listening-settings.json'
const PATCH_FILENAME = 'cordis.patch.yml'
const BACKUP_SUFFIX = '.bak'
const MANAGED_BEGIN = '# >>> dsh-advanced-listening-settings 托管块：由「高级监听设置」页面维护，请勿手工编辑 >>>'
const MANAGED_END = '# <<< dsh-advanced-listening-settings 托管块 <<<'
/** v1.x 的托管块标记（旧装迁移：识别它、改写它、清理它）。 */
const LEGACY_MANAGED_BEGIN = '# >>> dsh-web-advanced-settings 托管块：由「高级 Web 设置」页面维护，请勿手工编辑 >>>'
const LEGACY_MANAGED_END = '# <<< dsh-web-advanced-settings 托管块 <<<'
/** v1.x 的状态文件名与（已废弃的）重启器文件名。 */
const LEGACY_SETTINGS_FILENAME = 'web-advanced-settings.json'
const LEGACY_RESTART_HELPER_FILENAME = 'web-advanced-restart.cjs'
const LEGACY_MARK = 'dsh-lan-open'
const DEFAULT_PORT = 3080
const MAX_BODY_BYTES = 64 * 1024
/** 内联重启器源码经此环境变量传给第二段（不再落盘任何 helper 文件）。 */
const RESTART_SOURCE_ENV = 'DSH_ADVANCED_LISTENING_RESTART_SRC'
/** 直通监听失败后的自动重试间隔与次数上限（覆盖热重载竞态窗口）。 */
const FRONTDOOR_RETRY_MS = 1200
const FRONTDOOR_RETRY_MAX = 12
/** 周期对账：兜住“webserver 已回环但插件没被热重载”的极端情况。 */
const RECONCILE_MS = 2500

/**
 * 绑定类改动（host/port）的落盘时机。
 *   'live'    —— 保存即写入托管块，走 profile 的 live patch 重载即时生效；
 *   'restart' —— 保存只记期望值，仅在“重启 dsh”前落盘（更保守）。
 * 由实测定夺：改 webserver 行会触发该行重启并重新 bind，需要确认路由能重新挂回。
 */
const BIND_APPLY_MODE = 'live'

const DEFAULTS = { mode: 'loopback', ips: [], port: DEFAULT_PORT, disableAuth: false }

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/
/** 我们的鉴权覆写标记：释放时只还原仍属于自己的那一层。 */
const AUTH_REJECTION_MARK = Symbol.for('dsh-advanced-listening-settings:requestRejection')
const AUTH_INDEX_MARK = Symbol.for('dsh-advanced-listening-settings:authorizeIndex')

/* ────────────────────────────── 小工具 ────────────────────────────── */

function log(...args) {
  console.log(LOG_TAG, ...args)
}

function warn(...args) {
  console.error(LOG_TAG, ...args)
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断是否为合法 IPv4 字面量（官方 trustedHosts 只接受 bare authority）。 */
function isIpv4(value) {
  if (typeof value !== 'string' || !IPV4_RE.test(value)) return false
  return value.split('.').every((part) => Number(part) <= 255)
}

/** 判断是否为官方认可的 bare authority（IPv4 或 localhost，可带端口）。 */
function isBareAuthority(value) {
  const entry = text(value).trim().toLowerCase()
  if (entry === '') return false
  const match = /^([^:\s/?#@]+)(?::(\d{1,5}))?$/.exec(entry)
  if (match === null) return false
  if (match[2] !== undefined) {
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  }
  return isIpv4(match[1]) || match[1] === 'localhost'
}

/** 原子替换写入：先写临时文件再 rename，避免掉电/异常留下半截 YAML。 */
function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${String(process.pid)}`
  try {
    writeFileSync(tmp, content)
    try {
      renameSync(tmp, file)
      return
    } catch (error) {
      warn('原子替换失败，回退为直接写入', file, error)
      writeFileSync(file, content)
    }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件已被 rename 或本来就不存在
    }
  }
}

/** 逐行拆分时统一去掉行尾 CR，保证 CRLF 文件的行偏移计算准确。 */
function bareLine(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 本机可用 IPv4（排除回环等 internal 网卡）。
 * @returns 网卡名、地址、掩码与 MAC 的列表。
 */
function listInterfaces() {
  const result = []
  let all
  try {
    all = networkInterfaces()
  } catch (error) {
    warn('读取网卡失败', error)
    return result
  }
  const seen = new Set()
  for (const [adapter, entries] of Object.entries(all)) {
    for (const entry of entries ?? []) {
      const family = entry.family
      if (family !== 'IPv4' && family !== 4) continue
      if (entry.internal === true) continue
      if (!isIpv4(text(entry.address))) continue
      if (seen.has(entry.address)) continue
      seen.add(entry.address)
      result.push({
        adapter,
        address: entry.address,
        netmask: text(entry.netmask) === '' ? null : entry.netmask,
        mac: text(entry.mac) === '' ? null : entry.mac,
      })
    }
  }
  result.sort((a, b) => a.adapter.localeCompare(b.adapter) || a.address.localeCompare(b.address))
  return result
}

/** 本机非回环 IPv4 集合（带 2s 缓存：每请求都读网卡太浪费）。 */
let ingressIpCache = { at: 0, ips: new Set() }
function localIngressIps() {
  const now = Date.now()
  if (now - ingressIpCache.at > 2000) {
    ingressIpCache = { at: now, ips: new Set(listInterfaces().map((item) => item.address)) }
  }
  return ingressIpCache.ips
}

/**
 * 把「从本机局域网地址进来的请求」头规范化成回环权威。
 *
 * 为什么必须做：DSH 宿主与第三方插件（如 dsh-plugin 插件市场）都把“页面是否为
 * 回环来源”当作特权判据 ——
 *   · `dsh-client-ui-settings` 用 `ctx.remote.$host.isLoopback` 决定设置文档是
 *     host 持久化还是降级 memory（远程页面会报 settings unavailable）；
 *   · dsh-plugin 的 `isSameOrigin()` 要求 Origin 主机名 ∈ {localhost,127.0.0.1,[::1]}，
 *     否则所有 POST（含 /dsh-plugin-hub/diagnostics）直接 403 untrusted origin，
 *     前端表现为“瞬间不可达”、根本不等超时。
 * dsh-pocket（社区成熟实现）在它的反向代理里把 Host/Origin/Referer/Sec-Fetch-Site
 * 统一改写成 `127.0.0.1:<port>`，我们在这里做同一件事，但直接挂在官方 http.Server
 * 的 request/upgrade 之前，因此两种监听模式（0.0.0.0 与按 IP 直通）都覆盖。
 *
 * 安全边界：**只改写 Host 恰好是本机某个非回环 IPv4 的请求**。DNS rebinding 的
 * 攻击页面带的是攻击者域名，不会被改写，官方围栏照常 403。
 *
 * @param headers - 可变请求头对象（node:http 的 request.headers）。
 * @param options - enabled（是否已开启局域网暴露）、port（当前监听端口）、ips（本机非回环 IPv4）。
 * @returns 是否发生了改写。
 */
function rewriteIngressHeaders(headers, options) {
  if (options?.enabled !== true) return false
  if (headers === undefined || headers === null) return false
  const port = options.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  const ips = options.ips
  if (!(ips instanceof Set) || ips.size === 0) return false
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(text(headers.host).toLowerCase())
  if (match === null || !ips.has(match[1])) return false
  const authority = `${LOOPBACK}:${port}`
  headers.host = authority
  const origin = text(headers.origin)
  if (origin !== '') {
    try {
      const url = new URL(origin)
      if (ips.has(url.hostname.toLowerCase())) headers.origin = `http://${authority}`
    } catch {
      // 非法 Origin 原样保留，交给官方围栏拒绝
    }
  }
  const referer = text(headers.referer)
  if (referer !== '') {
    try {
      const url = new URL(referer)
      if (ips.has(url.hostname.toLowerCase())) {
        url.protocol = 'http:'
        url.host = authority
        headers.referer = url.toString()
      }
    } catch {
      // 同上
    }
  }
  // 远程页面的同源请求在宿主看来源是“跨站”，特权方法会 403；改写后本就是同源。
  headers['sec-fetch-site'] = 'same-origin'
  return true
}

/** 是否等同于出厂默认：仅回环、无勾选 IP、默认端口、鉴权开启。 */
function isDefaultDesiredState(state, defaultPort = DEFAULT_PORT) {
  return state.mode === 'loopback' && state.ips.length === 0 && state.disableAuth === false && state.port === defaultPort
}

/**
 * 是否**必须**写托管块（组合层默认值不够用时）：
 *   · 0.0.0.0：官方 bundle 默认是回环，必须由组合层改写；
 *   · 非默认端口且命令行没有 --port：必须落盘才能在下次启动生效；
 *   · 其余情况（回环 + 默认端口 / 命令行已钉端口）组合层默认值本身就是答案 ——
 *     不写块，这也是“默认态零残留”的一半。
 * @param state - 期望状态。
 * @param live - {@link liveSnapshot} 形态的实况。
 * @param defaultPort - 官方 bundle 的默认端口。
 * @returns 需要托管块则 true。
 */
function needsManagedBlockFor(state, live, defaultPort = DEFAULT_PORT) {
  if (state.mode === 'all') return true
  if (live.cliPort !== null) return false
  return state.port !== defaultPort
}

/** DSH 主目录。 */
function resolveDshHome() {
  if (text(process.env.DSH_HOME) !== '') return process.env.DSH_HOME
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

/** 从插件 entry 的 baseUrl 推断当前真正运行的 profile 目录（最可靠）。 */
function profileDirFromContext(ctx) {
  try {
    const baseUrl = ctx?.baseUrl
    if (typeof baseUrl !== 'string' || !baseUrl.startsWith('file:')) return null
    const dir = fileURLToPath(baseUrl)
    if (!dir) return null
    if (basename(dir) === 'node_modules') return null
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) return null
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!isPlainObject(manifest?.dsh?.profile)) return null
    return dir
  } catch {
    return null
  }
}

/** 兜底：扫描 profiles 找声明了本插件依赖的 profile。 */
function profileDirFromScan(home) {
  const roots = join(home, 'profiles')
  try {
    for (const entry of readdirSync(roots, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(roots, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (isPlainObject(manifest?.dependencies) && manifest.dependencies['dsh-advanced-listening-settings'] !== undefined) {
          return join(roots, entry.name)
        }
      } catch {
        // 单个 profile 的 manifest 读不动就跳过
      }
    }
  } catch {
    // profiles 目录还不存在
  }
  return null
}

/** 定位本插件所在的 profile 目录（用于读写设置文件与 patch 层）。 */
function resolveProfileDir(ctx, home) {
  const fromContext = profileDirFromContext(ctx)
  if (fromContext !== null) return { dir: fromContext, source: 'ctx.baseUrl' }
  const fromScan = profileDirFromScan(home)
  if (fromScan !== null) return { dir: fromScan, source: 'profiles-scan' }
  return { dir: join(home, 'profiles', 'web'), source: 'default-web' }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readJsonBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

/* ────────────────────────── 托管块（patch 层） ────────────────────────── */

/**
 * 生成托管块文本。
 *
 * 官方 dsh-web-app 的 webserver 行（packages/bundle/web-app/cordis.patch.yml）
 * 声明了 5 个键；组合层补丁是「整段替换 config」，所以这里必须一字不差地
 * 复述全部 5 个键，否则压缩配置会丢。host 只可能是两个常量之一、port 已校验
 * 为整数，不存在注入面。
 */
function renderManagedBlock(host, port) {
  if (host !== ALL_INTERFACES && host !== LOOPBACK) throw new Error(`非法监听地址 ${JSON.stringify(host)}`)
  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error(`非法端口 ${JSON.stringify(port)}`)
  return [
    MANAGED_BEGIN,
    '# 绑定地址与端口必须写在组合层，Loader 启动时才读得到；端口仍以命令行 --port 优先。',
    '# 注意：组合层补丁是整段替换 config，下面 5 个键必须与官方 webserver 行保持一致。',
    '- id: webserver',
    '  inject: [webStartup]',
    '  config:',
    `    host: !!js ctx.webStartup.host ?? '${host}'`,
    `    port: !!js ctx.webStartup.port ?? ${portNumber}`,
    '    compression: gzip',
    '    compressionLevel: 1',
    '    compressionThresholdBytes: 1024',
    MANAGED_END,
  ].join('\n')
}

/** 读 patch 文件（不存在返回空串）。 */
function readPatchFile(patchPath) {
  try {
    return readFileSync(patchPath, 'utf8')
  } catch {
    return ''
  }
}

/** 文件里是否已经没有任何顶层条目（只剩注释 / 空行 / 空数组字面量 `[]`）。 */
function isEntrylessDocument(content) {
  const significant = content
    .split('\n')
    .map((line) => bareLine(line).trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  return significant.length === 0 || (significant.length === 1 && significant[0] === '[]')
}

/** 去掉模板自带的空数组字面量行（`[]` 与块序列不能共存于同一个 YAML 文档）。 */
function stripEmptyListLiteral(lines) {
  return lines.filter((line) => bareLine(line).trim() !== '[]')
}

/** 保证文本仍是一个合法的“补丁数组”文档：纯注释时补回 `[]`。 */
function ensureArrayDocument(content) {
  const significant = content
    .split('\n')
    .map((line) => bareLine(line).trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (significant.length === 1 && significant[0] === '[]') return content
  if (significant.length === 0) return `${content.replace(/\s+$/, '')}\n[]\n`
  return content
}

/** 备份 patch 文件（只保留最近一份 .bak）。 */
function backupPatch(patchPath) {
  try {
    if (!existsSync(patchPath)) return
    copyFileSync(patchPath, `${patchPath}${BACKUP_SUFFIX}`)
  } catch (error) {
    warn('备份 cordis.patch.yml 失败', error)
  }
}

/** 定位托管块（新标记优先，其次 v1.x 旧标记）；返回区间或 null。 */
function findManagedSpan(content) {
  for (const pair of [[MANAGED_BEGIN, MANAGED_END], [LEGACY_MANAGED_BEGIN, LEGACY_MANAGED_END]]) {
    const begin = content.indexOf(pair[0])
    if (begin < 0) continue
    const end = content.indexOf(pair[1], begin + pair[0].length)
    if (end > begin) return { begin, end: end + pair[1].length, legacy: pair[0] === LEGACY_MANAGED_BEGIN }
  }
  return null
}

/** 把托管块写进 patch：有则替换（含把 v1.x 旧标记升级成新标记），无则追加。 */
function writeManagedBlock(patchPath, host, port) {
  const block = renderManagedBlock(host, port)
  const original = readPatchFile(patchPath)
  const span = findManagedSpan(original)
  let next
  if (span !== null) {
    next = `${original.slice(0, span.begin)}${block}${original.slice(span.end)}`
  } else if (isEntrylessDocument(original)) {
    // 模板形态（只有注释和 `[]`）：托管块直接接管整个文档。
    const lines = stripEmptyListLiteral(original.split('\n'))
    while (lines.length > 0 && bareLine(lines[lines.length - 1]).trim() === '') lines.pop()
    const head = lines.length === 0 ? '' : `${lines.join('\n')}\n\n`
    next = `${head}${block}\n`
  } else {
    const separator = original.endsWith('\n') ? '' : '\n'
    next = `${original}${separator}\n${block}\n`
  }
  if (next === original) return { changed: false, block }
  backupPatch(patchPath)
  mkdirSync(dirname(patchPath), { recursive: true })
  atomicWrite(patchPath, next)
  return { changed: true, block }
}

/** 移除托管块（新旧标记都认），恢复由更早的条目或 bundle 默认值决定绑定。 */
function removeManagedBlock(patchPath) {
  const original = readPatchFile(patchPath)
  const span = findManagedSpan(original)
  if (span === null) return false
  const stripped = `${original.slice(0, span.begin)}${original.slice(span.end)}`.replace(/\n{3,}/g, '\n\n')
  backupPatch(patchPath)
  atomicWrite(patchPath, ensureArrayDocument(stripped))
  return true
}

/** 读托管块当前声明的 host/port（新旧标记都认）。 */
function readManagedBinding(patchPath) {
  const original = readPatchFile(patchPath)
  const span = findManagedSpan(original)
  if (span === null) return null
  const block = original.slice(span.begin, span.end)
  const host = /host:\s*!!js[^\n]*\?\?\s*'([^']+)'/.exec(block)
  const port = /port:\s*!!js[^\n]*\?\?\s*(\d+)/.exec(block)
  return { host: host === null ? null : host[1], port: port === null ? null : Number(port[1]) }
}

/**
 * 把 patch 切成“条目组”：每个组 = 它前面的连续注释行 + 该顶层条目本体，
 * 结束位置取下一个组的注释起点（而不是下一个条目的起点），
 * 否则上一组会把下一组的说明注释一起吃掉——包括托管块的标记行。
 *
 * 行数组按 `\n` 拆分（保留行尾 `\r`），因此 offsets 对 CRLF 也精确。
 */
function splitPatchGroups(content) {
  const lines = content.split('\n')
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = bareLine(lines[index])
    if (line.startsWith('- ') || line === '-') starts.push(index)
  }
  const heads = starts.map((bodyStart) => {
    let headStart = bodyStart
    while (headStart > 0 && bareLine(lines[headStart - 1]).startsWith('#')) headStart -= 1
    return headStart
  })
  const groups = []
  for (let index = 0; index < starts.length; index += 1) {
    const headStart = heads[index]
    const bodyStart = starts[index]
    const end = index + 1 < heads.length ? heads[index + 1] : lines.length
    groups.push({
      headStart,
      bodyStart,
      end,
      body: lines.slice(bodyStart, end).join('\n'),
      text: lines.slice(headStart, end).join('\n'),
    })
  }
  return { lines, groups }
}

/** 找出 patch 里由旧的 dsh-lan-open 脚本留下的条目（托管块之外的）。 */
function findLegacyEntries(patchPath) {
  const content = readPatchFile(patchPath)
  if (content === '') return []
  const lines = content.split('\n')
  const offsets = []
  let cursor = 0
  for (const line of lines) {
    offsets.push(cursor)
    cursor += line.length + 1
  }
  const span = findManagedSpan(content)
  const { groups } = splitPatchGroups(content)
  const found = []
  for (const group of groups) {
    const charStart = offsets[group.headStart] ?? 0
    if (span !== null && charStart >= span.begin && charStart <= span.end) continue
    if (!group.text.includes(LEGACY_MARK)) continue
    // 只从“标记行”开始删，标记之前的普通注释（例如模板自带的文件头）保持不动。
    let start = group.headStart
    for (let index = group.headStart; index < group.bodyStart; index += 1) {
      if (lines[index].includes(LEGACY_MARK)) {
        start = index
        break
      }
    }
    found.push({ start, end: group.end, text: lines.slice(start, group.end).join('\n') })
  }
  return found
}

/** 删除指定条目组（从后往前删，行号不失效），并做一次备份。 */
function removeLegacyEntries(patchPath) {
  const content = readPatchFile(patchPath)
  const targets = findLegacyEntries(patchPath)
  if (targets.length === 0) return { removed: 0, text: content }
  const lines = content.split('\n')
  for (const target of [...targets].sort((a, b) => b.start - a.start)) {
    let end = target.end
    while (end > target.start && bareLine(lines[end - 1]).trim() === '') end -= 1
    lines.splice(target.start, end - target.start)
  }
  const next = ensureArrayDocument(lines.join('\n').replace(/\n{3,}/g, '\n\n'))
  backupPatch(patchPath)
  atomicWrite(patchPath, next)
  return { removed: targets.length, text: next }
}

/* ──────────────────────────── 重启器（内联，不落盘） ──────────────────────────── */

/**
 * 独立于宿主进程的重启器。两段式：宿主孵化 A，A 立刻孵化 B 并退出，
 * 由 B 执行「杀旧 → 等端口释放 → 拉起新实例」。
 * 这样 taskkill /T（会连带杀掉宿主的整个进程树）不会误杀重启器本身。
 *
 * v2.0.0 起**不写任何文件**：宿主用 `node -e <本源码> stage1 <JSON>` 启动，
 * 第一段再用环境变量 {@link RESTART_SOURCE_ENV} 里的同一份源码孵化第二段。
 * 于是 `~/.dsh/web-advanced-restart.cjs` 这类 profile 之外的残留彻底消失。
 *
 * 经 `-e` 运行时 `process.argv` 是 [node, stage, payload]（没有脚本路径）。
 */
const RESTART_HELPER_SOURCE = String.raw`
/* dsh-advanced-listening-settings 重启器（内联执行，无文件）
   调用协议：node -e <源码> <stage1|stage2> <JSON 载荷>
   注意：全程不使用管道（stdio: 'ignore' 或重定向到文件），
   这样在受限的执行环境里也能可靠地调用 netstat / taskkill。 */
const C = require('node:child_process')
const F = require('node:fs')
const P = require('node:path')

const stage = process.argv[1] || 'stage1'
const spec = JSON.parse(process.argv[2] || '{}')
const win = process.platform === 'win32'
const port = String(spec.port)

function append(line) {
  try {
    F.mkdirSync(P.dirname(spec.log), { recursive: true })
    F.appendFileSync(spec.log, line + '\n')
  } catch {}
}

/** 把命令输出落到文件再读，避免管道。 */
function capture(command, args) {
  const tmp = spec.log + '.tmp'
  try {
    F.mkdirSync(P.dirname(spec.log), { recursive: true })
    const fd = F.openSync(tmp, 'w')
    const out = C.spawnSync(command, args, { stdio: ['ignore', fd, 'ignore'] })
    F.closeSync(fd)
    if (out.error) return { text: '', error: String(out.error.code || out.error.message || out.error) }
    const text = F.readFileSync(tmp, 'utf8')
    return { text, error: null }
  } catch (error) {
    return { text: '', error: String((error && error.message) || error) }
  } finally {
    try { F.unlinkSync(tmp) } catch {}
  }
}

function listenersOnPort() {
  if (win) {
    const result = capture('netstat', ['-ano', '-p', 'tcp'])
    if (result.error !== null) { append('[advanced-listening-settings] netstat 失败: ' + result.error); return [] }
    const pids = new Set()
    for (const line of result.text.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const addr = parts[1] || ''
      if (!addr.endsWith(':' + port)) continue
      const pid = parts[parts.length - 1]
      if (/^\d+$/.test(pid)) pids.add(pid)
    }
    return [...pids]
  }
  const result = capture('lsof', ['-ti', 'tcp:' + port, '-sTCP:LISTEN'])
  if (result.error !== null) return []
  return [...new Set(result.text.split(/\s+/).filter(Boolean))]
}

function kill(pid, tree) {
  if (win) {
    const args = tree ? ['/pid', pid, '/t', '/f'] : ['/pid', pid, '/f']
    const out = C.spawnSync('taskkill', args, { stdio: 'ignore' })
    append('[advanced-listening-settings] taskkill ' + args.join(' ') + ' -> ' +
      (out.error ? 'error=' + String(out.error.code || out.error.message) : 'status=' + String(out.status)))
    return
  }
  try {
    process.kill(Number(pid), 'SIGTERM')
    append('[advanced-listening-settings] SIGTERM -> ' + pid)
  } catch (error) {
    append('[advanced-listening-settings] SIGTERM ' + pid + ' 失败: ' + String((error && error.message) || error))
  }
}

function start() {
  append('[advanced-listening-settings] ' + new Date().toISOString() + ' 重新启动 dsh: ' + spec.execPath + ' ' + spec.argv.join(' '))
  try {
    F.mkdirSync(P.dirname(spec.log), { recursive: true })
    const fd = F.openSync(spec.log, 'a')
    const env = Object.assign({}, process.env)
    // 别把内联源码继续传给新实例
    delete env[process.env.DSH_ADVANCED_LISTENING_RESTART_SRC === undefined ? '__DSH_AL_NONE__' : 'DSH_ADVANCED_LISTENING_RESTART_SRC']
    const child = C.spawn(spec.execPath, spec.argv, {
      cwd: spec.cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
    child.on('error', (error) => append('[advanced-listening-settings] 启动失败: ' + String((error && error.message) || error)))
    child.unref()
  } catch (error) {
    append('[advanced-listening-settings] 重启失败: ' + String((error && error.message) || error))
  }
}

if (stage === 'stage1') {
  // 第一段：用环境变量里的同一份源码把第二段拉起来，然后立刻退出，
  // 脱离宿主的进程树（taskkill /T 连带清理时不会误杀重启器本身）。
  const source = process.env.DSH_ADVANCED_LISTENING_RESTART_SRC
  try {
    if (typeof source !== 'string' || source === '') throw new Error('缺少内联源码环境变量')
    const child = C.spawn(process.execPath, ['-e', source, 'stage2', process.argv[2] || '{}'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.on('error', (error) => append('[advanced-listening-settings] 无法启动第二段重启器: ' + String((error && error.message) || error)))
    child.unref()
  } catch (error) {
    append('[advanced-listening-settings] 无法启动第二段重启器: ' + String((error && error.message) || error))
  }
  process.exit(0)
}

const onPort = listenersOnPort()
append('[advanced-listening-settings] 端口 ' + port + ' 上的监听进程: ' + (onPort.join(',') || '无'))
// 先整树终止宿主本身（顺带清理它拉起的子进程），再收拾端口上其余的监听者。
// 顺序不能反：宿主通常就是端口持有者，先按端口杀掉它就再也做不成 /T 整树清理了。
if (spec.pid) kill(String(spec.pid), true)
for (const pid of onPort) if (String(pid) !== String(spec.pid)) kill(pid, false)

let tries = 0
;(function wait() {
  const remaining = listenersOnPort()
  if (remaining.length === 0 || ++tries > 60) {
    if (remaining.length !== 0) append('[advanced-listening-settings] 端口等待超时（' + String(tries) + ' 轮），仍然尝试拉起新实例')
    else append('[advanced-listening-settings] 端口已释放（等待 ' + String(tries) + ' 轮），开始拉起新实例')
    start()
    return
  }
  setTimeout(wait, 250)
})()
`

/**
 * 该文件是否确属我们的 v1.x 重启器（按文件头签名判断，绝不误删同名他人文件）。
 * @param homeDir - DSH 主目录。
 * @returns 是则 true。
 */
function isOurLegacyRestartHelper(homeDir) {
  const file = join(homeDir, LEGACY_RESTART_HELPER_FILENAME)
  try {
    if (!existsSync(file)) return false
    const head = readFileSync(file, 'utf8').slice(0, 400)
    return head.includes('重启器') && head.includes('由插件自动生成')
  } catch {
    return false
  }
}

/**
 * 清掉 v1.x 留下的重启器文件（内容确属我们才删），并报出被删路径。
 * @param homeDir - DSH 主目录。
 * @returns 被删除的文件路径，或 null。
 */
function removeLegacyRestartHelper(homeDir) {
  const file = join(homeDir, LEGACY_RESTART_HELPER_FILENAME)
  if (!isOurLegacyRestartHelper(homeDir)) return null
  try {
    unlinkSync(file)
    log(`已清除 v1.x 遗留的重启器文件 ${file}`)
    return file
  } catch (error) {
    warn('清除旧重启器失败', error)
    return null
  }
}

/* ──────────────────────────────── 插件 ──────────────────────────────── */

/**
 * 挂载高级监听设置：运行时应用（直通监听 / 信任白名单 / 免鉴权）、
 * HTTP 接口，以及绑定类改动的落盘。
 *
 * 这里刻意吞掉一切初始化异常：本插件只是设置页的一个分区，
 * 任何失败都不应该让宿主（乃至整个 dsh 启动）起不来。
 * @param ctx - 宿主 Cordis 上下文（已注入 webServer）。
 */
export function apply(ctx) {
  try {
    applySettings(ctx)
  } catch (error) {
    warn('初始化失败，已跳过（宿主不受影响）', error)
  }
}

/**
 * 实际装配逻辑，异常由 {@link apply} 兜住。
 * @param ctx - 宿主 Cordis 上下文（已注入 webServer）。
 */
function applySettings(ctx) {
  const dshHome = resolveDshHome()
  const resolvedProfile = resolveProfileDir(ctx, dshHome)
  const profileDir = resolvedProfile.dir
  const profileSource = resolvedProfile.source
  const settingsPath = join(profileDir, SETTINGS_FILENAME)
  const legacySettingsPath = join(profileDir, LEGACY_SETTINGS_FILENAME)
  const patchPath = join(profileDir, PATCH_FILENAME)
  /** v1.x 遗留的重启器文件（存在即清除；v2 起重启器内联，不再落盘）。 */
  let legacyHelperCleared = removeLegacyRestartHelper(dshHome) !== null

  /** 期望状态（唯一真源 = 设置文件；文件不存在时由当前实况推导，且不落盘）。 */
  let desired = { ...DEFAULTS }
  /** 期望状态是否来自设置文件（false = 只是从实况推导出来的展示值）。 */
  let desiredPersisted = false
  /** 前端上一次保存的结果说明，供刷新后回显。 */
  let lastNotes = []
  /** 重启请求去重。 */
  let restartRequested = false

  const frontDoor = new Map()
  let frontDoorRetryTimer = null
  const auth = { target: null, base: null, active: false }
  let trustAdded = []
  /** 入口头规范化当前挂在哪台 http.Server 上（webserver 热重载会换实例）。 */
  let ingressServer = null
  let ingressHandler = null

  /* ── 期望状态读写 ── */

  function liveSnapshot() {
    const server = ctx.get('webServer')
    const startup = ctx.get('webStartup')
    return {
      host: text(server?.host) === '' ? LOOPBACK : server.host,
      port: typeof server?.port === 'number' ? server.port : DEFAULT_PORT,
      cliHost: text(startup?.host) === '' ? null : startup.host,
      cliPort: typeof startup?.port === 'number' ? startup.port : null,
    }
  }

  function deriveDesired() {
    const live = liveSnapshot()
    return {
      mode: live.host === ALL_INTERFACES ? 'all' : 'loopback',
      ips: [],
      port: live.port,
      disableAuth: false,
    }
  }

  /**
   * 把 v1.x 的 `web-advanced-settings.json` 迁移成新文件名。
   * 只在“新文件不存在 + 旧文件存在”时动作，迁移后删掉旧文件，
   * 这样旧装升级不会留下卸不掉的第二份状态。
   */
  function migrateLegacySettings() {
    try {
      if (existsSync(settingsPath) || !existsSync(legacySettingsPath)) return false
      const raw = JSON.parse(readFileSync(legacySettingsPath, 'utf8'))
      desired = normalizeDesired(raw, { fallback: deriveDesired() })
      desiredPersisted = true
      persistDesired()
      unlinkSync(legacySettingsPath)
      log(`已从 v1.x 迁移设置文件（${LEGACY_SETTINGS_FILENAME} → ${SETTINGS_FILENAME}）`)
      return true
    } catch (error) {
      warn('迁移 v1.x 设置文件失败，按无设置处理', error)
      return false
    }
  }

  function loadDesired() {
    try {
      if (!existsSync(settingsPath)) {
        if (migrateLegacySettings()) return
        desiredPersisted = false
        desired = deriveDesired()
        return
      }
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
      desired = normalizeDesired(raw, { fallback: deriveDesired() })
      desiredPersisted = !isDefaultDesired(desired)
      // 文件里若只剩默认值（例如手工改回默认），顺手删掉，保持“默认态零残留”。
      if (!desiredPersisted) dropSettingsFile()
    } catch (error) {
      warn('读取设置文件失败，回退到实况推导', error)
      desiredPersisted = false
      desired = deriveDesired()
    }
  }

  /** 是否等同于出厂默认：仅回环、无勾选 IP、默认端口、鉴权开启。 */
  function isDefaultDesired(state) {
    return isDefaultDesiredState(state)
  }

  function dropSettingsFile() {
    for (const file of [settingsPath, legacySettingsPath]) {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch (error) {
        warn('删除设置文件失败', file, error)
      }
    }
  }

  /** 落盘期望状态：默认态不落盘（并把已有文件删掉）。 */
  function persistDesired() {
    if (isDefaultDesired(desired)) {
      dropSettingsFile()
      desiredPersisted = false
      return
    }
    desiredPersisted = true
    try {
      mkdirSync(profileDir, { recursive: true })
      atomicWrite(settingsPath, `${JSON.stringify(desired, null, 2)}\n`)
    } catch (error) {
      warn('写入设置文件失败', error)
    }
  }

  /** 规范化并校验期望状态；不合法时抛错（保存路径）或回退（读取路径）。 */
  function normalizeDesired(raw, options = {}) {
    const fallback = options.fallback ?? DEFAULTS
    const throwOnError = options.strict === true
    const fail = (message) => {
      if (throwOnError) throw new Error(message)
      return undefined
    }
    const source = isPlainObject(raw) ? raw : {}
    const rawMode = source.mode === 'all' || source.mode === 'ips' || source.mode === 'loopback' ? source.mode : fallback.mode
    const port = Number(source.port)
    const portOk = Number.isInteger(port) && port >= 1 && port <= 65535
    if (!portOk) {
      const bad = fail(`端口必须是 1–65535 的整数，收到 ${JSON.stringify(source.port)}`)
      if (bad !== undefined) return fallback
    }
    const known = new Set(listInterfaces().map((item) => item.address))
    const ips = []
    if (Array.isArray(source.ips)) {
      for (const value of source.ips) {
        if (typeof value !== 'string' || !isIpv4(value)) {
          fail(`不是合法的 IPv4 地址：${JSON.stringify(value)}`)
          continue
        }
        if (!known.has(value)) {
          fail(`本机不存在网卡地址 ${value}`)
          continue
        }
        if (!ips.includes(value)) ips.push(value)
      }
    }
    // 'ips' 但没有勾选任何地址时等价于仅本机：统一收敛成 'loopback'，
    // 否则前端 dirty 判定会永远为真、保存按钮点不动。
    const mode = rawMode === 'ips' && ips.length === 0 ? 'loopback' : rawMode
    return {
      mode,
      // 勾选结果始终保留（切到全局监听时只是不参与监听范围），避免来回切换丢选择。
      ips,
      port: portOk ? port : fallback.port,
      disableAuth: source.disableAuth === true,
    }
  }

  function saveDesired(next) {
    desired = next
    persistDesired()
  }

  /**
   * 是否必须写托管块（组合层默认值不够用时）。判定规则见
   * {@link needsManagedBlockFor}。
   */
  function needsManagedBlock(live = liveSnapshot()) {
    return needsManagedBlockFor(desired, live)
  }

  /* ── 运行时一：信任白名单 ── */

  /**
   * 期望加入 Host/Origin 围栏的 authority。
   *   · 'ips'：勾选的网卡地址（官方不会派生）；
   *   · 'all'：全部非 internal 的 IPv4（官方 web-runtime 本来就会派生，
   *     这里做一次幂等补齐，避免热重载导致 web-runtime 值滞后的竞态）。
   */
  function desiredTrustEntries() {
    if (desired.mode === 'all') return listInterfaces().map((item) => item.address)
    if (desired.mode === 'ips') return desired.ips
    return []
  }

  function normalizeTrustEntries(list) {
    const out = []
    for (const item of list) {
      const entry = text(item).trim().toLowerCase()
      if (!isBareAuthority(entry)) continue
      if (!out.includes(entry)) out.push(entry)
    }
    return out
  }

  function syncTrust() {
    const connection = ctx.get('connection')
    if (connection === undefined || !Array.isArray(connection.trustedHosts)) return
    for (const entry of trustAdded) {
      const index = connection.trustedHosts.indexOf(entry)
      if (index >= 0) connection.trustedHosts.splice(index, 1)
    }
    trustAdded = []
    for (const entry of normalizeTrustEntries(desiredTrustEntries())) {
      if (connection.trustedHosts.includes(entry)) continue
      connection.trustedHosts.push(entry)
      trustAdded.push(entry)
    }
  }

  function releaseTrust() {
    const connection = ctx.get('connection')
    if (connection !== undefined && Array.isArray(connection.trustedHosts)) {
      for (const entry of trustAdded) {
        const index = connection.trustedHosts.indexOf(entry)
        if (index >= 0) connection.trustedHosts.splice(index, 1)
      }
    }
    trustAdded = []
  }

  /* ── 运行时二：免鉴权（可逆覆写两个公开方法） ── */

  function installAuthBypass() {
    const connection = ctx.get('connection')
    if (connection === undefined) return
    if (auth.target === connection && auth.active) return
    if (auth.target !== null && auth.target !== connection) releaseAuthBypass()
    const baseRejection = connection.requestRejection
    const baseIndex = connection.authorizeIndex
    if (typeof baseRejection !== 'function' || typeof baseIndex !== 'function') return
    const ownedRejection = Object.prototype.hasOwnProperty.call(connection, 'requestRejection')
    const ownedIndex = Object.prototype.hasOwnProperty.call(connection, 'authorizeIndex')
    auth.target = connection
    auth.base = {
      baseRejection,
      baseIndex,
      ownedRejection,
      ownedIndex,
      ownedRejectionValue: ownedRejection ? connection.requestRejection : undefined,
      ownedIndexValue: ownedIndex ? connection.authorizeIndex : undefined,
    }
    const wrappedRejection = function requestRejection(request) {
      const code = baseRejection.call(this, request)
      // 只摘掉「未认证」这一层；Host/Origin 围栏（403）保持生效。
      return code === 401 ? undefined : code
    }
    wrappedRejection[AUTH_REJECTION_MARK] = true
    const wrappedIndex = function authorizeIndex(request, response) {
      // 免鉴权只摘掉「未认证」这一层：Host/Origin 围栏（403）必须继续生效。
      // 官方 index 路径不经过 requestRejection，所以这里主动复用基函数做围栏判定，
      // 否则 DNS rebinding 的 Host 也能拿到 index.html。
      const code = baseRejection.call(this, request)
      if (code !== 403) return true
      if (response !== undefined && typeof response.writeHead === 'function') {
        response.writeHead(403, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
        response.end('forbidden')
      }
      return false
    }
    wrappedIndex[AUTH_INDEX_MARK] = true
    connection.requestRejection = wrappedRejection
    connection.authorizeIndex = wrappedIndex
    auth.active = true
  }

  function releaseAuthBypass() {
    const connection = auth.target
    auth.active = false
    if (connection === null) return
    const base = auth.base
    auth.target = null
    auth.base = null
    if (base === null) return
    try {
      // 只还原“仍是我们写下的那个函数”。若别的插件在此期间又覆写过，保持它的版本。
      if (connection.requestRejection?.[AUTH_REJECTION_MARK] === true) {
        if (base.ownedRejection) connection.requestRejection = base.ownedRejectionValue
        else delete connection.requestRejection
      }
      if (connection.authorizeIndex?.[AUTH_INDEX_MARK] === true) {
        if (base.ownedIndex) connection.authorizeIndex = base.ownedIndexValue
        else delete connection.authorizeIndex
      }
    } catch (error) {
      warn('恢复鉴权方法失败', error)
    }
  }

  function syncAuth() {
    if (desired.disableAuth) installAuthBypass()
    else releaseAuthBypass()
  }

  /* ── 运行时三：按 IP 的 TCP 直通监听 ── */

  function destroyFrontDoor(key, entry) {
    frontDoor.delete(key)
    entry.state = 'closed'
    for (const socket of entry.sockets) {
      try {
        socket.destroy()
      } catch {
        // 已断开
      }
    }
    entry.sockets.clear()
    try {
      entry.server?.close()
    } catch {
      // 关闭失败不影响卸载
    }
  }

  function createFrontDoorEntry(key, spec) {
    const entry = {
      address: spec.address,
      port: spec.port,
      state: 'starting',
      error: null,
      server: null,
      sockets: new Set(),
      attempts: 0,
    }
    const netServer = createTcpServer((client) => {
      entry.sockets.add(client)
      const forget = () => entry.sockets.delete(client)
      client.on('close', forget)
      client.on('error', forget)
      try {
        client.setNoDelay(true)
      } catch {
        // 某些平台不支持
      }
      const upstream = tcpConnect({ host: LOOPBACK, port: spec.port })
      let closed = false
      const shutdown = () => {
        if (closed) return
        closed = true
        client.destroy()
        upstream.destroy()
      }
      client.on('error', shutdown)
      upstream.on('error', shutdown)
      client.on('close', () => {
        if (closed) return
        closed = true
        upstream.destroy()
      })
      upstream.on('close', () => {
        if (closed) return
        closed = true
        client.destroy()
      })
      upstream.on('connect', () => {
        if (closed) return
        client.pipe(upstream)
        upstream.pipe(client)
      })
    })
    entry.server = netServer
    const markError = (error) => {
      entry.state = 'error'
      entry.error = String(error?.code ?? error?.message ?? error)
      entry.attempts += 1
      warn(`直通监听 ${spec.address}:${spec.port} 失败`, entry.error)
      scheduleFrontDoorRetry()
    }
    /** 重新 listen（失败重试走这里，保留 attempts 计数以便最终放弃）。 */
    entry.listen = () => {
      entry.state = 'starting'
      try {
        // exclusive：Windows 上使用 SO_EXCLUSIVEADDRUSE，避免别的进程悄悄抢端口。
        netServer.listen({ port: spec.port, host: spec.address, exclusive: true })
      } catch (error) {
        markError(error)
      }
    }
    netServer.on('listening', () => {
      entry.state = 'listening'
      entry.error = null
      entry.attempts = 0
      log(`直通监听已建立 ${spec.address}:${spec.port} → ${LOOPBACK}:${spec.port}`)
    })
    netServer.on('error', markError)
    netServer.on('close', () => {
      if (entry.state !== 'error') entry.state = 'closed'
      for (const socket of entry.sockets) {
        try {
          socket.destroy()
        } catch {
          // 已断开
        }
      }
      entry.sockets.clear()
    })
    entry.listen()
    return entry
  }

  /**
   * 直通监听对账。
   *
   * 关键点：webserver 还在 0.0.0.0 时**不要**建直通监听——同端口已被占，
   * 必然 EADDRINUSE，而且此时本来就不需要直通。等热重载把 webserver 收回
   * 回环后再建（或由周期对账补上）。
   * @param options - retry=true 时允许对 error 状态的条目重试。
   */
  function syncFrontDoor(options = {}) {
    const retry = options.retry === true
    const server = ctx.get('webServer')
    const targetPort = typeof server?.port === 'number' ? server.port : null
    const liveHost = text(server?.host)
    // webserver 正在重新 bind 时 port 是 undefined：此时不要回收既有监听，
    // 等它 bind 完成由周期对账接手，避免“热重载瞬间把局域网监听关掉”。
    if (desired.mode === 'ips' && targetPort === null) return
    const wanted = new Map()
    if (desired.mode === 'ips' && targetPort !== null && liveHost !== ALL_INTERFACES) {
      for (const ip of desired.ips) wanted.set(`${ip}:${targetPort}`, { address: ip, port: targetPort })
    }
    for (const [key, entry] of [...frontDoor.entries()]) {
      if (wanted.has(key)) {
        if (retry && entry.state === 'error' && entry.attempts <= FRONTDOOR_RETRY_MAX) entry.listen()
        continue
      }
      destroyFrontDoor(key, entry)
    }
    for (const [key, spec] of wanted) {
      if (frontDoor.has(key)) continue
      frontDoor.set(key, createFrontDoorEntry(key, spec))
    }
    for (const entry of frontDoor.values()) {
      if (entry.state === 'error' && entry.attempts <= FRONTDOOR_RETRY_MAX) {
        scheduleFrontDoorRetry()
        break
      }
    }
  }

  function scheduleFrontDoorRetry() {
    if (frontDoorRetryTimer !== null) return
    const timer = setTimeout(() => {
      frontDoorRetryTimer = null
      try {
        syncFrontDoor({ retry: true })
      } catch (error) {
        warn('直通监听重试失败', error)
      }
    }, FRONTDOOR_RETRY_MS)
    timer.unref?.()
    frontDoorRetryTimer = timer
  }

  /** 关闭全部直通监听并等待端口真正释放（切回全局监听前的必要动作）。 */
  async function closeAllFrontDoor() {
    if (frontDoorRetryTimer !== null) {
      clearTimeout(frontDoorRetryTimer)
      frontDoorRetryTimer = null
    }
    const entries = [...frontDoor.values()]
    frontDoor.clear()
    await Promise.all(entries.map((entry) => new Promise((resolvePromise) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolvePromise()
      }
      for (const socket of entry.sockets) {
        try {
          socket.destroy()
        } catch {
          // 已断开
        }
      }
      entry.sockets.clear()
      try {
        if (entry.server === null) finish()
        else entry.server.close(finish)
      } catch {
        finish()
      }
      const timer = setTimeout(finish, 1000)
      timer.unref?.()
    })))
  }

  /* ── 应用全部运行时状态 ── */

  function applyRuntime() {
    syncTrust()
    syncAuth()
    syncFrontDoor()
  }

  /* ── 运行时四：局域网入口头规范化 + 宿主面提示 ── */

  /** 把官方 http.Server 的 request/upgrade 前置一层规范化；server 换实例时自动迁移。 */
  function ensureIngressNormalizer() {
    const server = ctx.get('webServer')?.server
    if (server === undefined || server === null || typeof server.prependListener !== 'function') return
    if (ingressServer === server) return
    removeIngressNormalizer()
    ingressServer = server
    ingressHandler = (request) => {
      try {
        rewriteIngressHeaders(request?.headers, {
          enabled: desired.mode !== 'loopback',
          port: typeof ctx.get('webServer')?.port === 'number' ? ctx.get('webServer').port : null,
          ips: localIngressIps(),
        })
      } catch (error) {
        warn('入口 Host/Origin 规范化失败', error)
      }
    }
    server.prependListener('request', ingressHandler)
    server.prependListener('upgrade', ingressHandler)
    log('已挂载局域网入口规范化：Host/Origin/Referer/Sec-Fetch-Site → 回环权威')
  }

  function removeIngressNormalizer() {
    if (ingressServer !== null && ingressHandler !== null) {
      try {
        ingressServer.removeListener('request', ingressHandler)
        ingressServer.removeListener('upgrade', ingressHandler)
      } catch {
        // server 已销毁
      }
    }
    ingressServer = null
    ingressHandler = null
  }

  /**
   * 非回环页面在官方客户端里被判定成“非宿主面”，设置文档降级为 memory。
   * 在 index 头部注入一次 ownsHost 断言（仅在宿主没有提供 transport 时），
   * 与 dsh-pocket 覆写 connection.isLoopback 的做法同源、且更早生效。
   */
  function installHostSurfaceHint() {
    const hint = "try{if(globalThis.__DSH_TRANSPORT__===undefined){globalThis.__DSH_TRANSPORT__={ownsHost:true};}}catch(e){}"
    ctx.effect(
      () => ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'script', placement: 'head', text: hint })
      }),
      'advanced-listening-settings: 宿主面判定提示',
    )
  }

  /* ── 状态快照（给前端） ── */

  function urlsFor(port, addresses) {
    const connection = ctx.get('connection')
    const list = []
    const push = (label, authority) => {
      const plain = `http://${authority}`
      let url = plain
      if (desired.disableAuth !== true && typeof connection?.authenticatedUrl === 'function') {
        try {
          url = connection.authenticatedUrl(plain)
        } catch {
          url = plain
        }
      }
      list.push({ label, authority, url, authenticated: url !== plain })
    }
    push('本机（回环）', `${LOOPBACK}:${port}`)
    for (const address of addresses) {
      if (address === LOOPBACK) continue
      push('局域网', `${address}:${port}`)
    }
    return list
  }

  function statePayload() {
    const live = liveSnapshot()
    const interfaces = listInterfaces()
    const frontDoorState = [...frontDoor.values()].map((entry) => ({
      address: entry.address,
      port: entry.port,
      state: entry.state,
      error: entry.error,
      attempts: entry.attempts,
    }))
    const desiredHost = desired.mode === 'all' ? ALL_INTERFACES : LOOPBACK
    const effectivePort = live.cliPort ?? live.port
    const pending = []
    if (desiredHost !== live.host) pending.push('mode')
    if (live.cliPort === null && desired.port !== live.port) pending.push('port')
    if (desired.mode === 'ips' && desired.ips.length > 0 && live.host === ALL_INTERFACES) pending.push('frontdoor')
    else if (frontDoorState.some((entry) => entry.state === 'error')) pending.push('frontdoor')

    const lanAddresses = []
    if (live.host === ALL_INTERFACES) {
      for (const item of interfaces) lanAddresses.push(item.address)
    } else if (desired.mode === 'ips') {
      const broken = new Set(frontDoorState.filter((entry) => entry.state === 'error').map((entry) => entry.address))
      for (const ip of desired.ips) if (!broken.has(ip)) lanAddresses.push(ip)
    }

    const managed = readManagedBinding(patchPath)
    const legacy = findLegacyEntries(patchPath).map((entry) => ({ preview: entry.text }))
    const settingsExists = existsSync(settingsPath)
    const legacySettingsExists = existsSync(legacySettingsPath)

    return {
      version: VERSION,
      profile: basename(profileDir),
      profileSource,
      dshHome,
      settingsPath,
      legacySettingsPath,
      patchPath,
      desired,
      desiredPersisted,
      cleanup: {
        // 出厂态 = 没有设置文件、没有托管块、没有旧条目、没有旧重启器
        pristine: !settingsExists && !legacySettingsExists && managed === null && legacy.length === 0 && !legacyHelperCleared,
        settingsExists,
        legacySettingsExists,
        legacyHelperCleared,
        uninstallCommand: `dsh plugin --profile ${basename(profileDir)} remove dsh-advanced-listening-settings`,
      },
      effective: {
        host: live.host,
        port: live.port,
        mode: live.host === ALL_INTERFACES ? 'all' : 'loopback',
        desiredHost,
        authBypass: auth.active,
        pendingRestart: pending.length > 0,
        pending,
      },
      cli: { host: live.cliHost, port: live.cliPort },
      bindApplyMode: BIND_APPLY_MODE,
      managed,
      legacy,
      interfaces,
      frontDoor: frontDoorState,
      urls: urlsFor(live.port, lanAddresses),
      exposure: {
        allInterfaces: live.host === ALL_INTERFACES,
        authDisabled: auth.active,
        level: auth.active && live.host === ALL_INTERFACES ? 'danger' : auth.active || live.host === ALL_INTERFACES ? 'warn' : 'ok',
      },
      notes: lastNotes,
    }
  }

  /* ── HTTP 接口 ── */

  function requireAccess(request, response) {
    const connection = ctx.get('connection')
    if (connection === undefined) {
      const host = text(request.headers?.host)
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
        sendJson(response, 503, { error: '宿主连接服务尚未就绪，请稍后刷新' })
        return false
      }
      return true
    }
    const rejection = connection.requestRejection(request)
    if (rejection !== undefined) {
      sendJson(response, rejection, { error: rejection === 401 ? '需要鉴权：请用 dsh web 打印的带 token 地址打开' : '请求来源不被信任' })
      return false
    }
    return true
  }

  async function handleState(response) {
    sendJson(response, 200, statePayload())
  }

  /** 远程接入自检：回显宿主实际看到的权威与来源头（用于确认入口改写是否生效）。 */
  async function handleWhoami(request, response) {
    const headers = request.headers ?? {}
    const host = text(headers.host)
    const port = ctx.get('webServer')?.port
    sendJson(response, 200, {
      host,
      origin: text(headers.origin),
      referer: text(headers.referer),
      secFetchSite: text(headers['sec-fetch-site']),
      loopbackAuthority: typeof port === 'number' && host === `${LOOPBACK}:${String(port)}`,
      lanExposure: desired.mode !== 'loopback',
      ingressRewrite: ingressServer !== null,
    })
  }

  async function handleSave(request, response) {
    const body = await readJsonBody(request)
    const next = normalizeDesired(body, { strict: true })
    const before = { ...desired }
    const liveBefore = liveSnapshot()
    const nextHost = next.mode === 'all' ? ALL_INTERFACES : LOOPBACK
    // 目标绑定与当前不同：先把直通监听收干净并等端口释放，再写 patch 触发
    // 热重载。否则 webserver 重新 bind 时可能撞上我们自己占着的端口。
    if (nextHost !== liveBefore.host) await closeAllFrontDoor()
    saveDesired(next)

    const notes = []
    applyRuntime()
    // 监听是异步的：等一拍再报告直通监听的真实状态（listening / error），
    // 否则“已生效”可能在端口被占用时骗人。
    if (next.mode === 'ips') await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))

    if (before.disableAuth !== next.disableAuth) {
      notes.push({
        key: 'auth',
        level: next.disableAuth ? 'warn' : 'ok',
        text: next.disableAuth ? '已取消 token 鉴权：直接用 IP:端口 即可访问（建议刷新本页）' : '已恢复 token 鉴权（建议刷新本页）',
      })
    } else {
      notes.push({ key: 'auth', level: 'ok', text: next.disableAuth ? '免鉴权保持开启' : '鉴权保持开启' })
    }

    if (next.mode === 'ips') {
      const failed = [...frontDoor.values()].filter((entry) => entry.state === 'error')
      const listening = [...frontDoor.values()].filter((entry) => entry.state === 'listening')
      if (failed.length > 0) {
        notes.push({ key: 'ips', level: 'error', text: `直通监听失败：${failed.map((entry) => `${entry.address}:${entry.port} ${entry.error ?? ''}`).join('；')}（会自动重试）` })
      } else if (listening.length === 0) {
        notes.push({ key: 'ips', level: 'pending', text: '正在等待 webserver 收回回环地址后建立直通监听…' })
      } else {
        notes.push({ key: 'ips', level: 'ok', text: `已生效：${listening.map((entry) => entry.address).join('、')} 上的直通监听已建立（建议刷新本页）` })
      }
    } else if (next.mode === 'all') {
      notes.push({ key: 'ips', level: 'ok', text: '全局监听模式下，本机 IP 列表不参与监听范围' })
    } else {
      notes.push({ key: 'ips', level: 'ok', text: '仅本机监听（已生效）' })
    }

    const live = liveSnapshot()
    const desiredHost = next.mode === 'all' ? ALL_INTERFACES : LOOPBACK
    const cliPinsPort = live.cliPort !== null && next.port !== live.cliPort
    if (cliPinsPort) {
      notes.push({
        key: 'port',
        level: 'warn',
        text: `命令行 --port ${live.cliPort} 优先：端口 ${next.port} 本次不生效，去掉 --port 启动后按此端口监听`,
      })
    }
    const needsRebind = desiredHost !== live.host || (live.cliPort === null && next.port !== live.port)
    const wantedBlock = needsManagedBlock(live)

    if (needsRebind) {
      if (BIND_APPLY_MODE !== 'live') {
        notes.push({ key: 'bind', level: 'pending', text: `绑定地址/端口已记录：${desiredHost}:${next.port}，重启 dsh 后生效` })
      } else if (wantedBlock) {
        const result = writeManagedBlock(patchPath, desiredHost, next.port)
        notes.push({
          key: 'bind',
          level: 'ok',
          text: result.changed
            ? `绑定地址/端口已写入 ${PATCH_FILENAME} 并触发热重载：${desiredHost}:${next.port}，页面可能断开 1–2 秒`
            : '绑定地址/端口已是目标值',
        })
      } else {
        // 回环 + 默认端口 = 官方 bundle 的默认值：不写托管块，直接把它撤掉。
        const removed = removeManagedBlock(patchPath)
        notes.push({
          key: 'bind',
          level: 'ok',
          text: removed
            ? `已回到出厂默认绑定（${LOOPBACK}:${DEFAULT_PORT}）并清除了托管块，页面可能断开 1–2 秒`
            : `绑定地址已是出厂默认：${LOOPBACK}:${DEFAULT_PORT}`,
        })
      }
    } else if (cliPinsPort) {
      notes.push({ key: 'bind', level: 'pending', text: `命令行 --port 钉住了端口（当前 ${live.host}:${live.port}），设置里的端口只在去掉 --port 后生效` })
    } else {
      notes.push({ key: 'bind', level: 'ok', text: `绑定地址未变化：${live.host}:${live.port}` })
    }

    lastNotes = notes
    sendJson(response, 200, { ...statePayload(), notes })
  }

  async function handleRestart(request, response) {
    const body = await readJsonBody(request)
    if (body?.confirm !== true) {
      sendJson(response, 400, { error: '缺少二次确认标记' })
      return
    }
    if (restartRequested) {
      sendJson(response, 409, { error: '重启已在进行中' })
      return
    }
    const live = liveSnapshot()
    // 重启是“最后落盘”时机：保证组合层与期望一致（该写的写，不该留的撤）。
    let managedChanged = false
    try {
      if (needsManagedBlock(live)) managedChanged = writeManagedBlock(patchPath, desired.mode === 'all' ? ALL_INTERFACES : LOOPBACK, desired.port).changed
      else managedChanged = removeManagedBlock(patchPath)
    } catch (error) {
      sendJson(response, 500, { error: `整理组合补丁失败：${String(error?.message ?? error)}` })
      return
    }
    const logFile = join(dshHome, 'logs', `dsh-web-${live.port}.log`)
    // 原样复刻启动命令：argv[0] 是本进程的入口脚本（bin.js），其余参数原样带上。
    const argv = process.argv.slice(1)
    const entry = argv[0]
    const canReplay = typeof entry === 'string' && entry !== '' && existsSync(entry)
    if (!canReplay) {
      sendJson(response, 500, { error: `无法还原启动命令（入口=${JSON.stringify(entry)}），请手动重启 dsh` })
      return
    }
    const payload = {
      port: live.port,
      pid: process.pid,
      execPath: process.execPath,
      argv,
      cwd: process.cwd(),
      log: logFile,
    }
    restartRequested = true
    try {
      // 内联两段式：不落任何 helper 文件；第二段用同一份源码（经环境变量传递）。
      const child = spawn(process.execPath, ['-e', RESTART_HELPER_SOURCE, 'stage1', JSON.stringify(payload)], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: { ...process.env, [RESTART_SOURCE_ENV]: RESTART_HELPER_SOURCE },
      })
      child.on('error', (error) => warn('启动重启器失败', error))
      child.unref()
    } catch (error) {
      restartRequested = false
      sendJson(response, 500, { error: `启动重启器失败：${String(error?.message ?? error)}` })
      return
    }
    sendJson(response, 200, { ok: true, port: live.port, log: logFile, managedChanged })
    const exit = ctx.get('appExit')
    setTimeout(() => {
      log('按请求重启 dsh')
      if (typeof exit === 'function') exit(0)
      else process.exit(0)
    }, 500)
  }

  async function handleCleanup(request, response) {
    const body = await readJsonBody(request)
    if (body?.confirm !== true) {
      sendJson(response, 400, { error: '缺少确认标记' })
      return
    }
    try {
      if (body?.action === 'remove-managed') {
        const removed = removeManagedBlock(patchPath)
        sendJson(response, 200, { ok: true, removedManaged: removed, ...statePayload() })
        return
      }
      if (body?.action === 'purge') {
        // 完全清理：把插件在 profile/home 里留下的一切都收回装前状态。
        const removedManaged = removeManagedBlock(patchPath)
        const legacy = removeLegacyEntries(patchPath).removed
        dropSettingsFile()
        desiredPersisted = false
        const removedHelper = removeLegacyRestartHelper(dshHome) !== null
        if (removedHelper) legacyHelperCleared = true
        lastNotes = [{
          key: 'purge',
          level: 'ok',
          text: `已完全清理（托管块=${removedManaged ? '移除' : '无'}，旧条目=${legacy}，设置文件=已删，旧重启器=${removedHelper || legacyHelperCleared ? '已删' : '无'}）。` +
            '现在可以安全卸载：dsh plugin --profile <profile> remove dsh-advanced-listening-settings，然后重启 dsh。',
        }]
        sendJson(response, 200, { ok: true, removedManaged, removedLegacy: legacy, removedHelper, ...statePayload() })
        return
      }
      const result = removeLegacyEntries(patchPath)
      sendJson(response, 200, { ok: true, removedLegacy: result.removed, ...statePayload() })
    } catch (error) {
      sendJson(response, 500, { error: `清理失败：${String(error?.message ?? error)}` })
    }
  }

  async function handle(request, response) {
    try {
      if (!requireAccess(request, response)) return
      const url = new URL(request.url ?? ROUTE_PREFIX, 'http://dsh.invalid')
      const route = url.pathname.slice(ROUTE_PREFIX.length)
      if (request.method === 'GET' && route === '/state') return await handleState(response)
      if (request.method === 'GET' && route === '/whoami') return await handleWhoami(request, response)
      if (request.method === 'POST' && route === '/save') return await handleSave(request, response)
      if (request.method === 'POST' && route === '/restart') return await handleRestart(request, response)
      if (request.method === 'POST' && route === '/cleanup') return await handleCleanup(request, response)
      sendJson(response, 404, { error: `未知接口 ${request.method} ${route}` })
    } catch (error) {
      warn('处理请求失败', error)
      try {
        sendJson(response, 400, { error: String(error?.message ?? error) })
      } catch {
        // 响应可能已经发出
      }
    }
  }

  /* ── 装配 ── */

  loadDesired()
  applyRuntime()
  ensureIngressNormalizer()
  installHostSurfaceHint()

  // connection 可能比本插件晚挂载（或被热重载），每次就绪都重新施加运行时状态。
  ctx.inject(['connection'], () => {
    applyRuntime()
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (request, response) => void handle(request, response) }),
    'advanced-listening-settings: /advanced-listening 接口',
  )

  // 启动对账：让组合层与期望一致 —— 需要托管块就补齐/更新，不需要（回到出厂默认）
  // 就撤掉。两边都一致时不会产生任何写入与重载。
  // 注意：用户从未保存过设置（desiredPersisted=false）且组合里本来就没有托管块时，
  // 一个字节都不写 —— 没配过就不该留下痕迹。
  {
    const desiredHost = desired.mode === 'all' ? ALL_INTERFACES : LOOPBACK
    const span = findManagedSpan(readPatchFile(patchPath))
    const managed = readManagedBinding(patchPath)
    // v1.x 旧标记即使数值一致也要改写一次，把标记升级掉（否则改名后永远留着旧痕迹）。
    const needsUpgrade = span !== null && span.legacy === true
    try {
      if (needsManagedBlock()) {
        if ((desiredPersisted || managed !== null) && (managed === null || managed.host !== desiredHost || managed.port !== desired.port || needsUpgrade)) {
          writeManagedBlock(patchPath, desiredHost, desired.port)
          log(needsUpgrade ? '已把 v1.x 旧托管块升级为新标记' : '已按设置文件补齐托管块（期望绑定与组合不一致）')
        }
      } else if (managed !== null) {
        removeManagedBlock(patchPath)
        log('期望绑定等于出厂默认，已撤掉托管块（默认态零残留）')
      }
    } catch (error) {
      warn('启动对账组合补丁失败', error)
    }
  }

  // 周期对账：热重载后 webserver 服务对象/端口可能已经变化，而本插件的
  // 直通监听需要跟着目标端口走；任何一次竞态都在这里自愈。
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        ensureIngressNormalizer()
        syncFrontDoor({ retry: true })
      } catch (error) {
        warn('直通监听周期对账失败', error)
      }
    }, RECONCILE_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'advanced-listening-settings: 直通监听周期对账')

  ctx.effect(() => () => {
    removeIngressNormalizer()
    void closeAllFrontDoor()
    releaseTrust()
    releaseAuthBypass()
  }, 'advanced-listening-settings: 运行时状态回收')

  const mountedLive = liveSnapshot()
  log(`已挂载：profile=${profileDir}（来源 ${profileSource}），绑定=${mountedLive.host}:${mountedLive.port}，` +
    `模式=${desired.mode}，IP=${desired.ips.join(',') || '无'}，免鉴权=${desired.disableAuth ? '开' : '关'}，` +
    `落盘=${desiredPersisted ? '是' : '默认态不落盘'}${legacyHelperCleared ? '，已清除 v1.x 旧重启器' : ''}`)
}

/** 供离线自测使用的内部函数（运行时不依赖）。 */
export const internals = {
  renderManagedBlock,
  writeManagedBlock,
  removeManagedBlock,
  readManagedBinding,
  findManagedSpan,
  findLegacyEntries,
  removeLegacyEntries,
  isEntrylessDocument,
  ensureArrayDocument,
  splitPatchGroups,
  removeLegacyRestartHelper,
  isOurLegacyRestartHelper,
  isDefaultDesiredState,
  needsManagedBlockFor,
  MANAGED_BEGIN,
  MANAGED_END,
  LEGACY_MANAGED_BEGIN,
  LEGACY_MANAGED_END,
  SETTINGS_FILENAME,
  LEGACY_SETTINGS_FILENAME,
  LEGACY_RESTART_HELPER_FILENAME,
  ROUTE_PREFIX,
  isIpv4,
  isBareAuthority,
  rewriteIngressHeaders,
  RESTART_HELPER_SOURCE,
}
