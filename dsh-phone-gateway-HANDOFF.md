# dsh-phone-gateway 实施交接文档

> **用途**：在新工作区 / 新会话中从零开始实现「手机通过局域网访问本机 DSH」。
> **本文档自包含**：所有技术结论均已实地核实，含出处路径，新会话无需重新调研。
> **生成时间**：2026-11-10
> **生成会话**：`session-c042616d-164b-47e6-bfa6-c148cfba39f6`
>
> ⚠️ **这是一份历史记录，不是当前状态。**
> 它描述的是分步实施过程中的决定与实测数据，其中**部分数字和结论后续被改掉了**
> （例如字号上限已从 250% 扩到 350%；工作区根目录曾一度改为「按已注册工作区推导」，
> 最终定为「本机全部磁盘」；测试套数也从 3 套增长到 12 套 414 项）。
>
> **当前行为的唯一权威来源**：
> - 插件：[`dsh-phone-gateway/README.md`](dsh-phone-gateway/README.md)
> - APP：[`android/README.md`](android/README.md)

---

## 〇、一句话目标

在**同一个** DSH 桌面进程之上，加一个进程内插件，让手机通过局域网（电脑开热点）用浏览器访问 DSH，查看任务详情并与之交互。

**不使用**：远程服务器、第三方中继、`ds-harness-remote`、SSH、新建 DSH 实例。

---

## 一、决策记录

### 已确定

| 项 | 决策 | 备注 |
|---|---|---|
| 方案 | **A：进程内局域网网关插件** | 其他三案已评估否决，见第四节 |
| 配对方式 | **6 位数字配对码** | 不用二维码（省一份依赖/编码器） |
| 手机显示 | **首页 viewport 注入 `width=1024`** | 整体缩放，不改前端 |
| 网关端口 | **8791** | |
| 设备有效期 | 180 天 | 可配 |
| 子网限制 | 默认开启 | 非本子网来源 403 |
| 推进方式 | **逐步实施 + 每步验证** | 不一次性写完 |

### 已否决

| 项 | 原因 |
|---|---|
| 另起 `dsh web` 实例 | 双实例会写坏会话（已发生事故） |
| 独立反向代理（Caddy/nginx） | 拿不到进程令牌，首页永远 401 |
| `ds-harness-remote` + 自建中继 | 依赖第三方工程，局域网场景绕远 |
| SSH（DSH Go） | 1.5 小时排查后仍无法满足需求，且是会话损坏的直接诱因 |
| 二维码配对 | 6 位码已足够，配对只做一次 |
| `/m` 手机专用页 | 列为阶段 2，本期不做 |
| HTTPS / 自签证书 | 局域网内，暂不需要 |
| 多用户权限模型 | 配对即 owner |

---

## 二、已核实事实（**新会话请直接采信，勿重复调研**）

### 2.1 DSH 启动方式

| 事实 | 出处 |
|---|---|
| 桌面版启动 Host 时**写死** `["--no-open", "--host", "127.0.0.1", "--port", "0"]` | `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`，`main()` 约 450–456 行（asar 内，需 `_asar-extract.ps1` 提取） |
| 因此网页只监听回环，**端口是随机的**（本次实测为 50215） | 实测 `netstat` |
| 但进程内有 `ctx.connection.authenticatedUrl(...)` 可用，desktop-host 自己在第 606 行就是这么拿 URL 的 | 同上，第 606 行 |

### 2.2 鉴权（**全部关键，务必理解**）

| 事实 | 出处 |
|---|---|
| 首页需带 `?token=<进程令牌>` 访问，服务端回 303 + `Set-Cookie`，然后重定向到 `./` | `dsh-client-connection/lib/index.js`，`BrowserAuth.authorizeIndex` |
| Cookie 名 = `dsh-auth-<base64url(sha256(authority))>`，authority 取自请求的 `Host` 头（https 时取 origin） | 同上，`cookieName()` / `requestAudience()` |
| Cookie 属性：`Max-Age=...; Path=/; Expires=...; HttpOnly; SameSite=Strict`（HTTPS 时加 `Secure`） | 同上，`sessionCookie()` |
| 默认有效期 30 天，可配 `cookieMaxAgeDays` | 同上 |
| **`/api` 的 Host/Origin 栅栏** 只接受三类 Host：① 回环（127/8、localhost、::1）② `trustedHosts` 中声明的 authority ③ **监听地址字面量本身**（忽略端口） | 同上，`isTrustedApiRequest()` / `isBindAddressAuthority()` |
| 同栅栏还会拒绝 `sec-fetch-site: cross-site`，且 `Origin` 必须与 `Host` 同 authority | 同上 |
| **静态资源公开**：只有 `/` 和 `/index.html` 走 `authorizeIndex`，其余文件直接发，带 `no-cache` + 弱 ETag + 304 | `dsh-host-frontend-static/lib/index.js`，`serveStatic()` |
| **WS 升级同样鉴权**：`/api/remote.mux` 走 `connection.admitConnection(req)` | `dsh-api-gateway/lib/index.js` 第 808 行 |
| webserver 的 upgrade 分发是**精确路径匹配** `this.upgrades.get(pathname)`，未知路径直接 `socket.destroy()` | `dsh-host-webserver/lib/index.js` 第 523 行 |

**→ 结论：进程内插件把 Host 改写成回环，就能同时过栅栏和 cookie 校验；无需配 `trustedHosts`。**

### 2.3 前端

| 事实 | 出处 |
|---|---|
| `index.html` 的 viewport 是 `width=device-width, initial-scale=1` | `dsh-web-frontend/dist/index.html` |
| 前端 JS/CSS **零处**硬编码 `127.0.0.1` 或绝对后端地址，全部同源相对路径 + `document.baseURI` | 对 `dist/assets/*.js` 全量搜索，0 命中 |
| 全站只有 **1 条** media query（`prefers-reduced-motion`），**没有任何响应式宽度断点** | 对 `dist/assets/*.css` 全量搜索 |
| 唯一的窄屏适配在 `dsh-better-sidebar`：`NARROW_MAX_WIDTH = 768`，配套 `@media (max-width: 767px)`（出现在 `sidebar.module.css`） | `dsh-better-sidebar/src/client/breakpoints.ts` |
| `frontend-static` 会给 index 注入 `<base href="./">` | 同上包 `apply()` |

### 2.4 会话持久化（**这是事故的根因**）

| 事实 | 出处 |
|---|---|
| 会话目录 root = `dshHomePath('sessions')`，**所有 profile 共用** | `dsh-base/cordis.patch.yml` 的 `session-persistence-jsonl` 行 |
| 有跨进程写锁：`SessionWriteLease`，Windows 下 `acquireLockHandleWin32`，冲突抛 `EBUSY` → `SessionAlreadyOwnedError` | `dsh-session-persistence-jsonl/lib/index.js` |
| **但锁只在"同时持有"时生效**：换宿主时前一个进程释放锁、后一个接手，各自内存里的 `seq` 计数器是分叉的 → 写入时出现 seq 回绕 | 同上 + 2026-11-08 实际事故 |
| 实际事故：`invalid committed event at line 1950: released v2 row 1949 has seq gap (expected 1949, got 1946)` | 会话 `session-2a65e4b9` |
| 该会话**已修复**：2162 行、maxSeq=2160、0 缺口、0 重复 | 本次实测解压验证 |

**→ 结论：有锁 ≠ 安全，只有"单实例"才安全。**

### 2.5 CLI 能力

| 事实 | 出处 |
|---|---|
| `dsh --profile <name>` 支持 `--host <具体IP>`（**拒绝 0.0.0.0 等通配**）、`--port`、`--public-url`、`--trusted-host`、`--tls-cert`/`--tls-key` | `dsh-web-app/lib/startup.js` |
| **命令行禁止启动 desktop profile**（`rejectElectronProfile`） | `dsh/lib/bin.js` |
| web profile 的 `connection` 行已有 `trustedHosts: !!js ctx.webStartup.trustedHosts` | `dsh-web-app/cordis.patch.yml` |

### 2.6 宿主服务（插件可注入）

| 服务 | 关键成员 |
|---|---|
| `webServer` | `getOrigin()`、`port`、`host`、`protocol`、`register()`、`registerUpgrade()`、`registerFallback()` |
| `connection` | `authenticatedUrl(baseUrl)`、`admit()`、`admitConnection()`、`createPeer()`、`browserPeer` |
| `agents` | `get(id)`、`list()`、`roots()` |
| `typertGateway` | `invoke()`、`stream()` |

`InvokeRemoteRequest` 结构（进程内可直接调用 Remote 方法）：
```ts
{ namespace, method, args, peer: PeerScope, signal?, uplink?, uplinkWindow? }
```

---

## 三、冻结架构

```
手机浏览器 http://<热点IP>:8791
   │  ①网关自己的 HttpOnly cookie（未配对 → 配对页）
   ▼
┌───────────────────────────────────────────────┐
│ DSH 桌面进程内的插件 dsh-phone-gateway            │
│  · 监听 0.0.0.0:8791                           │
│  · 子网白名单（remoteAddress）                  │
│  · Host/Origin 改写 + 注入 DSH cookie          │
│  · 剥离上游 Set-Cookie                          │
│  · 首页 HTML viewport 注入（1024）              │
│  · WS upgrade 透明转发                          │
│  · GET /pair（仅回环）生成 6 位配对码            │
│  · GET /__lan/status（仅回环）诊断              │
└───────────────────┬───────────────────────────┘
                    │ http.request / net.connect
                    ▼
        127.0.0.1:<随机端口>  ← DSH 内置 Web 服务器（零改动）
```

### 三条铁律（写进代码注释）

1. 网关**永不**创建 DSH 实例，只做管道。
2. 手机**永远**拿不到 DSH 令牌；令牌只存在于网关内存。
3. 网关挂了只影响 8791，DSH 本体不受影响。

### 两条鉴权链

| 链 | 负责方 | 生命周期 |
|---|---|---|
| 手机 → 网关 | 网关设备 cookie（配对时签发） | 180 天，可单设备吊销 |
| 网关 → DSH | 启动时 `ctx.connection.authenticatedUrl()` 拿令牌 → 回环 `GET /?token=` 换 `Set-Cookie` → 内存缓存 | 随进程；DSH 重启自动重换 |

---

## 四、实现细节备忘（**必踩的坑**）

| 坑 | 说明 |
|---|---|
| **gzip 干扰** | DSH 的 Web bundle 对 ≥1024 字节响应做 gzip（level 1）。HTML 注入需明文 → 对导航请求（`sec-fetch-dest: document`）从 `accept-encoding` 里剥掉 `gzip` |
| **content-length** | 改写 HTML 后必须重算，否则截断 |
| **cookie 名动态** | 名字含 authority 的 sha256，**不要硬编码** `dsh-auth-*`，从 `Set-Cookie` 响应头动态取 |
| **端口惰性读取** | `ctx.webServer.port` 在绑定前是 `undefined`，需按请求读取或等 `appReady` |
| **WS 心跳** | 不给网关侧设读写超时，复用 DSH 自己的 ping |
| **Host 改写范围** | HTTP 和 WS upgrade **都要**改写，否则 WS 会被 403 |
| **Origin 改写** | 有 `origin` 头时同步改写成 `http://127.0.0.1:<port>`，否则 `isSameAuthorityOrigin` 失败 |
| **子网判定** | 用 `req.socket.remoteAddress`，注意 IPv4-mapped IPv6（`::ffff:192.168.x.x`）要归一化 |

---

## 五、文件清单

```
dsh-phone-gateway/
├── package.json          # dsh.bundle.patch + exports + files
├── cordis.patch.yml      # insert 一行
├── index.js              # apply()：装配
├── lib/config.js         # Config schema
├── lib/net.js            # 网卡枚举 / 子网判定 / 选卡
├── lib/auth.js           # DSH cookie 换取与缓存 + 设备密钥
├── lib/pair.js           # 配对码 + 配对页 HTML
├── lib/proxy.js          # HTTP 反代 + WS 转发 + HTML 注入
├── locale/{zh,en}.json   # meta.title / meta.description
└── icon.svg
```

### package.json 骨架

> 下面这段是**当时的初版**（0.1.0），仅为记录。当前版本与字段以
> [dsh-phone-gateway/package.json](dsh-phone-gateway/package.json) 为准。

```json
{
  "name": "dsh-phone-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": [
    "index.js", "lib/*.js", "cordis.patch.yml",
    "locale/*.json", "icon.svg"
  ]
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: lan-gateway
      name: 'dsh-phone-gateway'
```

### Config 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `port` | `8791` | 监听端口 |
| `bindAll` | `true` | false 时只绑当前网卡 IP |
| `restrictSameSubnet` | `true` | 只允许同子网 |
| `allowSubnets` | `[]` | 额外放行 CIDR |
| `injectMobileViewport` | `true` | 首页 viewport → 1024 |
| `deviceTtlDays` | `180` | 配对有效期 |

### 宿主导出形式

```js
export function apply(ctx, config) { /* 所有资源用 ctx.effect 注册并返回清理 */ }
export const inject = ['connection', 'webServer']
export const Config = /* Schema */
```

---

## 六、分步实施（每步可独立验证）

### 步骤 1：骨架 + 冒烟探针（30 min）⬅ **先只做这一步**

- 建包、manifest、patch
- `index.js` 只做三件事：读端口、换 DSH cookie、起 8791、暴露 `GET /__lan/status`
- **验证**：`curl http://127.0.0.1:8791/__lan/status`
- 期望输出：`{ port: 50215, cookieOk: true, interfaces: [...] }`
- **门槛：`cookieOk: true`。失败则全部停止，不要往下写。**
- 需用户：确认安装审批；必要时重启桌面端

> ⚠️ 这是整个方案**唯一未实测的不确定点**（我读代码推演成立）。先做这一步就是为了快速证伪。

### 步骤 2：HTTP 反代（1 h）

- 转发 + header 改写 + cookie 注入 + 剥 Set-Cookie + viewport 注入
- **验证**：电脑浏览器开 `http://127.0.0.1:8791/`，界面完整、能发消息、无 401

### 步骤 3：WS 实时流（40 min）

- upgrade 透明转发
- **验证**：8791 页面发消息 → 输出**逐字流式**；两个标签页同步

### 步骤 4：配对 + 设备白名单（1 h）

- 配对码生成/校验、cookie 签发、设备列表与吊销
- **验证**：换浏览器 profile 访问 → 见配对页；输码进入；错码被拒；列表出现该设备

### 步骤 5：防火墙（10 min，**需用户手动提权**）

```bat
netsh advfirewall firewall add rule name="DSH Phone Gateway" dir=in action=allow protocol=TCP localport=8791 profile=private,public
```
- **验证**：`netstat -ano | findstr :8791` 显示 `0.0.0.0:8791`

### 步骤 6：手机实测（20 min）

手机连热点 → 打开 `http://<IP>:8791` → 配对。验收 6 条：
1. 配对页出现 → 输码 → 进入
2. 看到电脑上**正在运行**的会话
3. 电脑发任务，手机看到流式输出
4. 手机发指令，电脑立刻看到
5. 手机点审批「允许」，电脑同步
6. 断网重连（飞行模式 10 秒）后自动恢复

### 步骤 7：收尾（30 min）

- README（开启 / 吊销 / 关闭）
- 兜底：cookie 失败只告警不停 DSH
- 端口占用降级：`EADDRINUSE` 记日志继续启动

---

## 七、环境现状（**新会话开工前必读**）

| 项 | 值 |
|---|---|
| 当前工作目录 | `D:\B\DeepSeekWork\deepseek-all` |
| DSH 实现目录 | `D:\A\DeepSeek Harness\resources\app.asar\dsh`（asar 内，需提取） |
| DSH_HOME | `D:\A\DSH` |
| DSH_PROFILE | `desktop` |
| Profile 目录 | `D:\A\DSH\profiles\desktop` |
| 当前 Web URL | `http://127.0.0.1:50215` |
| 当前用户 | `XWD\16531`，**非管理员** |
| 当前网卡 | `WLAN 10.61.18.139/24`（有 IPv6） |
| 文件策略 | `workspace-write`（**无法写 `D:\A\DSH` 下的 profile 文件**） |
| 审批 | 已启用 |

### 安装方式

- **必须**用 `plugin_manager` 的 `install_bundle`，`target` 传包的绝对目录
- **不要**手写 profile 的 `package.json` / `cordis.patch.yml`
- **不要**在 profile 目录跑 pnpm
- `plugin_manager` 的每个动作（含 `list_plugins`）都需要审批
- CLI 拒绝启动 desktop profile，所以不能用 `dsh plugin --profile desktop`

### 已安装的 desktop 插件（供参考）

`ds-harness-remote`、`dsh-better-sidebar`、`dsh-connect-workbuddy`、`dsh-session-delete`（link）、`dsh-whale-widget`、`dsh-windows-mcp`、`dshmarket`

### 工具辅助

`tools/_asar-extract.ps1`（本轮创建）可将 asar 内文件提取到工作区：
```powershell
$code = Get-Content "tools\_asar-extract.ps1" -Raw
$sb = [scriptblock]::Create($code)
& $sb -AsarPath "D:\A\DeepSeek Harness\resources\app.asar" `
      -EntryPath "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js" `
      -OutPath "tools\_out.js"
```
> 注意：系统禁止直接执行 `.ps1`，必须走 `[scriptblock]::Create`。
> 会话日志解压可用 Node 24 内置 `zlib.zstdDecompressSync`，但**多帧文件需逐帧解压**（按 magic `28 b5 2f fd` 切分）。

---

## 八、工作区残留物（与本次方案无关）

| 文件 | 说明 | 建议 |
|---|---|---|
| `_prev-session.jsonl` (30 MB) | 上个会话原始日志备份 | 方案落地后再决定 |
| `修复DSH启动.bat` | SSH 排查遗留 | 可删 |
| `tools/_asar-extract.ps1` | 本轮创建，**有用，保留** | 保留 |
| `tools/session-repair/*.mjs` (22 个) | 会话修复脚本 | 可删 |
| `dsh-phone-gateway-DESIGN.md` | 设计文档 | 可并入本文档 |
| `tools/_desktop-host-*.js` | asar 提取产物 | 可删 |

### SSH 遗留状态（用户已决定放弃 SSH）

```
sshd: Running / Automatic，监听 0.0.0.0:22
HKLM\SOFTWARE\OpenSSH\DefaultShell = D:\A\msys64\usr\bin\sh.exe，参数 -c
HKCU\Environment\MSYS2_PATH_TYPE = inherit
C:\ProgramData\ssh\sshd_config 内有 SetEnv MSYS2_PATH_TYPE=inherit
dsh-bin\ 下有 sh / sh.cmd / dsh / dsh.cmd 四个 shim
```
> 这些都是 SSH 方案遗留。是否清理**由用户另行决定**，与网关方案无依赖关系。

---

## 九、风险与回滚

| 风险 | 应对 |
|---|---|
| cookie 换取失败 | 步骤 1 即暴露，停止推进；DSH 不受影响 |
| 会话再次损坏 | 结构上不可能（单实例单写入者） |
| 手机打不开 | 先查防火墙规则，再查热点 AP 隔离 |
| DSH 升级后失效 | 逻辑集中在 `lib/proxy.js` + `lib/auth.js` |
| 彻底撤销 | 卸载插件，8791 立即停止；仅残留一条防火墙规则 |

---

## 十、新会话开场提示词（可直接粘贴）

```
请先读 本仓库的 dsh-phone-gateway-HANDOFF.md。

我们要实现「手机通过局域网访问本机 DSH」。文档里已包含全部已核实的技术事实、
冻结的设计、以及分步实施计划。请直接采信文档中的事实，不要重新调研。

现在只做「步骤 1：骨架 + 冒烟探针」：
1. 在 dsh-phone-gateway/ 下创建 package.json、cordis.patch.yml、index.js
2. index.js 只实现：读 ctx.webServer.port、换取 DSH cookie、监听 0.0.0.0:8791、
   暴露 GET /__lan/status 返回 { port, cookieOk, interfaces }
3. 用 plugin_manager install_bundle 安装这个包
4. 跑 curl http://127.0.0.1:8791/__lan/status 并把结果给我看

如果 cookieOk 不是 true，立刻停下来告诉我，不要继续写步骤 2。
```

---

## 十一、待办清单

- [x] 步骤 1：骨架 + 冒烟探针（**已完成**，`cookieOk: true`）
- [x] 步骤 2：HTTP 反代（**已完成**，页面/资源/API/无 cookie 泄漏）
- [x] 步骤 3：WS 实时流（**已完成**，101 + permessage-deflate 穿透 + 双向 ping/pong）
- [x] 步骤 4：配对 + 设备白名单（**已完成**，6 位码 / 吊销即时生效 / 中英双语）
- [x] 步骤 5：防火墙（**已完成**，结论：**无需新增规则**，见下方说明）
- [ ] 步骤 6：手机实测（**进行中**，手机已配对成功并进入界面，6 条验收需用户确认）
- [x] 步骤 7：收尾（**已完成**，README + EADDRINUSE 重试 + 3 套回归测试）
- [ ] 阶段 2（另议）：`/m` 手机专用页
- [ ] 另行决定：SSH 遗留清理
- [ ] 另行决定：工作区残留文件清理

---

## 十三、手机 APP（2026-11-10 追加）

原始需求只到"浏览器访问"，但实际使用暴露出三个问题，均已实现：

| 需求 | 方案 | 状态 |
|---|---|---|
| 不想每次输网址 | WebView 壳 APP | ✅ 已构建 |
| **换网后 IP 变，要重新记网址** | **UDP 广播自动发现（8792）** | ✅ 实测通过 |
| 字太小 | `WebSettings.setTextZoom`（默认 165%，可调 100-250%） | ✅ 已实现 |

### 关键决策：为什么不是二维码

二维码编码的是**某一刻的地址**，换热点即失效。6 位配对码同理——证明身份但不携带位置。
真正解决"地址会变"的是**让手机问网络**：

```
APP  ──广播──▶ 255.255.255.255:8792  {"probe":"dsh-phone-gateway"}
网关 ──单播──▶ APP                    {"url":"http://10.x.y.z:8791"}
```

实测回包：`{"service":"dsh-phone-gateway","url":"http://10.61.18.139:8791","port":8791,"address":"10.61.18.139"}`

### 新增文件

```
android/
├── AGENTS.md                    # 6 条构建约定（每条对应一个坑）
├── README.md
├── AndroidManifest.xml
├── src/com/dsh/lan/{Discovery,MainActivity}.java
├── res/mipmap-*/ic_launcher.png
├── make_icons.py
└── build/{build.ps1, dsh-phone-gateway.apk, dsh-phone-gateway.keystore}

dsh-phone-gateway/lib/discovery.js   # UDP 发现服务
tools/test-discovery.mjs           # 15 项
tools/test-discovery-contract.mjs  # 8 项（APP ↔ 网关协议一致性）
tools/udp-discovery-probe.mjs      # 端到端广播探测
```

### 构建链（无 Gradle）

`javac → jar → d8 → aapt2 compile/link → aapt add → zipalign → apksigner`

产物 `android/build/dsh-phone-gateway.apk`：25,218 字节，v2/v3 签名通过。
签名密钥 `build/dsh-phone-gateway.keystore`（口令由维护者保管，不写入仓库）**不可删**，否则无法覆盖安装。

### 新增的 2 个真实缺陷（均已修复）

6. **`dgram.send` 回调成功时为 `null` 不是 `undefined`** —— `error !== undefined` 对每次成功发送都为真，读 `null.message` 抛异常，从 libuv 回调逃逸**杀掉 DSH 进程**。修复：判断 `!== null && !== undefined` + 消息处理器整体 try/catch。已固化进 `test-discovery.mjs` 第 2 项。
7. **`reuseAddr: true` 让多个 socket 共享同一 UDP 端口**，Windows 把数据报只投给其中一个，导致新代码收不到包、旧代码在处理。修复：去掉 `reuseAddr`，冲突变成显式 `EADDRINUSE`。

### 未验证的部分

- **APK 未在真机运行**（`adb devices` 无设备）。已验证：编译、dex 类完整、manifest 属性（`usesCleartextTraffic`/`hardwareAccelerated`）、签名、与网关的协议一致性。**UI 行为、WebView 兼容性、发现成功率需真机确认。**

---

## 十四、侧边栏入口（2026-11-10 追加）

用户要求：在 Web UI 侧边栏底部（设置按钮上方、账户行上方的空白区）加一个「局域网网关」入口，显示使用方法 + 跳转配对页的按钮。

### 实现

- 新增 `dsh-phone-gateway/client.js`（浏览器半，8.7 KB）
- `package.json` 加 `dsh.client`（`platform: web`, `immediately: true`, `inject: [@deepseek-ai/dsh-client-ui-sidebar]`）和 `./client` 导出
- 注册插槽：`sidebar.footer.action`（**list 型**，id `lan-gateway-entry`，order 10）

**不与原标签冲突的实证**：

```json
"occupants": [
  { "registrant": "tk", "id": "cordis-panel", "priority": 0, "active": true },
  { "registrant": "tk", "id": "lan-gateway-entry", "order": 10, "priority": 0, "active": true }
]
```

两个 id 并存，`cordis-panel` 未受影响。

### 入口内容

- 4 步使用说明（生成码 → 打开 APP → 输码 → 完成）
- 「打开配对页」→ `http://127.0.0.1:8791/__lan/devices`
- 「查看网关状态」→ `http://127.0.0.1:8791/__lan/status`
- 跟随 host 明暗主题；侧边栏折叠时自动收成图标

### 已验证

- `__DSH_BOOT__` entries 中出现 `{"id":"dsh-phone-gateway","url":"plugins/??dsh-phone-gateway/client.js&rev=fc8f50512649","inject":["@deepseek-ai/dsh-client-ui-sidebar"],"immediately":true}`
- 批量 bundle 请求返回 **200 / 8776 bytes**，内容含 `sidebar.footer.action`、`lan-gateway-entry`、`打开配对页`
- 插槽 occupants 中 `active: true`

### 验证盲区

**未做浏览器实机验证**（无浏览器自动化，Edge 在沙箱内崩溃）。插槽注册和 bundle 分发已证实，但**渲染结果需用户刷新页面确认**。



---

## 十二、实施结果（2026-11-10 实测更新）

### 已完成

| 步骤 | 结果 |
|---|---|
| 1 骨架 + cookie | `{port: 50215→60752, cookieOk: true, cookieVerified: true}` |
| 2 HTTP 反代 | 首页 47725B、viewport→`width=1024`、JS/CSS 与直连逐字节相等、`/api` 404（已过栅栏）、无 Set-Cookie 泄漏 |
| 3 WS | `101 Switching Protocols`、`Sec-WebSocket-Accept` 校验通过、`permessage-deflate` 穿透、DSH ping 双向 |
| 4 配对 | 未配对全路径 401 + 配对页；配对后 HTTP+WS 均通；吊销立即生效 |
| 5 防火墙 | 已有 `DeepSeek Harness.exe` 进程级规则（`Profile=Public`，无 `LPort`）已覆盖，**不需要额外端口规则** |
| 7 收尾 | README、`EADDRINUSE` 重试（5 次×4s）、`bindAll` 实现、3 套测试 65 项断言 |

### 与本文档原假设不一致的地方

| 原假设 | 实际情况 |
|---|---|
| 需要手动加 8791 防火墙规则（步骤 5） | **不需要**，进程级规则已放行任意端口 |
| `trustedHosts` 可能需要配置 | **不需要**，改写 `Host` 为回环即可过栅栏 |
| 可能要用 `tapIndex` 注入 viewport | 反代场景用不上；按文档的对策：导航请求剥 `gzip` + 重算 `content-length` |
| `Config` 用 schemastery schema | **改用普通对象 + 手写校验**：包以 junction 安装在 profile，解析不到外部依赖 |

### 实际文件清单

```
dsh-phone-gateway/
├── package.json
├── cordis.patch.yml
├── index.js
├── README.md
├── lib/{config,net,auth,proxy,ws-proxy,pair,pair-page}.js
├── locale/{zh,en}.json
└── icon.svg

tools/
├── test-device-store.mjs   # 13 项
├── test-config.mjs         # 31 项
├── test-net.mjs            # 21 项
└── ws-live.mjs             # WS 活体探针
```

### 设备存储位置

`$DSH_HOME/storages/lan-gateway/devices.json`（含设备清单 + HMAC 签名密钥）

### 实施中踩到并修复的真实缺陷

1. **DSH 进程崩溃（严重）**：`DeviceStore.verify()` 同步调用 `createHmac('sha256', null)`，冷启动后第一个带 cookie 的请求触发 `ERR_INVALID_ARG_TYPE`，异常从 `createServer` 回调上抛，**杀掉整个 DSH 进程**。修复：密钥未就绪时 `verify()` 返回"未配对"、`apply()` 监听前 `await devices.load()`、HTTP/upgrade 处理器各加 try/catch。已固化进 `test-device-store.mjs` 第 1 项。
2. **未配对设备可拿静态资源**：配对闸门放在代理之后，`/assets/*.js` 曾返回 200。已改为所有非回环请求先验设备 cookie。
3. **配对页/设备页 URL 写相对路径**：`/` 上的 `fetch('pair')` → `/pair`；`/__lan/devices` 上的 `fetch('__lan/code')` → `/__lan/__lan/code`（405）。全部改绝对路径。
4. **`codeStatus()` 非幂等**：读取即销毁配对码，导致设备页刷新后码消失。
5. **`bindAll` 是空配置**：声明了但从未使用。已实现。

