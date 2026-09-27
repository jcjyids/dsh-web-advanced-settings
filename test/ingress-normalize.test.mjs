#!/usr/bin/env node
/**
 * ingress-normalize.test.mjs —— 局域网入口头规范化自测。
 *
 * 对应两个真实远程访问缺陷：
 *   · dsh-plugin 插件市场的 `isSameOrigin()` 要求 Origin 主机名 ∈
 *     {localhost,127.0.0.1,[::1]}，局域网 Origin 会被 403“瞬间不可达”；
 *   · 官方 settings / 特权方法同样按“是否回环来源”判定。
 *
 * 这里是纯函数级验证：改写只针对 Host 恰好是本机非回环 IPv4 的请求，
 * 未知 Host（DNS rebinding 的攻击域名）必须原样保留。
 */
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
void resolve(HERE, '..')
const { internals } = await import(new URL('../index.js', import.meta.url).href)

const LAN = '192.168.1.50'
const PORT = 3080
const IPS = new Set([LAN, '10.0.0.7'])

/** dsh-plugin/lib/http/routes.js 的 isSameOrigin 原样复刻。 */
function marketSameOrigin(headers) {
  const origin = headers.origin
  const host = headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const url = new URL(origin)
    const localHostnames = new Set(['localhost', '127.0.0.1', '[::1]'])
    return url.host === host && localHostnames.has(url.hostname)
  } catch {
    return false
  }
}

/** 官方 Host/Origin 围栏的关键判据（回环 Host 直接可信）。 */
function fenceTrustsHost(headers) {
  const host = headers.host
  if (host === undefined) return false
  try {
    const url = new URL(`http://${host}`)
    const parts = url.hostname.split('.')
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
      || (parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
    return loopback
  } catch {
    return false
  }
}

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

console.log('ingress-normalize.test.mjs')

test('局域网 Host/Origin 被改写成回环权威（含 Referer 与 Sec-Fetch-Site）', () => {
  const headers = {
    host: `${LAN}:${PORT}`,
    origin: `http://${LAN}:${PORT}`,
    referer: `http://${LAN}:${PORT}/settings`,
    'sec-fetch-site': 'cross-site',
  }
  const changed = internals.rewriteIngressHeaders(headers, { enabled: true, port: PORT, ips: IPS })
  assert.equal(changed, true)
  assert.equal(headers.host, `127.0.0.1:${PORT}`)
  assert.equal(headers.origin, `http://127.0.0.1:${PORT}`)
  assert.equal(headers.referer, `http://127.0.0.1:${PORT}/settings`)
  assert.equal(headers['sec-fetch-site'], 'same-origin')
})

test('改写后 dsh-plugin 的 isSameOrigin 判定通过（缺陷 ② 的回归点）', () => {
  const before = { host: `${LAN}:${PORT}`, origin: `http://${LAN}:${PORT}` }
  assert.equal(marketSameOrigin(before), false, '改写前必须复现 403 判定')
  const headers = { ...before }
  internals.rewriteIngressHeaders(headers, { enabled: true, port: PORT, ips: IPS })
  assert.equal(marketSameOrigin(headers), true, '改写后必须通过')
})

test('改写后官方围栏看到回环 Host', () => {
  const headers = { host: `10.0.0.7:${PORT}`, origin: 'http://10.0.0.7:3080' }
  internals.rewriteIngressHeaders(headers, { enabled: true, port: PORT, ips: IPS })
  assert.equal(fenceTrustsHost(headers), true)
})

test('未知 Host（DNS rebinding 域名）绝不改写', () => {
  const headers = { host: `evil.example:${PORT}`, origin: `http://evil.example:${PORT}`, 'sec-fetch-site': 'cross-site' }
  const changed = internals.rewriteIngressHeaders(headers, { enabled: true, port: PORT, ips: IPS })
  assert.equal(changed, false)
  assert.equal(headers.host, `evil.example:${PORT}`)
  assert.equal(headers.origin, `http://evil.example:${PORT}`)
  assert.equal(headers['sec-fetch-site'], 'cross-site')
  assert.equal(fenceTrustsHost(headers), false)
  assert.equal(marketSameOrigin(headers), false)
})

test('回环 Host 与非本机 IP 均不改写', () => {
  for (const host of [`127.0.0.1:${PORT}`, 'localhost:3080', `8.8.8.8:${PORT}`]) {
    const headers = { host, origin: `http://${host}` }
    assert.equal(internals.rewriteIngressHeaders(headers, { enabled: true, port: PORT, ips: IPS }), false, host)
    assert.equal(headers.host, host)
  }
})

test('未开启局域网暴露（mode=loopback）时不改写', () => {
  const headers = { host: `${LAN}:${PORT}`, origin: `http://${LAN}:${PORT}` }
  assert.equal(internals.rewriteIngressHeaders(headers, { enabled: false, port: PORT, ips: IPS }), false)
  assert.equal(headers.host, `${LAN}:${PORT}`)
})

test('端口 / 网卡集合缺失时安全退化', () => {
  const headers = { host: `${LAN}:${PORT}`, origin: `http://${LAN}:${PORT}` }
  assert.equal(internals.rewriteIngressHeaders(headers, { enabled: true, port: null, ips: IPS }), false)
  assert.equal(internals.rewriteIngressHeaders(headers, { enabled: true, port: PORT, ips: new Set() }), false)
  assert.equal(internals.rewriteIngressHeaders(undefined, { enabled: true, port: PORT, ips: IPS }), false)
  assert.equal(headers.host, `${LAN}:${PORT}`)
})

test('只有 Origin 指向局域网时才会重写 Origin；缺头不报错', () => {
  const headers = { host: `${LAN}:${PORT}` }
  assert.equal(internals.rewriteIngressHeaders(headers, { enabled: true, port: PORT, ips: IPS }), true)
  assert.equal(headers.host, `127.0.0.1:${PORT}`)
  assert.equal(headers.origin, undefined)
  assert.equal(headers['sec-fetch-site'], 'same-origin')

  const mixed = { host: `${LAN}:${PORT}`, origin: 'https://evil.example' }
  internals.rewriteIngressHeaders(mixed, { enabled: true, port: PORT, ips: IPS })
  assert.equal(mixed.origin, 'https://evil.example', '外部 Origin 不改写')
})

test('非法 Origin / Referer 不影响 Host 改写且不抛错', () => {
  const headers = { host: `${LAN}:${PORT}`, origin: 'not a url', referer: ':::' }
  assert.equal(internals.rewriteIngressHeaders(headers, { enabled: true, port: PORT, ips: IPS }), true)
  assert.equal(headers.host, `127.0.0.1:${PORT}`)
  assert.equal(headers.origin, 'not a url')
  assert.equal(headers.referer, ':::')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
