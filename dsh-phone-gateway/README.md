> **接手维护？先读仓库根目录的 [PROJECT-REPORT.md](../PROJECT-REPORT.md)**：架构、设计决策、踩过的坑、升级与排障都在那里。本文档是可操作的功能说明。

# dsh-phone-gateway

用手机浏览器，通过局域网访问**这台电脑上正在运行的** DSH。

不新建实例、不上云、不装反向代理。网关是进程内的一个插件，只做管道。

---

## 快速开始

1. **确认网关活着**

   在电脑上打开：<http://127.0.0.1:8791/__lan/status>

   看到 `"cookieOk": true` 就说明整条链路正常。

2. **装手机 APP**

   侧边栏底部点「**局域网网关**」→ 面板顶部会显示下载地址，例如
   `http://10.61.18.139:8791/__lan/app` → 用手机浏览器打开并安装。

   > 第一次没装 APP 时，也可以直接在手机上打开 `http://<电脑IP>:8791`，
   > 配对页上同样有「下载 Android APP」按钮。
   >
   > **下载不需要先配对** —— APP 和浏览器是两套独立的 cookie，先配对再下载
   > 会导致同一个手机要配两次。

3. **生成配对码**

   侧边栏「局域网网关」→「打开配对页」，或直接打开
   <http://127.0.0.1:8791/__lan/devices>，点「显示配对码」。

4. **手机配对**

   打开 DSH APP → 自动找到电脑 → 输入那 6 位数字。

5. 配对成功后，180 天内打开即用。

### 手机 APP 下载

| 项 | 说明 |
|---|---|
| 地址 | `http://<电脑IP>:8791/__lan/app` |
| 扫码 | 侧边栏面板与设备页都显示二维码，手机直接扫 |
| 在 APP 内 | 面板与配对页**都不显示**下载入口（已经装好了） |
| 需要配对吗 | **不需要**，同子网即可 |
| 大小 | 约 33 KB |
| 版本 | 显示在面板与设备页上 |

> 签名是自签的（`build/dsh-phone-gateway.keystore`）。口令保存在仓库根目录的 `.secrets.local`（**已被 .gitignore 排除，不要提交**）。

#### 二维码是怎么来的

环境里没有 npm registry，所以插件内置了一个**零依赖的手写编码器**（`lib/qr.js`，byte 模式、纠错等级 L/M、版本 1–10）。

正确性不靠"看起来像"，而是**逐模块比对**：`tools/test-qr.mjs` 用本 profile 里已有的 `qrcode` 包当参照（只在测试里用，运行时不依赖），对 40+ 个用例比较 `version`、`size` 和每一个模块——掩码选择也必须一致，这就同时验证了惩罚分数计算。

只支持 byte 模式是刻意的：URL 含小写字母，其他模式表达不了。代价是比"智能分段"的编码器略大（v3 / 29×29，仍然很容易扫）。

矩阵由 Host 半算好，随 `__DSH_LAN_GATEWAY__` 一起注入页面（`rows` 是每行一个 `'0'/'1'` 字符串），所以：

- 页面不需要任何网络请求或第三方库就能显示二维码
- 地址永远是**当前**的，换网后刷新页面就更新

二维码固定黑底白字、带 4 模块静默区，**不跟随深色主题**——它靠对比度工作。

#### 手机端新建工作区

**问题**：手机点「新建工作区」，弹窗开在**电脑的显示器**上，手机这端永远等不到结果。

**原因**：目录选择器插件只在 Peer 有 `directoryPicker/pick` 权限时注册，而网关把手机认证成 **owner**（`__DSH_REMOTE_ACCESS__ = {owner:true}`），所以手机确实被授权了——但原生对话框画在宿主屏幕上，手机没有通道去操作它。**不是没给权限，是给了权限却没有通道。**

**做法**：手机改用一个**网页版目录选择器**，带盘符切换，默认可以浏览本机全部磁盘。

**默认范围 = 本机全部磁盘**（`C:\`、`D:\` …），不需要任何配置：

- 这是**可移植**的关键：写死一个目录只在那台机器上存在，插件装到别人电脑会全部被过滤掉，手机就什么也建不了
- 也和系统原生对话框的能力对齐——那个对话框本来就能访问整台电脑

需要收紧范围时再配置（这是**每台机器**的本地决定，不会随插件分发）：

```yaml
- id: lan-gateway
  name: dsh-phone-gateway
  config:
    allowedWorkspaceRoots:
      - 'D:\B\DeepSeekWork'
```

配置了之后，手机只能在列出的目录及其子目录内浏览和新建；盘符切换按钮会自动消失（只有一个根）。

彻底关掉（恢复原来的原生选择器，弹在电脑上）：

```yaml
- id: lan-gateway
  name: dsh-phone-gateway
  config:
    remoteWorkspacePicker: false
```

**它是怎么接管原生选择器的**：`dsh-client-ui-directory-picker-native` 的 `apply()` 会读
`globalThis.__DSH_DIRECTORY_PICKER__`，存在就用它的 `pick()` 代替宿主 RPC。Host 半在 LAN 页面的
`<head>` 里定义这个全局，因此：

- 桌面壳（`dsh-app://`）和非 http 协议 → 不注入，保留真正的原生选择器
- 回环地址 → 不注入
- 已经存在 → 不覆盖

没有槽位争夺、没有双弹窗，也不需要改 DSH 的代码。

**边界（这是整个功能的核心）**：

| 规则 | 实现 |
|---|---|
| 只能在配置的根目录内 | 用 `realpath` 后的真实路径判断，不是调用方给的字符串 |
| `..` 穿越 | 解析后离开根目录 → 拒绝 |
| 符号链接 / junction 逃逸 | 同上；指向根外的链接在列表里直接隐藏 |
| 绝对路径 / 盘符 | 请求层面直接拒绝 |
| 新建文件夹名 | 只接受一段普通名字：拒绝 `.`、`..`、`/`、`\`、盘符、控制字符与 Windows 保留字符 |

不变量：**手机选择目录，但不指定路径**。

#### 手机上不重复弹「欢迎使用」引导

`localStorage` 是**按 origin（协议+主机+端口）隔离**的。手机的 origin 里带着机器 IP，所以**每换一次网络就是一个全新的 origin**，存储为空——于是在别的插件眼里，这台手机每次都是"第一次访问"，一次性引导弹窗就又冒出来了。

网关在 index 的 `<head>` 里注入一小段脚本，把这些一次性标志提前置位：

```js
if (host 是回环) return;          // 桌面保留自己的真实引导
localStorage.setItem('dsh-windows-mcp:welcome', '1');
```

只在**主应用 bundle 之前**执行（已实测位置：脚本 44995 < 应用 45694），所以插件挂载时读到的就是"已看过"。

配置项 `hideLanWelcomeHints`（默认 `true`）可关闭。

> 这层是**兼容垫片**，不是那些插件的功能：如果对方改了 key，`tools/test-lan-welcome.mjs` 会直接失败，而不是让弹窗悄悄回来。

#### 换网络后不用重开 APP

以前 APP 打开时换了网络，它会一直对着**打开时的那个地址**重试，必须杀掉重开才会重新找主机。

现在三件事会让它主动重新查找，其中**第三条才是真正起作用的那条**：

0. **心跳探测（主路径）**：每 5 秒对当前页面所用的地址做一次 TCP 连接（1.5 秒超时）。**连续两次**失败才判定为断线，然后重新广播查找。一次偶发超时不重连，否则路由器忙一下就会把页面丢掉。

   为什么必须有它：`onReceivedError` **只在页面正在加载时**才触发——页面已经打开、静止在那里时永远不会触发。而连通性回调也可能一个都不来（同一默认网络下换网段，或手机只是切了 APN）。所以只有主动探测才知道"这个地址还在不在"。

1. **网络变化**：`ConnectivityManager.NetworkCallback` 监听 `onAvailable` / `onLost`（快速路径，但不保证）
2. **页面加载失败**：`onReceivedError` 且只处理**主文档**（子资源失败不触发，否则一个广告拦截就会把页面踢掉）

1. **网络变化**：`ConnectivityManager.NetworkCallback` 监听 `onAvailable` / `onLost`
2. **页面加载失败**：`onReceivedError` 且只处理**主文档**（子资源失败不触发，否则一个广告拦截就会把页面踢掉）

重新查找会重新广播 UDP，拿到新地址就直接过去；**找不到**时显示：

> **连接已断开**
> 没有找到电脑。手机或电脑的网络可能已经改变。
> 请检查两者是否连在同一个 Wi-Fi 或热点下，然后重试。

并给出「重新查找」和「手动输入地址」两个按钮。

一次网络切换会连续触发多个回调，而每次发现要等几秒的广播回包，所以有 4 秒防抖 + 单飞标志，避免叠线程。

#### 换网络后不用重新配对

**cookie 是按主机（IP）绑定的**。手机在 `http://10.61.18.139:8791` 配对后，cookie 属于这个地址；换网后机器变成 `10.113.184.148`，APP 打开新地址时浏览器正确地不会把旧 cookie 发过去，网关就把它当成未配对设备——于是又要求输码。

但网关的凭据**本身不绑定主机**：签名只覆盖 `deviceId.expiresAt`。所以修复在 APP 侧：

1. 页面加载完成时，APP 从 WebView cookie 罐里取出 `dsh-phone-gateway-device` 存进自己的 prefs
2. 每次加载网关地址**之前**，把它按当前地址重新注入回去

凭据只在目标是 `:8791` 时才使用（精确匹配端口，`:87910` 不算），不会把这个机密发给用户手动输入的任何其它主机。

#### 同一时间只有一台手机能控制

| 情形 | 结果 |
|---|---|
| 第一台配对的手机 | **自动成为主控制设备** |
| 主控连接时 | 占着席位的设备被**踢掉**，主控接管 |
| 从设备连接，席位被占 | **拒绝**——包括被另一台从设备占着。从设备之间互不踢 |
| 从设备连接，席位空闲 | 可以连 |
| 席位持有者断开 | 席位释放，谁先来谁用 |
| 电脑自己（回环） | **不占用**这个席位，任何时候都能用 |

**席位监听注入在 `<head>`，不依赖应用 bundle。** 被踢的手机即使应用本身已经因为 403 请求而渲染空白，那个几百字节的脚本仍然会跳转 —— 它挂在活动文档上，与应用是否渲染无关。跳转目标带缓存穿透参数（`/?kicked=<时间戳>`），确保重新请求到的是一份新的、viewport 已重写的文档。

**踢出是实时的，页面会被整个换掉。** 席位一旦变化，主机立刻唤醒被踢手机挂起的 `/__lan/seat?wait=1` 长轮询（实测 < 0.1 秒），前端随即 `location.assign('/')` —— **整页重新导航**，之前加载的对话、工作区列表、项目数据全部消失，不是盖一层遮罩。此后它的每个请求都是 403。

| 踢出后的请求 | 响应 |
|---|---|
| `/api/*` | `403 {"error":"device-busy"}` |
| 页面 | `403` +「设备正在使用中」，每 8 秒自动重试 |

**被踢出的重定向不依赖客户端版本。** 旧版 APP 没有席位监听脚本，所以服务器对它的**导航请求回 302**（跳 `/__lan/busy`），而不是只回 403 —— 任何 WebView 都会跟随重定向，强制离开应用页。子资源仍然直接 403，旧页面无法继续刷新内容。

占用页本身每次被请求都会重新判定：席位一空，它自己就把你送回应用（302 → `/`）。

**只有主设备能踢人。** 从设备想登录而席位被占时，看到的是「设备正在使用中」页面，说明另一台设备在用，并**每 8 秒自动重试**（也可以点「立即重试」）——等对方断开后自动接上。

**被踢的设备连 HTTP 也打不进来**，不只是 WebSocket：席位判定在**每个请求**上生效（`lib/slot.js` 的 `decideSlot`），`/api/*` 返回 `403 {"error":"device-busy"}`，页面请求返回那张「设备正在使用中」页。

「连接」判定用的是 **WebSocket 升级**（`/api/remote.mux`）——那才是真正在驱动会话的那条连接。被踢掉的一方会看到页面停更，APP 的心跳探测随后会发现并重连。

主控角色保存在设备存储里（`primaryDeviceId`），重启不丢。**配置页**（设备页）里可以随时把角色换到另一台手机。

早于这个功能写入的存储没有角色字段，加载时会**回填**：把最早配对的那台设为主控，正好对应「第一台连接者」的定义。

#### 同一台设备重配不会重复

卸载重装 APP 会清空 cookie，手机重新配对时就是一台"陌生设备"。如果直接新增，每装一次就多一行一模一样的记录。

规则：**配对时，如果已有一条相同 label 的设备，就替换它**（新记录生效，旧记录删除）。

label 是 User-Agent 的前 100 字符（机型 + 系统 + 构建），已经足以把同一部手机认出来。代价是**两台完全相同的手机**会互相顶掉——被顶掉的那台用配对码重配一次即可恢复。

> 这个 100 必须只有**一处**定义（`DEVICE_LABEL_MAX`）。曾经前端截 100、存储侧截 120，同一部手机因此产生两个不同 label，重复记录又回来了。

老版本留下的重复记录会在**启动加载时自动合并**（保留最新那条并回写文件），不需要手工清理。

#### 面板内直接显示配对码

侧边栏面板的第 2 步直接显示 6 位配对码（大字 + 剩余倒计时 + 「换一个配对码」按钮），不需要再跳到设备页去按按钮。

数据来自同源路由 `GET/POST /__lan/paircard`（挂在 DSH 自己的服务器上，理由同下）：

| 方法 | 行为 |
|---|---|
| `GET` | 返回当前有效的码；**幂等**——打开面板不能把操作员刚看到的码弄没 |
| `POST` | 生成新码，旧码立即失效 |
| 其他 | `405` + `Allow: GET, HEAD, POST` |

注意：这条路由必须用 `handler` 形式注册，不能只用 `resource`。`resource` 路由只应答 `GET`/`HEAD`，其他方法在进入处理器之前就被框架拒成 `405` 了。

#### 刷新地址

注入值只在**页面加载时**算一次，所以换网络后页面里的地址会是旧的。二维码下方有个「刷新地址」按钮，按需重新取：

1. 先读 `GET /__lan/address` —— 本插件在 **DSH 自己的服务器**上注册的同源路由，每次请求现算，返回与注入值相同结构的数据
2. 失败时退回：重新请求首页 HTML，从注入的 `__DSH_LAN_GATEWAY__` 里解析

两条路径都是**同源**的。这是关键：网关自己那些 `/__lan/*` 路由在 8791 端口，对页面（`dsh-app://app` 或 DSH 端口）来说是跨源，`fetch` 会被浏览器拦掉——早期「读不到下载地址」就是这个原因。

按钮会回报结果（地址已更新 / 没有变化 / 读不到）。

安装包打进插件包内（`assets/dsh-phone-gateway.apk`），由 `android/build/build.ps1` 在每次构建后自动同步，**不需要重启插件**（网关每次请求读文件）。

签名用的 keystore **不会**被复制进去——否则任何人都能给这个 APP 签更新包。

### 侧边栏入口

插件在 Web UI 侧边栏底部（设置按钮旁）注册了一个「**局域网网关**」入口：

- 顶部：手机 APP 下载地址 + 「复制下载链接」
- 4 步使用说明（装 APP → 生成码 → 打开 APP → 输码）
- 「打开配对页」按钮 → 跳转 `http://127.0.0.1:8791/__lan/devices`
- 「查看网关状态」按钮 → 跳转 `http://127.0.0.1:8791/__lan/status`

下载地址是**按需解析**的，不是写死的。**首要来源是 Host 半注入的全局变量**：

```js
globalThis["__DSH_LAN_GATEWAY__"] = { port: 8791, lan: "10.61.18.139", appPath: "/__lan/app", appAvailable: true }
```

它通过 `webserver/index-inject` 事件渲染进 index.html，**同源**，所以三种运行环境都能读到，且不需要任何网络请求。

为什么不能用 `fetch` 取地址：面板在三个不同的 origin 下渲染——

| 环境 | origin | fetch 回环 status |
|---|---|---|
| 桌面壳 | `dsh-app://app` | ❌ 跨源被浏览器拦掉 |
| 电脑浏览器 | `http://127.0.0.1:<DSH端口>` | ✅ |
| 手机 | `http://<局域网IP>:8791` | 同源但 status 仅回环 |

这就是早期「读不到下载地址」的原因：桌面壳去 fetch `127.0.0.1:8791` 是跨源请求，网关没法 CORS 头，直接失败。改成注入后问题消失。

解析顺序：

1. 注入的 `globalThis.__DSH_LAN_GATEWAY__`（首选，无网络）
2. 页面由网关自己提供（在手机上）→ 用页面 origin
3. 兜底：`fetch` 回环 status —— 只在电脑浏览器里有效

**APP 内完全隐藏入口**：APP 的 WebView 会在 User-Agent 末尾追加 `DSHLanApp` 标记，`apply()` 据此跳过整个侧边栏入口的注册——在 APP 里「下载 APP」「打开配对页」「查看网关状态」都没有意义。电脑端不受影响。

**在 APP 内不显示下载卡片**：APP 的 WebView 会在 User-Agent 末尾追加 `DSHLanApp` 标记，网关据此判断请求来自 APP 本身——此时再提示「装 APP」是多余的。浏览器打开同一页面时卡片正常显示。

**判断「是不是网关」必须看协议 + 端口，不能只看主机名**：桌面壳的 origin 是自定义协议 `dsh-app://app`，只看 hostname 会把它当成手机（这个 bug 真实发生过）。

所以换网络后刷新页面，地址会自动是新的。

注册在 `sidebar.footer.action`（list 型插槽），**不与已有标签冲突**——它的 id 是 `lan-gateway-entry`，与 shell 自己的 `cordis-panel` 并列存在。侧边栏折叠成 56px 窄条时自动收成图标。

---

## 设备管理

打开 <http://127.0.0.1:8791/__lan/devices>（**只有这台电脑能打开**）

| 操作 | 说明 |
|---|---|
| 显示配对码 | 生成新的 6 位码，旧码立即作废 |
| 吊销 | 该设备**立刻**失效，不需要重启 |

配对码规则：3 分钟过期、错 5 次即焚、成功一次即焚。所以 6 位数字的 100 万种可能里，攻击者最多只能试 5 次。

---

## 安全模型

```
手机 ──①网关自己的设备 cookie──▶ 网关(8791) ──②DSH 的登录 cookie──▶ DSH(127.0.0.1:随机端口)
```

**两条独立的认证链**：

1. **手机 → 网关**：配对时签发的 `dsh-phone-gateway-device` cookie（HttpOnly, 180 天）
2. **网关 → DSH**：启动时用 `ctx.connection.authenticatedUrl()` 换来的 DSH cookie，**只存在进程内存里**

三条铁律（写进了代码注释）：

1. 网关**永不**创建 DSH 实例，只做管道
2. 手机**永远**拿不到 DSH 的令牌——所有上游 `Set-Cookie` 都被剥掉
3. 网关挂了只影响 8791，DSH 本体不受影响

### 默认防护

- **子网限制**：非本机子网来源一律 403（`restrictSameSubnet`，默认开）
- **回环放行**：电脑自己的浏览器不需要配对
- **配对页是唯一公开面**：未配对设备访问任何路径（包括静态资源、`/api`、WebSocket）都只拿到配对页或 401

### 已知边界

- **局域网内未配对的设备仍能看到配对页，并且能下载 APP 安装包**。这是刻意的：不这样同一个手机要配两次。安装包里没有任何凭据，只暴露「有这个工具」。
- **没有 HTTPS**。局域网内暂不需要，但意味着同一热点下的流量可被嗅探。
- **本机回环完全信任**。任何能在这台电脑上跑代码的进程都能直接访问 8791，不需要配对。

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `lan-gateway` 这一行的 `config`：

```yaml
- id: lan-gateway
  name: dsh-phone-gateway
  config:
    port: 8791
    bindAll: true
    restrictSameSubnet: true
    allowSubnets: ['192.168.1.0/24']
    injectMobileViewport: true
    deviceTtlDays: 180
    enabled: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关，`false` 时不监听 |
| `port` | `8791` | 监听端口 |
| `bindAll` | `true` | `false` 时只绑第一个非回环 IPv4 网卡 |
| `restrictSameSubnet` | `true` | 只放行本机所在子网 |
| `allowSubnets` | `[]` | 额外放行的 CIDR，如 `192.168.1.0/24` |
| `injectMobileViewport` | `true` | 首页 viewport 改成 `width=1024` |
| `deviceTtlDays` | `180` | 配对的设备 cookie 有效期（天） |
| `hideLanWelcomeHints` | `true` | LAN 页面上把已知插件的一次性引导标记为已看过（见「手机上不重复弹」） |
| `allowedWorkspaceRoots` | `[]` | 手机新建工作区允许的根目录；空 = 本机全部磁盘 |
| `remoteWorkspacePicker` | `true` | 手机端用网页版目录选择器；`false` = 恢复原生选择器（弹在电脑上） |
| — | 文档页响应带 `cache-control: no-cache`，viewport 每次重写 |
| `appApkPath` | `''` | 空 = 用包内的 `assets/dsh-phone-gateway.apk`；填绝对路径可指向别处（开发调试用，省得每次复制） |

改完配置需要重载插件（见下文）。

---

## 工作原理

### HTTP 反代

每个请求都做这几件事：

1. `Host` / `Origin` 改写成回环 authority（`http://127.0.0.1:<port>`）
   —— 这同时通过 DSH 的 `/api` Host/Origin 栅栏，以及 cookie 的 authority 绑定校验
2. 注入 DSH cookie
3. 剥离上游所有 `Set-Cookie`（铁律 2）
4. 导航请求从 `accept-encoding` 里去掉 `gzip`，因为首页需要改写 HTML
5. 首页把 `<meta name="viewport">` 改成 `width=1024`，让手机的整页缩放显示桌面布局
6. 未知页面路径 fallback 到首页（`/api`、`/connect`、静态资源不回退）

### WebSocket

`/api/remote.mux` 用**原始 TCP 管道**转发，不自己实现握手：

- `Sec-WebSocket-Key` → `Accept` 和 `permessage-deflate` 都是手机与 DSH 端到端协商的，网关只搬字节
- `Host` / `Origin` 同样改写，`Cookie` 同样注入
- **两侧都不设超时**，心跳交给 DSH 自己，空闲会话不会被网关切断

### 持久化

设备清单和签名密钥存在：

```
$DSH_HOME/storages/lan-gateway/devices.json
```

（`DSH_HOME` 默认 `D:\A\DSH`）

写入用临时文件 + 原子 rename，避免半写状态。文件损坏时按空清单启动（所有设备需重新配对），不会阻塞 DSH 启动。

---

## 局域网自动发现（UDP 8792）

**解决的问题是"地址会变"，不是"打字麻烦"。**

二维码里编码的是一个瞬间的地址；换一个热点，码就废了，得走回电脑重新扫。6 位配对码同理——它证明身份，不携带位置。

所以手机直接问网络：

```
手机  ──广播──▶ 255.255.255.255:8792  {"probe":"dsh-phone-gateway"}
网关  ──单播──▶ 手机的 socket           {"service":"dsh-phone-gateway","url":"http://10.x.y.z:8791"}
```

回包里是**当前此刻**的地址，由"与查询方同子网的那块网卡"解析得出。换网后广播打到新网段，网关回答新地址——**不用重新配对，不用重新扫码，不用记 IP**。

### 行为约束

- 只回答**本来就会服务**的对端（复用 `isAllowedPeer`），所以发现不会扩大暴露面
- 回包**不含**配对状态、设备清单、DSH 端口，只是一个位置提示
- 发现过程**只读**：不创建设备、不消耗配对码，广播风暴也扰动不了配对存储
- 多网卡（WiFi + 热点 + VPN）时，回答与查询方**同子网**的那个地址，保证可达
- UDP 8792 绑定失败（被占用）时**只记日志**，HTTP 网关照常工作

### 测试

```powershell
node tools/test-discovery.mjs          # UDP 发现（端口占用时改为验证活的监听器）
node tools/udp-discovery-probe.mjs     # 端到端广播探测
```

> 两套 discovery 测试在插件运行时**不会跳过**：UDP 8792 被占用时，它们改为校验**正在运行的那个监听器**（应答格式、端口、域名、外来探测被忽略）。想测冷启动路径，先禁用插件再跑。

### 防火墙

UDP 8792 需要入站放行。若手机发现不到，检查这条规则：

```bat
netsh advfirewall firewall add rule name="DSH Phone Gateway Discovery" dir=in action=allow protocol=UDP localport=8792 profile=private,public
```

撤销：

```bat
netsh advfirewall firewall delete rule name="DSH Phone Gateway Discovery"
```


---

## 排障

### 手机打不开

按顺序查：

1. **热点 AP 隔离** —— 很多手机热点默认开启「客户端隔离」，会让连入设备互相不可见。这是最常见原因。
2. **手机是否在同一网段** —— 应该在 `status` 页 `interfaces` 里列出的那个网段。
3. **防火墙** —— 检查是否已有针对 `DeepSeek Harness.exe` 的入站放行规则。这条规则是**按进程**放行的，没有端口限制，所以通常**不需要**额外加端口规则。

如果真的需要加一条端口规则（管理员权限）：

```bat
netsh advfirewall firewall add rule name="DSH Phone Gateway" dir=in action=allow protocol=TCP localport=8791 profile=private,public
```

撤销：

```bat
netsh advfirewall firewall delete rule name="DSH Phone Gateway"
```

### 手机进了配对页，但码输入后没反应

- 确认码没过期（3 分钟）且没被别的尝试烧掉
- 在设备页重新生成一个

### 手机能看到页面，但消息不流式

WebSocket 没通。设备页能打开说明 HTTP 通了，检查浏览器控制台是否有 WS 报错。

跑 `node tools/ws-live.mjs` 可以直接验证 WS 握手和帧流。

### `cookieOk: false`

网关换不到 DSH 凭据，整条链断了。看 status 里的 `error` 字段。常见原因：DSH 还在启动中（`port` 未就绪），等几秒再刷新。

### 端口被占用（`EADDRINUSE`）

自动重试 5 次、间隔 4 秒。如果最终失败，网关不监听但不影响 DSH。检查：

```bat
netstat -ano | findstr :8791
```

### 完全卸载

在插件管理里移除 `dsh-phone-gateway`，8791 立即停止。残留只有：

- `$DSH_HOME/storages/lan-gateway/`（可删，删了等于吊销所有设备）
- 若手动加过防火墙规则，用上面的 delete 命令删掉

---

## 开发

改完代码后**不需要重启桌面端**，在插件管理里把 `lan-gateway` 关掉再打开即可重载模块。

```powershell
# 语法检查
node --check index.js
node --check lib/pair.js

# 回归测试（15 套，502 项断言）
node tools/test-dirs.mjs            # 工作区目录服务：越界防护 + 系统项过滤（87 项）
node tools/test-qr-live.mjs         # 实时二维码/路由/工作区边界 + 接线（81 项）
node tools/test-app-cookie.mjs      # APP 凭据重放 + 心跳重连（58 项）
node tools/test-config.mjs          # 配置解析与默认值（35 项）
node tools/test-slot.mjs            # 单席位规则 + 实时踢出通知（43 项）
node tools/ws-seat-probe.mjs        # 两台真实设备的抢位验证（需活动网关）
node tools/test-device-store.mjs    # 配对/吊销/去重/主设备角色（46 项）
node tools/test-panel-origin.mjs    # 面板地址解析：三种 origin + 注入优先（29 项）
node tools/test-sidebar-script.mjs  # 注入脚本语法 + 层级不变量（28 项）
node tools/test-net.mjs             # 子网闸门与地址归一化（21 项）
node tools/test-qr.mjs              # 二维码编码器（19 项 + 参照库在时多 25 项对比）
node tools/test-app-route.mjs       # APP 下载路由 + 304/HEAD/405 + 写响应防护（21 项）
node tools/test-lan-welcome.mjs     # LAN 引导弹窗抑制 + key 与插件一致（13 项）
node tools/test-sidebar-selector.mjs # 侧边栏选择器匹配（9 项）

# 发现协议（插件在跑时验证活的监听器，不必禁用）
node tools/test-discovery.mjs       # UDP 发现 + null 回调崩溃防护（5 项，独占端口时 15 项）
node tools/test-discovery-contract.mjs

# 活体探测
node tools/ws-live.mjs              # WebSocket 升级
node tools/udp-discovery-probe.mjs  # 手工发一次广播看回包
node tools/dump-sidebar-script.mjs  # 还原 Java 里的注入脚本（配合 node --check）
```

> `test-qr.mjs` 用 `qrcode` 包做参照，那是**另一个插件的可选依赖**，profile 更新后可能消失。
> 它消失时对比组自动跳过，但**冻结指纹**（第 7 组）始终运行——那批哈希是参照库还在时
> 逐模块比对记录下来的，编码器任何一处漂移都会让它失败。

测试用 `node` 请用 DSH 自带的那个（系统 PATH 里可能没有）：

```
D:\A\DSH\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
```

### 文件结构

| 文件 | 职责 |
|---|---|
| `index.js` | 装配：路由分发、子网闸门、配对闸门、监听生命周期 |
| `client.js` | **浏览器半**：侧边栏底部入口 + 使用说明面板 |
| `lib/config.js` | 配置解析与默认值 |
| `lib/app-file.js` | 手机 APP 安装包的定位与投递 |
| `lib/qr.js` | 零依赖二维码编码器 |
| `lib/net.js` | 地址归一化、回环判定、子网判定 |
| `lib/auth.js` | DSH 凭据换取与缓存 |
| `lib/proxy.js` | HTTP 反代、header 改写、viewport 注入 |
| `lib/ws-proxy.js` | WebSocket 原始字节转发 |
| `lib/pair.js` | 配对码、设备清单、签名密钥 |
| `lib/pair-page.js` | 配对页与设备页（中/英） |
| `lib/discovery.js` | UDP 8792 自动发现 |

### Client 半（`client.js`）

浏览器端不打包、不依赖构建工具，直接以 `window.__ModuleLoader__.load()` 形式注册：

```js
ctx.slots.inject('sidebar.footer.action', () =>
  ctx.slots.register({ name: 'sidebar.footer.action', id: 'lan-gateway-entry', order: 10 }, LanGatewayAction),
)
```

- 插槽是 **list** 型，所以新 id 是「加入」而不是「替换」
- owner 传入 `{ wide: boolean }`：窄轨（56px）时只渲染图标
- 样式全部用 host 主题变量（`--dsh-color-*`），跟随明暗主题
- 面板是自绘 overlay，不进 portal（因为插槽在 sidebar footer 内），Escape 和点背景关闭

### 踩过的坑

- **`DeviceStore.verify()` 必须是同步的，且绝不能抛异常。** 它在请求处理器里运行，未捕获的异常会杀掉整个 DSH 进程。曾经的 bug：密钥由异步 `load()` 赋值，冷启动后第一个带 cookie 的请求触发了 `createHmac('sha256', null)` → `ERR_INVALID_ARG_TYPE` → 进程退出。现在密钥未就绪时 `verify()` 直接返回"未配对"，且 `apply()` 在开始监听前 `await devices.load()`。
- **页面里的 URL 必须写绝对路径。** 配对页在未配对时挂在 `/`，`fetch('pair')` 会解析成 `/pair`；设备页在 `/__lan/devices`，`fetch('__lan/code')` 会解析成 `/__lan/__lan/code`。
- **`codeStatus()` 必须幂等。** 设备页每次渲染都读它，读一次就销毁码会导致页面自己把码吃没了。
- **Client bundle 的 URL 是批量形式** `plugins/??dsh-phone-gateway/client.js&rev=...`，`??` 是合并请求语法。用 `curl` 单独请求 `/plugins/dsh-phone-gateway` 会 404，**这是正常的**——真实浏览器走的是 `__DSH_BOOT__` 里给出的批量 URL。
- **改 `client.js` 后必须重载插件**（关闭再打开），仅刷新浏览器不会重新读取模块。
