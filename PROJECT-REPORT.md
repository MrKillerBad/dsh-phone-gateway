# DSH 局域网网关 —— 项目交接报告

> **这份文档是给「下一个窗口里的你」看的。**
> 它假定读者没有任何本次对话的记忆：读完这一份，应当能独立修改插件、重新构建 APP、
> 跑通全部测试，并且不会再踩一遍已经踩过的坑。
>
> 最后更新：2026-11-11 · 对应版本 **0.1.0（versionCode 1）**

---

## 0. 先用一分钟了解边界

| 事实 | 说明 |
|---|---|
| 这是什么 | 一个 **DSH 的进程内插件**，在同一台电脑的**同一个 DSH 进程**上开一个局域网网关，让手机接入 |
| 不是什么 | 不是第二个 DSH 实例，不是公网穿透，不是远程桌面，不是云同步 |
| 手机拿到什么权限 | **完整 owner 权限**。DSH 分不出「这是手机」——见 §13 |
| 需要联网吗 | 只在同一个 Wi-Fi / 热点内。无公网、无 TLS |
| 谁在用 | 一台电脑 + 最多几台手机；**同一时刻只有一台手机能控制** |

---

## 1. 三条硬性设计约束

这三条是历代 bug 换来的，改动时不要破坏：

1. **绝不能把 DSH 进程弄崩。** 插件跑在 DSH 内部，一个未捕获异常就是整个宿主死亡。
   历史上崩过三次：`createHmac('sha256', null)`、`dgram.send` 回调把 `null` 当 `undefined`、
   以及 `.catch` 里再次 `writeHead` 抛 `ERR_HTTP_HEADERS_SENT` 变成 unhandled rejection。
2. **手机绝不能持有 DSH 凭据。** 代理剥离所有 `Set-Cookie`，手机只拿网关自己签发的设备 cookie。
3. **一个宿主同时只能挂一个目录选择器后端。** 见 §5.4。

---

## 2. 架构总览

```
┌──────────────────────────── 电脑 ────────────────────────────┐
│                                                              │
│  DSH 进程（单实例）                                           │
│   ├─ webServer  监听 127.0.0.1:<随机端口>（--no-open）        │
│   ├─ connection 可签发 authenticatedUrl(token)                │
│   └─ dsh-phone-gateway 插件  ← 本仓库                          │
│        ├─ HTTP 网关   0.0.0.0:8791  （反代到 127.0.0.1:<端口>）│
│        ├─ UDP 发现    0.0.0.0:8792  （应答广播探测）           │
│        └─ 设备存储    $DSH_HOME/storages/lan-gateway/         │
│                        devices.json                           │
└───────────────────────────┬──────────────────────────────────┘
                            │ 局域网 Wi-Fi / 热点
              ┌─────────────┴─────────────┐
              │                           │
       Android APP（WebView 壳）     手机浏览器（备用）
       - UDP 发现地址                 - 手动输入 http://ip:8791
       - 设备 cookie 持久化
       - 心跳重连
```

### 三种渲染来源（很重要）

客户端插件同一份代码会在**三个不同 origin** 下运行：

| origin | 场景 | 能做什么 |
|---|---|---|
| `dsh-app://app` | 电脑上的 DSH 桌面客户端 | 面板可见；**跨源 fetch 被拦**，只能读注入的全局变量 |
| `http://127.0.0.1:<DSH端口>` | 电脑浏览器直连 | 本机，不是「手机」 |
| `http://<局域网IP>:8791` | 手机 | 面板可见；同源，可 fetch 网关路径 |

**推论**：任何需要「从页面读网关数据」的功能，都必须走**同源路由**（`/__lan/*`）或
**注入到 index 的全局变量**，不能从 `dsh-app://` 直接跨源请求。

---

## 3. 目录与文件职责

```
deepseek-dshbridge/
├── dsh-phone-gateway/                 ← 插件本体（14 个 JS，约 5300 行）
│   ├── index.js                     ← 服务器端入口：路由、代理、席位、注入
│   ├── client.js                    ← 客户端入口：侧边栏入口 + 面板 + 目录选择器 UI
│   ├── package.json                 ← 版本、exports、dsh.bundle / dsh.client 声明
│   ├── cordis.patch.yml             ← 装载声明（只有一行 insert，无配置，可移植）
│   ├── icon.svg                     ← 侧边栏图标
│   ├── locale/{zh,en}.json          ← 插件标题/描述（DSH 插件元数据用）
│   ├── README.md                    ← 用户与维护者文档（权威操作说明）
│   ├── assets/
│   │   ├── dsh-phone-gateway.apk              ← 构建产物，由 build.ps1 自动写入
│   │   └── app.json                 ← 版本/大小/构建时间，下载卡片读它
│   └── lib/
│       ├── app-file.js              ← 找到并描述 APK，支持 Range/304
│       ├── auth.js                  ← 向 DSH 换取并缓存浏览器 cookie
│       ├── config.js                ← 配置解析与默认值
│       ├── dirs.js                  ← 受限目录浏览（盘符枚举、越界防护、系统项过滤）
│       ├── discovery.js             ← UDP 应答器
│       ├── net.js                   ← 网段判定、回环判定、地址归一化
│       ├── pair.js                  ← 设备存储：配对码、HMAC cookie、主控角色
│       ├── pair-page.js             ← 配对页 / 设备页 / 占用页（纯字符串模板）
│       ├── proxy.js                 ← HTTP 反代（头改写、内容重写、gzip 回退）
│       ├── qr.js                    ← 手写二维码编码器（零依赖）
│       ├── slot.js                  ← 单控制席位的纯函数规则表
│       └── ws-proxy.js              ← WebSocket 升级的原始字节管道
│
├── android/                         ← APP（2 个 Java 文件，约 1900 行）
│   ├── AndroidManifest.xml          ← versionCode 1 / versionName 0.1.0
│   ├── build/build.ps1              ← 无 Gradle 的完整构建脚本
│   ├── build/dsh-phone-gateway.apk            ← 签名产物
│   ├── build/dsh-phone-gateway.keystore       ← **签名密钥，绝不能删**（口令见本地 `.secrets.local`，不入库）
│   ├── src/com/dsh/lan/MainActivity.java  ← WebView 壳、心跳、UI 覆盖层
│   ├── src/com/dsh/lan/Discovery.java     ← UDP 广播发现
│   ├── res/mipmap-*/ic_launcher.png ← 图标（make_icons.py 生成）
│   ├── make_icons.py                ← 图标生成脚本（build.ps1 会调用）
│   ├── README.md                    ← APP 侧文档
│   └── AGENTS.md                    ← **改 Java 前必读**（无 Gradle、BOM、d8 的坑）
│
├── tools/                           ← 15 套测试 + 4 个诊断脚本
└── dsh-phone-gateway-HANDOFF.md       ← 早期设计记录（历史文档，非当前状态）
```

---

## 4. 核心数据与状态

### 4.1 设备存储

```
$DSH_HOME/storages/lan-gateway/devices.json
```

若 `DSH_HOME` 未设置则退化为 `<cwd>/.dsh/storages/...`。实际机器上通常是
`D:\A\DSH\storages\lan-gateway\devices.json`。

```jsonc
{
  "version": 1,
  "secret": "<32 字节 base64url，HMAC 密钥>",
  "primaryDeviceId": "<主控设备 id>",
  "devices": [
    { "id": "…", "label": "<UA 前 100 字符>", "issuedAt": 0, "expiresAt": 0, "lastSeenAt": 0 }
  ]
}
```

**规则**

- `label` 上限 100 字符（页面、存储、UA 截断三处必须一致，历史上不一致导致过重复行）。
- **同 label 重配会替换旧记录**（手机重装后不会堆积）。
- `primaryDeviceId` 永远是「某个已存在设备的 id」或 `null`。吊销主控后自动把角色交给
  **剩余设备里 issuedAt 最早的那台**；加载时若角色无效也走同一补位。
- `secret` 只生成一次，重置它等于让所有手机重新配对。

### 4.2 设备 cookie

格式：`<deviceId>.<expiresAt>.<HMAC-SHA256(base64url)>`，Cookie 名 `dsh-phone-gateway-device`，
`HttpOnly; SameSite=Lax; Path=/`。

- `verify()` 是**同步且绝不抛**的（它在请求路径里，抛了就崩进程）。
- 有效期由 `deviceTtlDays`（默认 180）决定。
- 吊销后再用旧 cookie 无效——`verify` 要求设备记录仍存在。

### 4.3 单控制席位（运行时状态，不持久化）

内存里只有一份：

```js
let activeSession = { deviceId, socket | null } | null
```

- `socket` 非空表示持有者是通过 WebSocket 占位的，夺位时可以 `destroy()` 踢它。
- 进程重启 / 插件重载后席位为空（谁先来谁用），这是**预期行为**。

### 4.4 主控 vs 席位

| 概念 | 存在哪里 | 何时变化 |
|---|---|---|
| **主控**（primary） | 设备存储，持久化 | 首次配对 / 配置页指定 / 吊销后补位 |
| **席位**（seat） | 内存 | 任何一次真实请求或 WS 升级 |

---

## 5. 关键设计决策（含被否决的方案）

这一节是为了防止「下一个窗口把已经否决的方案再实现一遍」。

### 5.1 为什么用原始 TCP 管道代理 WebSocket

不自己实现 WebSocket 客户端，因为那要连带实现 `permessage-deflate` 压缩协商。
`lib/ws-proxy.js` 只改 `Host`/`Origin`、注入 cookie，其余字节原样透传。

### 5.2 为什么改写 Host / Origin

DSH 有 `/api` 同源栅栏和 cookie 的 authority 绑定。把 `Host`/`Origin` 改成回环 authority
一次性满足两者，代价是 DSH 认为「这就是 owner」。

### 5.3 为什么首页要改写 viewport

前端没有响应式断点。手机收到 `width=device-width` 会把桌面布局按手机宽度渲染——**放大数倍**。
所以 `injectViewport()` 把它换成 `width=1024`。

> 该函数容忍属性顺序、单双引号；**找不到标签会主动插入一个**。
> 正则若只认 `name` 在前的写法，DSH 换一种输出顺序就会静默失效。

### 5.4 目录选择器：为什么不用 DSH 自带的

DSH 的两个后端**只能挂一个**（重复 `directoryPicker` 服务会抛）：

| 后端 | 提供 | 代价 |
|---|---|---|
| `-native`（Windows 上 `-auto` 选的就是它） | 只有 `pick()` + `capability()`，弹**电脑上的原生对话框** | 没有 `list` / `createDirectory` |
| `-browse` | 有 `list` / `createDirectory` | **电脑失去原生对话框**，手机端也没有盘符切换 |

曾尝试全量切到 `-browse`：电脑端对话框跟着退化、没有盘符切换、系统目录直接抛 `EPERM`，
**已被用户否决，不要重试**。

现方案：电脑保留原生对话框（`-auto`），手机用我们自己的 `/__lan/dirs` + 网页 UI。
接管方式是客户端插件读 `globalThis.__DSH_DIRECTORY_PICKER__`——**这是 DSH 的内部约定，
不是公开 API**。DSH 若改名，手机选择器会静默退回「弹在电脑上」。

### 5.5 为什么踢出用 302 而不是 403

旧版 APP 没有席位监听脚本，收到 403 会停在原地继续显示已渲染的界面（看起来像「两台共存」）。
**302 会被任何 WebView 跟随**，把旧客户端也带走。这是唯一不依赖客户端版本的手段。

### 5.6 为什么席位监听注入在 `<head>`

被踢的手机常常已经因为 403 请求而渲染空白。把监听放进插件 bundle 意味着它依赖应用正常启动；
放进 `<head>` 的独立脚本则挂在活动文档上，**应用崩了也照样跳转**。

---

## 6. 端点清单

### 6.1 网关自己的路径（`0.0.0.0:8791`）

| 路径 | 方法 | 谁能访问 | 作用 |
|---|---|---|---|
| `/__lan/status` | GET | **仅回环** | 诊断用 JSON（端口、cookie 状态、接口、设备、席位） |
| `/__lan/devices` | GET/POST | **仅回环** | 设备页；POST `{revoke}` 或 `{setPrimary}` |
| `/__lan/code` | POST | **仅回环** | 生成 6 位配对码 |
| `/__lan/pair` | GET/POST | 任何（网段内） | 配对页 / 提交配对码 |
| `/__lan/app` | GET/HEAD | 任何（网段内，**未配对也可**） | 下载 APK |
| `/__lan/busy` | GET | 已配对设备 | 占用页；席位空闲时 302 回 `/` |
| 其他一切 | * | 已配对设备（且持有席位） | 反代到 DSH |

### 6.2 挂在 DSH 服务器上的同源路由

这些由插件通过 `ctx.webServer.register` 注入 DSH 自己的服务器，因此与页面**同源**：

| 路径 | 作用 |
|---|---|
| `/__lan/address` | 返回当前可用的局域网地址（面板用） |
| `/__lan/paircard` | GET 当前配对码 / POST 换一个 |
| `/__lan/dirs` | 目录浏览（`?root=&path=`） |
| `/__lan/seat` | 席位查询；`?wait=1` 长轮询 25 秒 |

### 6.3 注入到 index 的内容

`ctx.on('webserver/index-inject')` 往表和里塞：

1. `kind:'global'` → `globalThis.__DSH_LAN_GATEWAY__ = {…}`（地址快照）
2. `kind:'script', placement:'head'` → **席位监听脚本**（最先注入）
3. `kind:'script', placement:'head'` → 欢迎弹窗抑制
4. `kind:'script', placement:'head'` → 目录选择器 shim

---

## 7. 配置项

`cordis.patch.yml` 里**不写任何配置**（保证可移植），全部走默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后插件不监听 |
| `port` | `8791` | HTTP 网关端口 |
| `bindAll` | `true` | `false` 时只绑第一个非回环 IPv4 |
| `restrictSameSubnet` | `true` | 只服务与主机同网段的设备 |
| `allowSubnets` | `[]` | 额外放行的 CIDR |
| `injectMobileViewport` | `true` | 手机首页重写 viewport |
| `deviceTtlDays` | `180` | 配对有效期 |
| `appApkPath` | `''` | 自定义 APK 位置（空 = 用 `assets/`） |
| `allowedWorkspaceRoots` | `[]` | **默认空 = 本机所有磁盘**；填写后手机端被限制在这些目录下 |
| `remoteWorkspacePicker` | `true` | 手机用网页选择器；`false` = 退回原生（弹在电脑上） |
| `hideLanWelcomeHints` | `true` | 局域网页面抑制欢迎弹窗 |

---

## 8. APP 细节

### 8.1 关键常量

| 常量 | 值 | 含义 |
|---|---|---|
| `GATEWAY_PORT` | `:8791` | 判定「这是网关地址」 |
| `DISCOVERY_TIMEOUT_MS` | 2500 | 等 UDP 应答的窗口 |
| `HEARTBEAT_INTERVAL_MS` | 5000 | 探测当前地址的周期 |
| `HEARTBEAT_TIMEOUT_MS` | 1500 | 单次 TCP 连接超时 |
| `HEARTBEAT_FAILURES_BEFORE_RECONNECT` | 2 | 连续失败几次才重新发现 |
| `MIN_TEXT_ZOOM` / `MAX_TEXT_ZOOM` | 100 / 350 | 字号百分比 |
| `DEFAULT_TEXT_ZOOM` | 165 | 默认字号 |
| `APP_UA_TAG` | `DSHLanApp` | 追加到 UA，服务端据此隐藏「安装 APP」 |

### 8.2 三个必须理解的机制

1. **凭据重放**：设备 cookie 按主机绑定，换 IP 就丢。APP 自己存一份，在新地址上重放。
2. **心跳重连**：`onReceivedError` 对「已经加载完的页面」不会触发，所以必须主动探测。
3. **页面类型判定**：`__DSH_BOOT__` 只说明「这是应用文档」，此时可能还在
   「Loading plugins…」；**真正挂载完成的信号是侧边栏列存在**（`SCRIPT_IS_APP_READY`）。

### 8.3 UI 覆盖层规则

- ⚙ 和 ＋ 是**原生 View**，CSS 管不到，只能靠 `setVisibility`。
- **创建时就是 `GONE`**，`onPageStarted` 再隐藏一次，只有外壳挂载后才 `VISIBLE`。
- 侧边栏「>」把手相反：它是**注入到页面里**的 DOM 元素（跟着列的宽度动画走）。
- 从网关页面（配对页 / 占用页）回到应用页时，**重建 WebView**——否则会继承上一页的
  布局缩放，界面放大数倍。

---

## 9. 构建与发版

### 9.1 插件

```powershell
# 重载插件（不用重启 DSH）
# 用 plugin_manager 工具：set_plugin include:lan-gateway 先 false 再 true
```

改完 `index.js` / `client.js` / `lib/*.js` 后**必须重载**，否则跑的还是旧代码。

### 9.2 APP

```powershell
$env:DSH_PYTHON_ROOT='D:\A\DSH\dsh-runtimes\dsh-primary-runtime\dependencies\python'
cd D:\B\DeepSeekWork\deepseek-dshbridge\android\build
cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -Clean"
```

脚本会：

1. `javac --release 17` → `.class`
2. 打 jar → `d8` → `classes.dex`（**必须用 Android Studio 的 JBR**，见 `android/AGENTS.md`）
3. `aapt2 compile` + `link`
4. `zipalign` → `apksigner`（用 `dsh-phone-gateway.keystore`，口令从本地 `.secrets.local` 读取）
5. **自动发布**到 `dsh-phone-gateway/assets/` 并更新 `app.json`
6. **清理中间件**，`android/build/` 只剩 `build.ps1`、`dsh-phone-gateway.apk`、`dsh-phone-gateway.keystore`

### 9.3 发版清单

- [ ] 改 `AndroidManifest.xml` 的 `versionCode`（每次 +1）和 `versionName`
- [ ] 改 `dsh-phone-gateway/package.json` 的 `version`
- [ ] 构建（会自动同步 assets 和 app.json）
- [ ] 跑全部 15 套测试
- [ ] 装到手机验证：发现 → 配对 → 加载 → 踢出 → 复位

> ⚠️ **`versionCode` 只能增不能减。** 本机现在是 1；若你曾装过高版本，需先卸载才能降级。

> ⚠️ **`dsh-phone-gateway.keystore` 绝不能删也不能进包**：删了无法覆盖升级，进包等于把签名权交出去。

---

## 10. 测试体系

```powershell
cd D:\B\DeepSeekWork\deepseek-dshbridge
node tools/test-XXX.mjs
```

| 套件 | 断言 | 覆盖 |
|---|---|---|
| `test-slot` | 43 | 席位规则表 + 实时踢出通知 |
| `test-device-store` | 47 | 配对/吊销/去重/主控角色/补位 |
| `test-config` | 35 | 配置默认值与校验 |
| `test-net` | 21 | 网段/回环/IPv6 映射判定 |
| `test-sidebar-selector` | 9 | 「是不是应用页」的判定 |
| `test-sidebar-script` | 28 | 注入脚本的可解析性 |
| `test-app-route` | 21 | APK 下载、304、405、写响应防护 |
| `test-panel-origin` | 29 | 三种 origin 下的面板行为 |
| `test-qr` | 19 | 二维码编码器（有参照库时多 25 项对比） |
| `test-qr-live` | 81 | 活体页面里的二维码矩阵 |
| `test-app-cookie` | 58 | APP 的 cookie 持久化/重放 |
| `test-lan-welcome` | 13 | 欢迎弹窗抑制 |
| `test-dirs` | 87 | 目录服务的越界防护 + 系统项过滤 |
| `test-discovery` | 5 | UDP 发现（端口占用时验证活的监听器） |
| `test-discovery-contract` | 6 | APP 侧发现协议契约 |
| **合计** | **502** | |

### 诊断脚本（不是测试）

| 脚本 | 用途 |
|---|---|
| `ws-seat-probe.mjs` | **两台真实设备抢位**端到端验证（会自己清理，跑完恢复原主控） |
| `ws-live.mjs` | 真实 WebSocket 握手 + 应答 DSH 的 ping |
| `udp-discovery-probe.mjs` | 手动 UDP 广播探测 |
| `dump-sidebar-script.mjs` | 还原 Java 里的注入脚本，便于单独语法检查 |

---

## 11. 踩过的坑（**改代码前务必读**）

| # | 症状 | 根因 | 结论 |
|---|---|---|---|
| 1 | DSH 启动即崩 | `createHmac('sha256', null)` | 签名密钥必须先 `await load()`；`verify()` 必须同步且不抛 |
| 2 | DSH 跑着跑着崩 | `dgram.send` 回调传 `null` 而非 `undefined` | 判空要用 `!== null && !== undefined` |
| 3 | DSH 偶发崩溃 | `.catch` 里再次 `writeHead` → unhandled rejection | 三个写函数进门先查 `alreadyAnswered(res)` |
| 4 | 手机换网后要重新配对 | cookie 按主机绑定 | APP 存 cookie 并在新地址重放 |
| 5 | 手机页面停在旧状态 | `onReceivedError` 对已加载页面不触发 | 主动心跳探测（5 秒） |
| 6 | 手机界面放大数倍 | viewport 注入正则太窄 | 容忍属性顺序；无标签时主动插入 |
| 7 | 从占用页返回后仍放大 | WebView 继承上一页缩放 | 回到应用页时重建 WebView |
| 8 | 设备列表出现重复行 | 页面截 100、存储截 120 | 统一 `DEVICE_LABEL_MAX = 100` |
| 9 | 面板显示 `dsh-app://app/__lan/app` | 按 hostname 判断来源 | 按 scheme + port 判断 |
| 10 | 单元格按钮压住日期 | 给 `<td>` 加了 `display:flex`（会退出表格布局） | 保持单元格，内部用 inline + `nowrap` |
| 11 | 文件被写坏、`client.js` 语法错 | PowerShell 的 `.Replace()` 展开 `${…}`、`WriteAllLines` 写 CRLF | 一律 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))` + LF |
| 12 | `javac` 报 `illegal character: '\ufeff'` | PowerShell 默认写 BOM | 同上 |
| 13 | 加载页就出现 ⚙/＋ | 视图创建即 `VISIBLE`，靠回调隐藏太晚 | **创建即 `GONE`**，通过判定才 `VISIBLE` |
| 14 | 两台手机「共存」 | 只回 403，旧客户端不跳转 | 导航请求回 **302** 到占用页 |
| 15 | 席位永久锁死 | 持有者被吊销后席位不释放 | `currentHolder()` 校验设备仍存在；无主控时先到先得 |
| 16 | 测试静默通过 | 端口被占用时 `SKIP` 且退出码 0 | 改为校验**正在运行的监听器**，断言数不为 0 |

---

## 12. 已知边界与风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **手机 = owner** | 网关用电脑所有者凭据认证，任何配对设备都拥有完整 owner 权限 | 配对码 3 分钟、5 次锁定；设备可随时吊销；不用的设备请吊销 |
| 无 TLS | 局域网内可嗅探（含配对码与内容） | 只在可信网络使用 |
| 手机选择器依赖内部约定 | `__DSH_DIRECTORY_PICKER__` 不是公开 API | DSH 升级后若手机新建工作区「弹在电脑上」，查这里 |
| 席位按「有请求」判定 | 手机完全静默仍算在线（长轮询 25 秒续一次） | 目前可接受；如需硬超时可加 `lastActiveAt` |
| 旧版 APP 无法自动重试 | 没有席位监听 | 建议所有手机升级到同一版本 |
| 二维码依赖手写编码器 | 无第三方参照时为自证 | `test-qr` 有冻结指纹；装了 `qrcode` 会做逐模块对比 |

---

## 13. 升级指南（下次动手时照着做）

### 13.1 改插件

1. 读 `dsh-phone-gateway/README.md` 的对应章节（它是权威操作说明）。
2. 改 `lib/` 下的模块，改完 `node --check`。
3. **重载插件**（`plugin_manager set_plugin include:lan-gateway` false → true）。
4. 跑相关测试套件 + `test-slot`（席位规则容易误伤）。
5. 看 `/__lan/status`：`cookieOk` 必须是 `true`，`devices.primary` 不能为空。

### 13.2 改 APP

1. **先读 `android/AGENTS.md`**（无 Gradle、BOM、d8 要用 JBR、路径当 jar 传）。
2. 改 `MainActivity.java` / `Discovery.java`。
3. `javac -Xlint:all` 必须 **0 警告**。
4. 构建（§9.2），装到手机验证。
5. 特别回归：加载页无 ⚙/＋、从占用页返回不放大、字号调节、上传按钮。

### 13.3 发版

见 §9.3 清单。

### 13.4 当你只有这一份报告

先读 §1、§4、§5 建立心智模型；再按 §3 找到要改的文件；
遇到「为什么这么写」的问题查 §5 和 §11；
遇到「现在到底什么状态」查 `dsh-phone-gateway/README.md`。

---

## 14. 排障手册

| 症状 | 先查 | 常见原因 |
|---|---|---|
| 手机打不开页面 | `/__lan/status` 的 `interfaces` | 防火墙；`bindAll:false` 绑错网卡；不在同网段 |
| 手机一直停在配对页 | 设备列表是否已有该手机 | cookie 被浏览器清掉；配对码过期 |
| 面板显示「无法读取地址」 | 注入的全局变量是否在页面里 | 从 `dsh-app://` 跨源请求（应走同源路由） |
| 手机新建工作区弹在电脑上 | `remoteWorkspacePicker`、DSH 是否仍读 `__DSH_DIRECTORY_PICKER__` | 内部约定变了 |
| 两台手机同时能用 | `/__lan/status` 的 `devices.inUse` | 席位被旧设备占；或有客户端不走网关 |
| 被踢后没弹提示 | 页面是否收到 302 | 旧版 APP；或页面是纯 API 客户端 |
| 页面放大 | 响应里的 `<meta viewport>` | 注入失效；或 WebView 缩放残留 |
| DSH 启动崩 | 日志里第一次请求 | 签名密钥未加载；`writeHead` 重复 |

---

## 15. 可以继续做的事（按价值排序）

1. **席位硬超时**：给 `activeSession` 加 `lastActiveAt`，超过 N 分钟无请求就释放。
2. **配对设备上限**：现在可以无限配对；建议超过 10 台时要求先吊销。
3. **TLS**：自签证书 + APP 信任，消除局域网嗅探风险。
4. **APP 自动更新**：网关已有版本信息（`assets/app.json`），APP 可对比后提示下载。
5. **二维码带 token**：现在二维码只带地址，可考虑带一次性配对凭据，省去输 6 位码。
6. **恢复 `qrcode` 对照测试**：装上参照库即可让 `test-qr` 多 25 项逐模块对比。

---

## 16. 一句话交接

> 插件在 `dsh-phone-gateway/`，APP 在 `android/`，测试在 `tools/`。
> 改插件记得重载，改 APP 记得先读 `android/AGENTS.md`。
> 三条红线：**别崩进程、别把 DSH cookie 给手机、别动 keystore**。
