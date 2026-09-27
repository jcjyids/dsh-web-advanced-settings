# 外部/官方依据（本次修复的对照资料）

## 本地官方源码（dsh 0.1.5-rc.3 安装内，逐个读过并为修复定契约）

| 路径 | 读到的事实 |
| --- | --- |
| `@deepseek-ai/dsh-host-webserver/lib/index.js` | `WebServer.Config.host` 是 `z.union([z.const('127.0.0.1'), z.const('0.0.0.0')])`；`port` 有 `.natural().max(65535)`；`register` 对重复 `(kind,path)` 直接抛错；`port` getter 返回 `listenedPort`（bind 完成前是 `undefined`） |
| `@deepseek-ai/dsh-web-app/cordis.patch.yml` | 官方 `webserver` 行只声明 5 个 config 键：`host` / `port` / `compression` / `compressionLevel` / `compressionThresholdBytes`；顶层注释写明“组合层补丁是整段替换 config” |
| `@deepseek-ai/dsh-client-connection/lib/index.js` | `requestRejection()` 返回 `403`（Host/Origin 围栏）或 `401`（未认证）；`authorizeIndex()` 负责 index 的 token→Cookie 303 交换；`trustedHosts` 是实例字段，运行时可幂等增删 |
| `@deepseek-ai/dsh-app-boot/lib/index.js` | `applyEntryPatches()`：`- id: <row>` 覆盖整段 `config`；`!!js` 表达式由 Loader 在激活时求值；`watchUserPatches` 在 `patchReload: live` 时重读 profile patch 并 `entry.update()` |
| `@deepseek-ai/dsh-client-modules/lib/index.js` | boot graph 的 row id 是 `entry.options.name`（包名）；bundle 必须用同一 id 调 `__ModuleLoader__.load`，否则 “loaded without registering” |

## 网络检索到的社区/官方资料（web_search，URL 形式引用）

- 官方文档：<https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-server>
- 官方讨论：#7111 “Allow `dsh web --host` to bind a specific LAN interface” — <https://github.com/deepseek-ai/deepseek-harness/discussions/7111>
- 用户点名参考：<https://github.com/AcidGr/dsh-web-lan-access>、<https://github.com/shaobeichen/dsh-pocket>
- 同类实现：<https://github.com/idoall/dsh-lan-guard>、<https://github.com/hchao3335-maker/dsh-lan-gate>、<https://github.com/iTrimut/dsh-Webroad>
- 鉴权闸门覆写先例（PR）：<https://github.com/dsh-tauri/deepseek-harness-desktop/pull/621>

## 结论如何落到代码

1. 官方只允许两个 host 字面量 → “指定 IP 监听”只能用插件自己的 TCP 直通（README 第 1 条）。
2. 组合层补丁整段替换 config → 托管块必须复述官方 5 个键，且用 `!!js ctx.webStartup.* ?? 默认` 保留 `--port/--host` 优先级（测试 `patch-rewrite.test.mjs` 守住）。
3. `requestRejection` 的 403 与 401 是两层 → 免鉴权只摘 401；`authorizeIndex` 的覆写也必须先跑基函数，否则未信任 Host 能拿到 index.html。
4. `webServer.port` 在重新 bind 期间是 `undefined` → 直通监听对账在该窗口必须“按兵不动 + 事后重试”，否则会误关局域网监听。

## v1.0.2 远程访问缺陷的定位依据

| 现象 | 源码位置（dsh 0.1.5-rc.3 / dsh-plugin 1.4.8） | 关键代码 |
| --- | --- | --- |
| 设置 → 模型报 `settings are unavailable in this browser` | `@deepseek-ai/dsh-client-ui-settings/lib/client.js:1345` | `const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"`；`memory` 时 `SettingsDescribeMirror.ensure()` 直接返回，`view` 永远 `undefined` |
| 同上（isLoopback 从哪来） | `@deepseek-ai/dsh-client-connection/lib/client.js:6344` | `isLoopback: transport?.ownsHost === true \|\| pageLocation === void 0 \|\| isLoopbackHostname(pageLocation.hostname)` |
| 同上（$host 如何取） | `@deepseek-ai/dsh-api-gateway/lib/client.js:1453` | `get $host(){ ... isLoopback: this.connection.isLoopback }`（首次访问缓存，`home` 变化才失效） |
| marketplace 诊断瞬间“不可达” | `dsh-plugin/lib/http/routes.js:233` | `isSameOrigin()` 要求 `url.host === host && localHostnames.has(url.hostname)`，`localHostnames = {localhost,127.0.0.1,[::1]}`；不满足即 `403 {error:'untrusted origin'}`（第 254 行 `requireTrustedPost`） |
| 诊断本体的真实探测 | `dsh-plugin/lib/http/routes.js:512-584` | `/dsh-plugin-hub/diagnostics` 走 NDJSON 流式 `probe`/`gitLsRemote`，超时 6000ms——所以“瞬间失败”不可能是网络慢，只能是 403 |
| 社区成熟解法 | `dsh-pocket@2.10.6` `lib/proxy.mjs`（`loopbackAuthority()`）与 `client/client.js:2709` | 入口把 Host/Origin/Referer/Sec-Fetch-Site 改写成 `127.0.0.1:<port>`；客户端 `Object.defineProperty(ctx.connection,'isLoopback',{value:true,...})` |

复现/验证用的对照实验（本次执行）：

- 修复前：局域网打开 → 模型页报错，`__DSH_TRANSPORT__===null`、`hostnameIsLoopback=false`。
- 修复后：同页正常渲染 provider 目录，`__DSH_TRANSPORT__={"ownsHost":true}`；浏览器侧 `fetch('/advanced-listening/whoami')` 显示宿主看到 `host=127.0.0.1:<port>`、`secFetchSite=same-origin`。
- 真实市场路由 A/B：同一台可远程访问实例上，`POST /dsh-plugin-hub/settings` 在改写不适用时 `403 untrusted origin`，规范局域网 Host 时 `200`，外部 Host 仍 `403`。

