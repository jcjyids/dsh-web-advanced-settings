/**
 * dsh-advanced-listening-settings —— 浏览器半边（手写 client bundle）
 *
 * 形态与官方客户端插件一致：一段注册到 window.__ModuleLoader__ 的工厂函数，
 * 不经过打包器，只依赖 shell 基线模块（react）。
 *
 * 注册 id 必须等于「包名」，也就是宿主行 name（官方 dsh-client-modules 用
 * entry.options.name 作为 boot graph 的 row id）；写成别的字符串会让
 * “bundle loaded without registering …” 直接把整个插件憋死。
 *
 * 它把自己注册进 `settings.section`（设置页的一个独立分区），
 * 所有数据来自同源接口 `/advanced-listening/*`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-advanced-listening-settings',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const e = React.createElement

    const API = '/advanced-listening'
    const SECTION_ID = 'advanced-listening'
    const NS = 'dal'

    /* ───────────────────────────── 样式 ───────────────────────────── */

    const CSS = `
.${NS}-root{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;max-width:760px;padding-bottom:24px}
.${NS}-title{font-size:16px;font-weight:600;line-height:24px}
.${NS}-muted{color:var(--dsw-alias-label-secondary)}
.${NS}-small{font-size:12px;line-height:18px}
.${NS}-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.${NS}-card-title{font-weight:600;display:flex;align-items:center;gap:8px}
.${NS}-row{display:flex;align-items:flex-start;gap:10px}
.${NS}-label{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.${NS}-label input{width:15px;height:15px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary);margin:0}
.${NS}-ips{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.${NS}-ip{display:flex;align-items:center;gap:8px}
.${NS}-ip address{font-style:normal;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.${NS}-disabled{opacity:.45;pointer-events:none}
.${NS}-input{width:110px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:inherit;font:inherit}
.${NS}-input:disabled{opacity:.5}
.${NS}-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.${NS}-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;cursor:pointer}
.${NS}-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.${NS}-btn-primary{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}
/* 禁用态：显式换成中性灰（底色 + 次要文字色），而不是给按钮整体加透明度——
   后者会让文字和底色一起变淡，浅色主题下主色按钮上的白字几乎看不见。 */
.${NS}-btn:disabled,.${NS}-btn-primary:disabled{opacity:1;cursor:not-allowed;background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.${NS}-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.${NS}-note{display:flex;gap:8px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.${NS}-note-ok{border-color:var(--dsw-alias-state-success-primary)}
.${NS}-note-warn{border-color:var(--dsw-alias-state-warn-primary)}
.${NS}-note-pending{border-color:var(--dsw-alias-state-warn-primary)}
.${NS}-note-error{border-color:var(--dsw-alias-state-error-primary)}
.${NS}-banner{padding:9px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2)}
.${NS}-danger{padding:9px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.${NS}-url{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.${NS}-url code{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
.${NS}-pre{margin:0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow:auto;max-height:260px}
.${NS}-kv{display:grid;grid-template-columns:118px 1fr;gap:4px 10px}
.${NS}-kv dt{color:var(--dsw-alias-label-secondary)}
.${NS}-kv dd{margin:0;overflow-wrap:anywhere}
.${NS}-link{background:none;border:none;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;padding:0}
.${NS}-status{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px}
.${NS}-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.${NS}-dot-ok{background:var(--dsw-alias-state-success-primary)}
.${NS}-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.${NS}-dot-error{background:var(--dsw-alias-state-error-primary)}
`

    function useCss() {
      useEffect(() => {
        const tagId = 'dsh-advanced-listening-settings/section.css'
        if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return undefined
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-advanced-listening-settings'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
        }
      }, [])
    }

    /* ─────────────────────────── 接口调用 ─────────────────────────── */

    async function call(path, body) {
      const response = await fetch(API + path, body === undefined
        ? { cache: 'no-store' }
        : {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error((payload && payload.error) || ('HTTP ' + String(response.status)))
      return payload
    }

    async function loadState(attempt) {
      const tries = attempt ?? 0
      try {
        return await call('/state')
      } catch (error) {
        if (tries >= 4) throw error
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
        return await loadState(tries + 1)
      }
    }

    async function copyText(value) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch {
        /* 回退到 execCommand */
      }
      try {
        const area = document.createElement('textarea')
        area.value = value
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    /* ─────────────────────────── 小组件 ─────────────────────────── */

    function Card(props) {
      return e('section', { className: NS + '-card' }, props.title === undefined ? null : e('div', { className: NS + '-card-title' }, props.title), props.children)
    }

    function Note(props) {
      return e('div', { className: NS + '-note ' + NS + '-note-' + (props.level || 'ok') }, e('span', null, props.text))
    }

    function Toggle(props) {
      return e('label', { className: NS + '-label' }, e('input', {
        type: 'checkbox',
        checked: props.checked === true,
        disabled: props.disabled === true,
        onChange: (event) => props.onChange(event.target.checked),
      }), e('span', null, props.label))
    }

    function StatusPill(props) {
      return e('span', { className: NS + '-status' },
        e('span', { className: NS + '-dot ' + NS + '-dot-' + (props.level || 'ok') }),
        props.text)
    }

    /* ─────────────────────── 二级页：访问地址 ─────────────────────── */

    function AddressPage(props) {
      const [copied, setCopied] = useState(null)
      const urls = props.state.urls
      return e('div', { className: NS + '-root' },
        e('div', { className: NS + '-row' },
          e('button', { type: 'button', className: NS + '-link', onClick: props.onBack }, '← 返回'),
          e('div', { className: NS + '-title' }, '访问地址')),
        e('div', { className: NS + '-muted' }, urls.length === 0
          ? '当前没有可用的外部地址。'
          : '下面是当前实际可用的入口地址，点击复制后在浏览器打开即可。'),
        props.state.desired.disableAuth
          ? e('div', { className: NS + '-banner' }, '已取消鉴权：这些地址不带 token，直接打开即可（Host/Origin 围栏仍在）。')
          : e('div', { className: NS + '-small ' + NS + '-muted' }, '带 token 的地址每次重启 dsh 都会变化，并且只在当前进程内有效；用它打开一次后浏览器会记住签名 Cookie。'),
        urls.map((item) => e('div', { className: NS + '-url', key: item.authority },
          e('span', { className: NS + '-small ' + NS + '-muted', style: { minWidth: 72 } }, item.label),
          e('code', null, item.url),
          e('button', {
            type: 'button',
            className: NS + '-btn',
            onClick: () => { void copyText(item.url).then((ok) => setCopied(ok ? item.authority : null)) },
          }, copied === item.authority ? '已复制' : '复制'))))
    }

    /* ─────────────────── 二级页：配置与清理 ─────────────────── */

    function ConfigPage(props) {
      const state = props.state
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)

      const runCleanup = (action) => {
        setBusy(true)
        setMessage(null)
        call('/cleanup', { confirm: true, action })
          .then((payload) => {
            const parts = []
            if (typeof payload.removedLegacy === 'number' && payload.removedLegacy > 0) parts.push('已移除 ' + String(payload.removedLegacy) + ' 个旧条目')
            if (payload.removedManaged === true) parts.push('已移除托管块')
            if (payload.removedHelper === true) parts.push('已删除 v1.x 旧重启器文件')
            setMessage(parts.join('，') || '没有需要清理的内容')
            return props.onRefresh()
          })
          .catch((error) => setMessage('操作失败：' + String(error.message || error)))
          .finally(() => setBusy(false))
      }

      const cleanup = state.cleanup || {}
      const uninstall = String(cleanup.uninstallCommand || 'dsh plugin --profile web remove dsh-advanced-listening-settings')

      return e('div', { className: NS + '-root' },
        e('div', { className: NS + '-row' },
          e('button', { type: 'button', className: NS + '-link', onClick: props.onBack }, '← 返回'),
          e('div', { className: NS + '-title' }, '配置与清理')),
        e(Card, { title: '文件位置' },
          e('dl', { className: NS + '-kv' },
            e('dt', null, 'profile'), e('dd', null, String(state.profile || '-') + '（来源 ' + String(state.profileSource || '-') + '）'),
            e('dt', null, '设置文件'), e('dd', null, cleanup.settingsExists === false ? e('span', { className: NS + '-muted' }, '当前为出厂默认，未落盘') : e('code', null, state.settingsPath)),
            e('dt', null, '组合补丁'), e('dd', null, e('code', null, state.patchPath)),
            e('dt', null, '插件版本'), e('dd', null, state.version))),
        e(Card, { title: '出厂态' },
          e('div', { className: NS + '-small ' + NS + '-muted' },
            cleanup.pristine === true
              ? '当前已是出厂态：没有设置文件、没有托管块、没有旧条目，插件在 profile / DSH 主目录里没有留下任何东西。'
              : '当前还不是出厂态（存在设置文件 / 托管块 / 旧条目之一）。想让卸载完全无残留，先点下面的「完全清理」。')),
        e(Card, { title: '托管块' },
          e('div', { className: NS + '-small ' + NS + '-muted' },
            state.managed === null
              ? '当前组合补丁里没有托管块：绑定地址由官方默认值或命令行决定（回环 + 默认端口时本插件刻意不写块）。'
              : '绑定地址 ' + String(state.managed.host) + '，端口 ' + String(state.managed.port) + '。这一段由插件维护，请勿手工编辑。'),
          state.managed === null ? null : e('div', { className: NS + '-actions' },
            e('button', { type: 'button', className: NS + '-btn ' + NS + '-btn-danger', disabled: busy, onClick: () => runCleanup('remove-managed') }, '移除托管块'))),
        e(Card, { title: '旧条目检测' },
          e('div', { className: NS + '-small ' + NS + '-muted' },
            state.legacy.length === 0
              ? '没有检测到旧条目。'
              : '检测到 ' + String(state.legacy.length) + ' 个早期条目（内容见下）。它们已被托管块覆盖，清理后不会改变当前监听行为。'),
          state.legacy.map((item, index) => e('pre', { className: NS + '-pre', key: String(index) }, item.preview)),
          state.legacy.length === 0 ? null : e('div', { className: NS + '-actions' },
            e('button', { type: 'button', className: NS + '-btn ' + NS + '-btn-danger', disabled: busy, onClick: () => runCleanup('remove-legacy') }, '一键清理旧条目'))),
        e(Card, { title: '完全清理（卸载前）' },
          e('div', { className: NS + '-small ' + NS + '-muted' },
            '一次性收回本插件在 profile 与 DSH 主目录里写下的全部内容：托管块、旧条目、设置文件、v1.x 遗留的重启器。' +
            '清理后插件仍在运行（当前监听不变），但已经没有任何持久化痕迹 —— 此时卸载即可回到装前状态。'),
          e('div', { className: NS + '-small ' + NS + '-muted' }, '卸载命令：', e('code', null, uninstall)),
          e('div', { className: NS + '-actions' },
            e('button', { type: 'button', className: NS + '-btn ' + NS + '-btn-danger', disabled: busy, onClick: () => runCleanup('purge') }, '完全清理')),
          e('div', { className: NS + '-small ' + NS + '-muted' },
            '卸载后才发现有残留？插件已不在本地也能清理：',
            e('code', null, 'npx -y dsh-advanced-listening-settings cleanup'))),
        message === null ? null : e(Note, { level: 'ok', text: message }))
    }

    /* ─────────────────────────── 主界面 ─────────────────────────── */

    /** 前端侧归一化：'ips' 但没勾任何地址等价于仅本机（服务端也会这样收敛）。 */
    function normalizeState(payload) {
      const desired = payload.desired || {}
      const ips = Array.isArray(desired.ips) ? desired.ips.filter((value) => typeof value === 'string') : []
      const mode = desired.mode === 'ips' && ips.length === 0 ? 'loopback' : (desired.mode || 'loopback')
      return { ...payload, desired: { ...desired, mode, ips } }
    }

    function Section() {
      useCss()
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notes, setNotes] = useState([])
      const [view, setView] = useState('main')
      const [global, setGlobal] = useState(false)
      const [ips, setIps] = useState([])
      const [port, setPort] = useState('3080')
      const [disableAuth, setDisableAuth] = useState(false)
      const [armed, setArmed] = useState(false)
      const [restarting, setRestarting] = useState(false)
      const [restartTarget, setRestartTarget] = useState(null)
      const mounted = useRef(true)

      const hydrate = useCallback((payload) => {
        const next = normalizeState(payload)
        setState(next)
        setGlobal(next.desired.mode === 'all')
        setIps(Array.isArray(next.desired.ips) ? next.desired.ips : [])
        setPort(String(next.desired.port))
        setDisableAuth(next.desired.disableAuth === true)
        setNotes(Array.isArray(next.notes) ? next.notes : [])
      }, [])

      const refresh = useCallback(() => loadState().then((payload) => {
        if (!mounted.current) return null
        hydrate(payload)
        setError(null)
        return payload
      }).catch((reason) => {
        if (mounted.current) setError(String(reason.message || reason))
        return null
      }), [hydrate])

      useEffect(() => {
        mounted.current = true
        void refresh()
        return () => { mounted.current = false }
      }, [refresh])

      const desiredMode = global ? 'all' : (ips.length > 0 ? 'ips' : 'loopback')

      const dirty = state !== null && (
        desiredMode !== state.desired.mode ||
        String(port) !== String(state.desired.port) ||
        disableAuth !== (state.desired.disableAuth === true) ||
        JSON.stringify([...ips].sort()) !== JSON.stringify([...state.desired.ips].sort())
      )

      const save = () => {
        const portNumber = Number(port)
        if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
          setError('端口必须是 1–65535 的整数')
          return
        }
        setBusy(true)
        setError(null)
        call('/save', { mode: desiredMode, ips, port: portNumber, disableAuth })
          .then((payload) => {
            if (!mounted.current) return
            hydrate(payload)
          })
          .catch(async (reason) => {
            // 绑定类改动会触发热重载，响应可能被掐断：等一拍再拉一次状态。
            const payload = await loadState().catch(() => null)
            if (!mounted.current) return
            if (payload !== null) {
              hydrate(payload)
              setNotes([{ key: 'save', level: 'ok', text: '已保存（热重载导致连接抖动，已重新读取状态）' }])
            } else {
              setError(String(reason.message || reason))
            }
          })
          .finally(() => { if (mounted.current) setBusy(false) })
      }

      const doRestart = () => {
        const lan = state !== null && Array.isArray(state.urls) ? state.urls.find((item) => item.label === '局域网') : undefined
        const host = lan === undefined ? '127.0.0.1' : lan.authority.split(':')[0]
        setRestartTarget('http://' + host + ':' + String(port))
        setRestarting(true)
        setBusy(true)
        call('/restart', { confirm: true })
          .catch(() => null)
          .finally(() => { if (mounted.current) setBusy(false) })
      }

      // 重启后轮询：接口回来即说明新实例已就绪，直接刷新页面。
      useEffect(() => {
        if (!restarting) return undefined
        let alive = true
        let attempts = 0
        const timer = setInterval(() => {
          attempts += 1
          void call('/state').then(() => {
            if (!alive) return
            alive = false
            window.location.reload()
          }).catch(() => {
            if (attempts > 80 && alive) {
              alive = false
              clearInterval(timer)
            }
          })
        }, 1200)
        return () => { alive = false; clearInterval(timer) }
      }, [restarting])

      if (error !== null && state === null) {
        return e('div', { className: NS + '-root' }, e(Note, { level: 'error', text: '无法读取状态：' + error }))
      }
      if (state === null) {
        return e('div', { className: NS + '-root' }, e('div', { className: NS + '-muted' }, '正在读取配置…'))
      }
      if (restarting) {
        return e('div', { className: NS + '-root' },
          e('div', { className: NS + '-title' }, '正在重启 dsh…'),
          e('div', { className: NS + '-muted' }, '新实例就绪后本页会自动刷新；若端口发生变化，请改用新地址打开。'),
          restartTarget === null ? null : e('div', { className: NS + '-url' }, e('code', null, restartTarget)))
      }
      if (view === 'addresses') return e(AddressPage, { state, onBack: () => setView('main') })
      if (view === 'config') return e(ConfigPage, { state, onBack: () => setView('main'), onRefresh: refresh })

      const cliPortOverride = typeof state.cli.port === 'number'
      const interfaces = state.interfaces
      const exposure = state.exposure || { level: 'ok' }
      const authOn = state.effective.authBypass || disableAuth

      return e('div', { className: NS + '-root' },
        e('div', null,
          e('div', { className: NS + '-title' }, '高级监听设置'),
          e('div', { className: NS + '-row', style: { flexWrap: 'wrap', gap: 8, marginTop: 4 } },
            e(StatusPill, { level: 'ok', text: '监听 ' + String(state.effective.host) + ':' + String(state.effective.port) }),
            e(StatusPill, { level: authOn ? 'warn' : 'ok', text: authOn ? '鉴权已取消' : '鉴权已开启' }),
            e(StatusPill, {
              level: state.frontDoor.length === 0 ? 'ok' : (state.frontDoor.some((item) => item.state === 'error') ? 'error' : 'ok'),
              text: '直通监听 ' + (state.frontDoor.length === 0
                ? '无'
                : state.frontDoor.map((item) => item.address + '(' + item.state + ')').join(', ')),
            }))),

        exposure.level === 'danger'
          ? e('div', { className: NS + '-danger' }, '危险：全局监听 + 免鉴权同时开启，任何能访问该端口的人都能操控你的 DSH。')
          : null,

        state.effective.pendingRestart
          ? e('div', { className: NS + '-banner' }, '有改动尚未生效（' + state.effective.pending.join('、') + '）：热重载/重启后按新配置监听。')
          : null,

        e(Card, { title: '监听范围' },
          e('div', null,
            e(Toggle, {
              checked: global,
              label: '全局监听（0.0.0.0）',
              onChange: (value) => {
                setGlobal(value)
                if (value) setIps([])
              },
            }),
            e('div', { className: NS + '-small ' + NS + '-muted' }, '绑定所有网卡，局域网内任意地址都能连上。勾选后下面的本机 IP 列表不再参与监听。')),
          e('div', { className: NS + '-row', style: { flexDirection: 'column', gap: 6 } },
            e('div', { className: NS + '-label', style: { cursor: 'default' } }, e('span', null, '本机 IP 地址')),
            e('div', { className: NS + '-small ' + NS + '-muted' }, '只监听勾选的地址（插件为每个地址建立一条 TCP 直通监听）；默认全不勾选 = 仅本机可访问。'),
            e('div', { className: NS + '-ips' + (global ? ' ' + NS + '-disabled' : '') },
              interfaces.length === 0
                ? e('div', { className: NS + '-small ' + NS + '-muted' }, '没有检测到可用的 IPv4 网卡。')
                : interfaces.map((item) => e('label', { className: NS + '-label ' + NS + '-ip', key: item.address },
                    e('input', {
                      type: 'checkbox',
                      checked: ips.includes(item.address),
                      onChange: (event) => {
                        setIps((previous) => event.target.checked
                          ? [...previous, item.address]
                          : previous.filter((value) => value !== item.address))
                      },
                    }),
                    e('address', null, item.address),
                    e('span', { className: NS + '-small ' + NS + '-muted' }, item.adapter)))),
            global
              ? e('div', { className: NS + '-small ' + NS + '-muted' }, '已开启全局监听，本机 IP 列表不参与监听范围。')
              : null,
            state.frontDoor.filter((item) => item.state === 'error').map((item) => e(Note, {
              level: 'error',
              key: item.address,
              text: '直通监听 ' + item.address + ':' + String(item.port) + ' 失败（' + String(item.error) + '，已自动重试 ' + String(item.attempts) + ' 次）',
            }))),
          e('div', { className: NS + '-row', style: { flexDirection: 'column', gap: 6 } },
            e('div', { className: NS + '-row' },
              e('span', null, '端口'),
              e('input', {
                className: NS + '-input',
                type: 'number',
                min: 1,
                max: 65535,
                value: port,
                disabled: cliPortOverride,
                onChange: (event) => setPort(event.target.value),
              }),
              cliPortOverride
                ? e('span', { className: NS + '-small ' + NS + '-muted' }, '命令行 --port ' + String(state.cli.port) + ' 生效中，实际使用 ' + String(state.effective.port) + ' 端口')
                : null),
            e('div', { className: NS + '-small ' + NS + '-muted' }, '默认 3080。带 --port 启动时以命令行为准，此处不可编辑。'))),

        e(Card, { title: '鉴权' },
          e(Toggle, {
            checked: disableAuth,
            label: '取消鉴权（不需要 token）',
            onChange: setDisableAuth,
          }),
          e('div', { className: NS + '-small ' + NS + '-muted' }, '勾选后，输入正确的 IP 与端口即可直接访问；Host/Origin 来源校验仍然保留。'),
          disableAuth
            ? e('div', { className: NS + '-danger' }, '危险：任何能访问该地址的人都能操控你的 DSH（执行命令、读写工作区文件）。请只在可信网络里使用。')
            : null),

        e('div', { className: NS + '-actions' },
          e('button', {
            type: 'button',
            className: NS + '-btn ' + NS + '-btn-primary',
            disabled: busy || !dirty,
            title: dirty ? undefined : '没有未保存的改动',
            onClick: save,
          }, busy ? '处理中…' : '保存并应用'),
          e('button', {
            type: 'button',
            className: NS + '-btn',
            onClick: () => setView('addresses'),
          }, '访问地址…'),
          e('button', { type: 'button', className: NS + '-btn', onClick: () => setView('config') }, '配置与清理…'),
          armed
            ? e('span', { className: NS + '-actions' },
                e('button', { type: 'button', className: NS + '-btn ' + NS + '-btn-danger', disabled: busy, onClick: doRestart }, '确认重启（会中断所有会话）'),
                e('button', { type: 'button', className: NS + '-btn', onClick: () => setArmed(false) }, '取消'))
            : e('button', { type: 'button', className: NS + '-btn ' + NS + '-btn-danger', onClick: () => setArmed(true) }, '重启 dsh')),
        disableAuth
          ? e('div', { className: NS + '-small ' + NS + '-muted' }, '已取消鉴权：不需要带 token 的地址，直接访问 IP:端口 即可。')
          : null,
        e('div', { className: NS + '-small ' + NS + '-muted' },
          '「重启 dsh」会在后台按原命令重新拉起一个新实例，日志写到 ~/.dsh/logs/。' +
          (state.bindApplyMode === 'live' ? '绑定地址与端口保存后热重载即时生效。' : '绑定地址与端口在重启后生效。')),

        e('div', { className: NS + '-small ' + NS + '-muted' }, '本页说明：' +
          '全局监听让所有网卡都可访问；本机 IP 列表用于把监听收敛到指定网卡；端口决定对外服务端口；取消鉴权会去掉 token 校验。'),

        notes.map((note) => e(Note, { key: note.key, level: note.level, text: note.text })),
        error === null ? null : e(Note, { level: 'error', text: error }))
    }

    /* ─────────────────────────── 注册 ─────────────────────────── */

    function apply(ctx) {
      // 非回环页面（局域网 / 隧道域名）下，官方客户端把页面判成“非宿主面”：
      // dsh-client-ui-settings 会 `ctx.remote.$host.isLoopback ? 'host' : 'memory'`，
      // 远程访问时设置文档降级为 memory，模型/凭据设置页直接报
      // “settings are unavailable in this browser”。这里把连接句柄的
      // isLoopback 断言为真（与社区 dsh-pocket 同源），可逆还原。
      ctx.effect(() => {
        const connection = ctx.connection
        if (connection === undefined || connection === null) return undefined
        const before = Object.getOwnPropertyDescriptor(connection, 'isLoopback')
        try {
          Object.defineProperty(connection, 'isLoopback', { value: true, writable: true, configurable: true })
        } catch {
          try {
            connection.isLoopback = true
          } catch {
            // 只读属性：放弃断言，宿主侧入口改写仍是主要修复
          }
        }
        return () => {
          try {
            if (before === undefined) delete connection.isLoopback
            else Object.defineProperty(connection, 'isLoopback', before)
          } catch {
            // 还原失败不影响宿主
          }
        }
      }, 'advanced-listening-settings: 宿主面判定（connection.isLoopback）')

      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: SECTION_ID, order: 70, label: '高级监听设置' },
          Section,
        )),
        'advanced-listening-settings: 设置分区',
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection']
    return module.exports
  },
})
