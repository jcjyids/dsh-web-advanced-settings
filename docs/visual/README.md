# 视觉证据

全部来自 `test/e2e-isolated.mjs` 同款的**隔离 profile**（临时 `DSH_HOME` + 高位端口，不接触正在运行的 3080 实例），
用无头 Edge（`--headless=new` + CDP）打开后截取，并逐张 `read_image` 复核。

## 一、v2.0.0 改名后的面板

| 文件 | 图中要点 |
| --- | --- |
| `panel-main.png` | 设置导航与分区标题均为 **高级监听设置**；状态条 `监听 127.0.0.1:7599` / `鉴权已开启` / `直通监听 198.18.0.1(listening)`；勾选态、端口框、鉴权开关、四个操作按钮齐全 |
| `panel-config.png` | 「配置与清理」页：设置文件 = `advanced-listening-settings.json`、插件版本 = `2.0.0`、出厂态提示、托管块（`127.0.0.1:7599`）、**完全清理（卸载前）** 卡片（含卸载命令与 `npx -y dsh-advanced-listening-settings cleanup`） |
| `page-snapshot.html` | 上面同一个面板的渲染 DOM 快照（页面证据，非可交互副本） |

## 二、远程（局域网）访问修复的前后对照

同一个隔离实例，用无头 Edge **从局域网地址**打开（`http://198.18.0.1:<port>/`）：

| 文件 | 时点 | 图中要点 |
| --- | --- | --- |
| `remote-before-models-error.png` | v1.0.1（修复前） | 设置 → 模型：红色报错 `加载提供方目录失败: settings are unavailable in this browser`；`__DSH_TRANSPORT__` 为 `null` |
| `remote-after-models-ok.png` | v2.0.0（修复后） | 同一路径正常渲染：`模型 / 填入各提供方的 API 密钥即可使用其模型 / DeepSeek / deepseek-official / 添加提供方` |

同一浏览器会话里 `fetch('/advanced-listening/whoami')` 返回
`{"host":"127.0.0.1:<port>","referer":"http://127.0.0.1:<port>/","secFetchSite":"same-origin","loopbackAuthority":true,"ingressRewrite":true}`，
即远程页面的真实请求到达宿主时已被规范化为回环权威（插件市场 `isSameOrigin` 因此放行）。

真实第三方路由（用户 profile 里的 `dsh-plugin@1.4.8`）A/B：`POST /dsh-plugin-hub/settings`
在改写不适用时 **403 `untrusted origin`**，规范局域网 Host 时 **200**，未信任外部 Host 仍 **403**。
