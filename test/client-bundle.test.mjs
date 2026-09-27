#!/usr/bin/env node
/**
 * client-bundle.test.mjs —— 客户端 bundle（client.js）契约自测。
 *
 * 官方 dsh-client-modules 用 entry.options.name（= 包名）作为 boot graph 的
 * row id，并要求 bundle 用同一个 id 调用 __ModuleLoader__.load；写错就是
 * “bundle loaded without registering …”，整个插件在浏览器里消失。
 *
 * 本测试不依赖浏览器：用 node:vm 造一个最小 __ModuleLoader__ + react 假件，
 * 真正执行一遍工厂函数，验证导出形状与 settings.section 注册契约。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const clientPath = join(PLUGIN_DIR, 'client.js')
const pkgPath = join(PLUGIN_DIR, 'package.json')

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

console.log('client-bundle.test.mjs')

const bytes = readFileSync(clientPath)
const source = bytes.toString('utf8')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

test('client.js 是 UTF-8 且无 BOM', () => {
  assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), '不应有 UTF-8 BOM')
  assert.ok(source.length > 0)
  assert.ok(source.includes('\n'))
})

test('package.json 声明了 dsh.bundle 与 dsh.client(platform=web) 以及 ./client 导出', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(pkg.exports?.['./client'], '必须导出 ./client')
  assert.ok(pkg.files?.includes('client.js'))
})

test('bundle 是 __ModuleLoader__.load 工厂形态，不用 ESM import', () => {
  const code = source.replace(/^\s*(\/\*[\s\S]*?\*\/\s*)*/, '')
  assert.ok(code.startsWith('window.__ModuleLoader__.load({'), '首个非注释语句应是 __ModuleLoader__.load')
  assert.ok(!/^\s*import\s/m.test(source), 'client bundle 不能出现顶层 ESM import')
  assert.ok(source.includes('factory:'))
})

test('注册 id 必须等于包名（否则 boot graph 找不到 factory）', () => {
  const match = /id:\s*'([^']+)'/.exec(source)
  assert.ok(match !== null, '未找到注册 id')
  assert.equal(match[1], pkg.name)
})

test('工厂函数可执行：导出 apply/inject，并注册 settings.section', () => {
  let captured = null
  const fakeReact = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => undefined],
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (registration) => { captured = registration } } },
    console,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Symbol,
    navigator: {},
    document: undefined,
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.ok(captured !== null, '没有调用 __ModuleLoader__.load')
  const mod = captured.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], ['slots', 'connection'])

  let registered = null
  let injected = null
  const disposers = []
  const connection = { isLoopback: false }
  const ctx = {
    connection,
    effect: (fn) => { disposers.push(fn()) },
    slots: {
      inject: (name, cb) => { injected = name; cb() },
      register: (options, component) => { registered = { options, component } },
    },
  }
  mod.apply(ctx)
  assert.equal(connection.isLoopback, true, '局域网页面必须把 isLoopback 断言为真')
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.equal(connection.isLoopback, false, '停用/卸载后必须还原')
  assert.equal(injected, 'settings.section')
  assert.ok(registered !== null, '没有注册 settings.section')
  assert.equal(registered.options.name, 'settings.section')
  assert.equal(registered.options.id, 'advanced-listening')
  assert.equal(typeof registered.options.label, 'string')
  assert.equal(typeof registered.component, 'function')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
