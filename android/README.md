# DSH Phone Gateway — 手机 APP

把 `dsh-phone-gateway` 的网页界面装进一个 Android 壳里，并且**自己找到电脑**——不用输网址，换网也不用重配。

---

## 为什么是这个方案

你提的三个问题，前两个的核心其实是同一件事：

| 问题 | 表面诉求 | 真正原因 |
|---|---|---|
| 每次要开浏览器输网址 | 想要一键进入 | 网页没有入口 |
| **换网后 IP 变了要重输** | 想要省事 | **地址是写死的** |
| 字太小 | 想要放大 | 前端全用 px，无响应式 |

**二维码解决不了第二个问题**：码里编码的是某一刻的地址，换一个热点就作废，还得走回电脑重新扫。6 位配对码同理——它证明身份，不携带位置。

所以本 APP 采用 **UDP 广播自动发现**：

```
APP  ──广播──▶ 255.255.255.255:8792  {"probe":"dsh-phone-gateway"}
网关 ──单播──▶ APP 的 socket          {"url":"http://10.x.y.z:8791"}
```

回包是**此刻**的地址。换网后广播打到新网段，网关回答新地址。**打开 APP 就直接进入，无感。**

---

## 安装

**最省事的方式：直接在手机上下载。**

电脑上安装「局域网网关」插件后，侧边栏底部点「局域网网关」，
面板顶部会显示下载地址（如 `http://10.61.18.139:8791/__lan/app`）——用手机浏览器打开即可。

或者手机打开 `http://<电脑IP>:8791`，配对页上也有「下载 Android APP」按钮。
**下载不需要先配对**（APP 与浏览器是两套 cookie，先配对会导致配两次）。

`build.ps1` 每次构建后会自动把 APK 同步到 `dsh-phone-gateway/assets/`，
网关随即可以投递，不需要重启插件。

### 手动安装

APK 在 `build/dsh-phone-gateway.apk`（约 33 KB）。

传到手机后安装。首次安装需要允许「未知来源」：

- 设置 → 应用 → 特殊权限 → 安装未知应用 → 选你的文件管理器/浏览器 → 允许
- 或 `adb install -r build/dsh-phone-gateway.apk`

> 签名是自签的（`build/dsh-phone-gateway.keystore`，口令 `dshlan`）。**不要删除这个文件**，删了就无法覆盖安装新版本（Android 会拒绝不同签名的同包名应用）。

---

## 使用

1. 手机连上电脑所在的网络（同一热点或同一 WiFi）
2. 打开 DSH APP
3. APP 自动搜索（约 2.5 秒）→ 找到后直接进入 DSH 界面
4. 首次进入会看到配对页 → 在电脑上打开 `http://127.0.0.1:8791/__lan/devices` → 生成配对码 → 输入
5. 之后 180 天内打开即用

### 找不到电脑时

APP 会显示「连接到电脑」页面，预填上次成功的地址。三种情况：

| 情况 | 处理 |
|---|---|
| 换了网络 | 点「重新搜索」，广播会打到新网段 |
| 广播被拦（AP 隔离） | 手动输入地址，格式 `http://<电脑IP>:8791` |
| 电脑没开网关 | 先在电脑上确认 `http://127.0.0.1:8791/__lan/status` 正常 |

地址可在电脑上查：`http://127.0.0.1:8791/__lan/status` 的 `interfaces` 字段。

### 字号与配色

界面右上角有一个 **⚙** 浮动按钮，**任何页面状态下都能点开**：

- **字号滑块** 100%–350%，默认 165%，实时生效并记住
- **配色二选一**：浅色（与电脑默认一致）/ 深色

> 早期版本把字号滑块放在底部，叉掉后只能重启 APP 才能再调。现在已改为常驻的 ⚙ 入口。
>
> 上限 350% 是产品选择：`WebSettings.setTextZoom` 本身接受任意整数，而前端是**桌面布局**，超过大约 350% 后它不再重排，内容会横向溢出。范围由 `MIN_TEXT_ZOOM` / `MAX_TEXT_ZOOM` 两个常量控制，滑块跨度和读取时的钳制都取自它们。

**配色是怎么生效的**（这点很关键，我第一版写错了）：

`WebSettings.setForceDark` 在 **Android 13 起已弃用且完全无效**。DSH 的界面靠 CSS 属性切换主题：

```css
body[data-ds-dark-theme] { --dsw-alias-bg-base: #151517; ... }
```

所以 APP 通过 `evaluateJavascript` 直接设置这个属性——**和 DSH 主题服务用的同一个开关**。设置在 `onPageFinished` 里应用，每次导航后重新应用。

**为什么不能「跟随电脑」**：DSH 的主题偏好存在 Host 的 settings 文档里，WebView 页面读不到，所以手机无法知道电脑选了哪个。只能手选，但选择会被记住。

### 侧边栏

侧边栏开关**注入在网页内部**，不是原生浮层：贴在**侧边栏右边缘、垂直居中**，是一条约 22×76dp 的竖条。侧边栏收起时它跟着移到 56dp 细条右侧，箭头从 `‹` 变 `›`。

**为什么必须注入到页面里**：侧边栏的宽度是 React 元素上的内联 `style.width`，并带 **`transition: width 0.3s`**。原生浮层要跟随就得轮询几何、还要和动画打架。

**为什么把手是侧边栏的 absolute 子元素**（四次返工才定下来）：

| 版本 | 做法 | 结果 |
|---|---|---|
| 1 | 原生 Button 浮动 | 位置写死，不跟随 |
| 2 | `fixed` + rAF + `transition:left` | 跟随但延迟（transition 与侧边栏 0.3s 宽度动画叠加） |
| 3 | `absolute` 子元素，`right: -11px` | **跟随完美**，但骑在边界上，被 overflow 祖先裁掉大半 |
| 4 | **`absolute` 子元素，`right: 5px`** | 跟随 + 完整可见 |

关键认识：**「跟随」和「可见」是两件事**。`absolute` 子元素由浏览器在同一次布局里带过去，天然无延迟；但样式里只要让把手越过边界（负 `right`），就会被裁剪。改成正的 `right: 5px`——紧贴右边缘、留 5px 空隙、完全在内部——两个目的同时达成。

不需要任何脚本跟随：没有 `requestAnimationFrame`，也不需要 `ResizeObserver`。

尺寸 30×96，字号 19。

**DSH 自带的那个 ◧ 保留不动**，两者都能用。

> 早先版本把开关做成原生 `Button` 放在右上角 / 左边缘，都无法跟随侧边栏收放，实测不合适，已改为注入方案。

### 浮动按钮

**右上角**两个圆形按钮，固定 40×40dp：

| 按钮 | 作用 |
|---|---|
| ⚙ | 字号与配色（只在应用外壳**挂载完成**后显示；加载页、配对页、「设备正在使用中」页都隐藏） |
| — | 从网关页面回到应用页时自动重建 WebView，修掉缩放残留 |
| ＋ | 发送图片或文件 |

**左边缘**一个：◧ 侧边栏开关。

> 早先版本里按钮被渲染成窄条，因为 `Button` 在竖直 `LinearLayout` 里会按文字收缩，且主题背景把单个字形画成细长胶囊。现在用 `GradientDrawable(OVAL)` 自绘圆形背景 + 显式 `setMin/MaxWidth/Height`，所有按钮大小完全一致。

### 发送图片和文件

**DSH 自己的 + 按钮不是文件按钮。** 这一点我最初判断错了，查源码才确认：

```js
aria-label: t("input.commands"),   // "调用指令"
onClick: onToggleCommandMenu,      // 打开 / 命令菜单
```

它打开的是 `/` 命令菜单（文件 / 目标 / 计划 / 反馈…），不是文件选择器。DSH 确实有一个隐藏的 `<input type="file">`，但它只绑定到键盘手势和拖拽，**没有任何可见控件会点它**。

所以 APP 自己加了 **＋ 浮动按钮**（右上角，⚙ 和 ◧ 下方）：

1. 点击 → 收起键盘 → 打开系统文件选择器
2. 选完 → 原生读取文件字节 → 以 base64 传给页面
3. 页面重建 `File` 对象 → 赋给 composer 那个隐藏 input 的 `files` → 触发 `change`
4. DSH 自己的上传逻辑（校验、大小限制、进度）原样运行

**为什么走 base64 而不是直接传 URI**：`content://` URI 在 WebView 里的 `fetch()` 完全无法解析，必须让原生侧读成字节。

**键盘时机**：选择器打开前把 WebView 设为**不可获得焦点**（不只是 `clearFocus()`），因为 contenteditable 会在 WebView 被触碰时立刻重新拉起 IME——而从系统选择器返回就算一次触碰。文件交付后再恢复焦点，所以点输入框键盘会正常弹出。

> 只调用 `clearFocus()` 是不够的，这是实测后修的第二版。

---

## 技术结构

```
android/
├── AndroidManifest.xml          # 2 个权限，cleartext 允许
├── src/com/dsh/lan/
│   ├── Discovery.java           # UDP 广播发现
│   └── MainActivity.java        # WebView 壳 + 字号控制 + 回退 UI
├── res/mipmap-*/ic_launcher.png # 图标（make_icons.py 生成）
├── build/build.ps1              # 无 Gradle 构建脚本
├── build/dsh-phone-gateway.apk            # 产物
└── make_icons.py                # 图标生成
```

### 权限（只有两个）

| 权限 | 用途 |
|---|---|
| `INTERNET` | WebView 访问电脑 |
| `ACCESS_NETWORK_STATE` | 枚举网卡，算出广播地址 |

**没有**相机（不扫码）、没有存储（不读文件）、没有位置。

### 为什么不用 Gradle

本机没有 Gradle，且 npm 源不可达。构建走 SDK 原始工具链：

```
javac → jar → d8 → aapt2 compile/link → aapt add → zipalign → apksigner
```

整条链路已在实机上验证通过（见 `../AGENTS.md` 的 6 条约定，每条都对应一个踩过的坑）。

---

## 构建

```powershell
cd android\build
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -Clean
```

需要环境（脚本内有默认值）：

| 变量 | 默认 |
|---|---|
| `ANDROID_SDK_ROOT` | `D:\A\Android\Sdk` |
| `ANDROID_BUILD_TOOLS` | `36.0.0` |
| `ANDROID_PLATFORM` | `android-37.0` |
| `DSH_APP_JDK` | `D:\A\Android\Android Studio\jbr` |
| `DSH_PYTHON_ROOT` | 未设时跳过图标重生成 |

### 测试

```powershell
# 注入到网页里的侧边栏脚本：还原 Java 字符串拼接后做 JS 语法检查
node tools/test-sidebar-script.mjs

# 侧边栏选择器：用真机上报的 DOM 数据回归
node tools/test-sidebar-selector.mjs

# APP 壳的行为：凭据重放、断线重连、字号范围
node tools/test-app-cookie.mjs

# 只想看看还原出来的脚本长什么样
node tools/dump-sidebar-script.mjs tools\_extracted.js
node --check tools\_extracted.js
```

> `test-sidebar-script.mjs` 值得单独说：注入的 JS 是 Java 字符串拼接出来的，**javac 完全看不出里面的语法错误**，只有手机端才会表现为「控件不出现」。这个测试把字符串按 Java 的规则还原，再做 `new Function()` 语法检查，并且断言了几条曾经踩过的语义约束（append 早于 place、不观察 childList、无 rAF 循环等）。

### 踩过的坑

1. **`d8.bat` 用 PATH 上的 JRE 8**，跑不了 d8（class 52 vs 55）→ 直接 `java -cp d8.jar com.android.tools.r8.D8`
2. **PowerShell 按 `:` 拆 `D:\...` 参数** → 先把 class 打成 jar，只传一个路径
3. **PowerShell 写文件带 BOM**，javac 报 `illegal character '\ufeff'` → 必须 `UTF8Encoding($false)`
4. **`aapt2 link` 报 `does not override an existing resource`** → 加 `--auto-add-overlay`
5. **`WebView.setTextZoom` 不存在**，是 `WebSettings.setTextZoom`
6. **`apksigner` 的 JVM 警告走 stderr**，在 `$ErrorActionPreference='Stop'` 下被当成错误 → 改用 `cmd /c` 并只看退出码
7. **`-Clean` 删 `build/` 会把脚本自己删掉** → 只删产物
8. **`setWebChromeClient` 只能有一个** —— 先设带 `onShowFileChooser` 的，再设带 `onProgressChanged` 的，后者会**覆盖**前者，上传静默失效。必须合并成一个 client
9. **没有侧边栏快捷键** —— 查过 `dsh-client-shortcuts`，侧边栏没有绑定按键，所以派发合成 `KeyboardEvent` 不可行；必须点击 `[data-sidebar-toggle]`
10. **dex 里的中文是 MUTF-8** —— 用 Latin1 读取会全部匹配失败，看起来像「没编译进去」，实际是解码方式错了
11. **`setForceDark` 在 Android 13+ 完全无效** —— 第一版以为能控制网页配色，实际是死代码。DSH 靠 `body[data-ds-dark-theme]` CSS 属性切换，必须用 JS 设这个属性
12. **常量名不会出现在 dex 里** —— `ACTION_GET_CONTENT` 编成字符串 `"android.intent.action.GET_CONTENT"`，用常量名去 dex 里搜会误报缺失
13. **DSH 输入框的「+」是命令菜单，不是文件按钮** —— 源码里是 `aria-label: input.commands` / `onToggleCommandMenu`。它打开 `/` 命令菜单。文件 input 是隐藏的、只绑键盘和拖拽手势。**这就是「点了只弹键盘」的根因**：根本没有控件去点那个 file input
14. **`content://` URI 在 WebView 里读不到** —— `fetch()` 无法解析系统选择器返回的 URI，必须原生读成字节再以 base64 交给页面
15. **Java 里不能写 `===`** —— 我写替换脚本时把 JS 运算符带进去了，javac 报「非法的表达式开始」
16. **`FrameLayout.LayoutParams(size, size)` 会裁掉纵向堆叠** —— 浮动按钮容器原本宽高都钉死 40dp，结果只显示第一个按钮（⚙），后两个被裁掉了。高度必须用 `WRAP_CONTENT`
17. **`clearFocus()` 挡不住 IME** —— contenteditable 在 WebView 被触碰时会重新拉键盘，从选择器返回也算触碰。必须 `setFocusable(false)` + `setFocusableInTouchMode(false)`，返回后再恢复
18. **`Button` 在竖直 LinearLayout 里会按文字收缩** —— 主题背景把单个字形画成细长胶囊。必须自绘 `GradientDrawable(OVAL)` 并显式设置 `setMin/MaxWidth` + `setMin/MaxHeight`，否则同一列里的按钮宽度不一致
19. **`place()` 之前必须先把节点插进文档** —— `place()` 靠 `getElementById` 找把手，而 `build()` 里漏了 `document.body.appendChild(handle)`，导致把手永远不出现。这条已固化成测试断言（append 必须早于第一次 `place()`）
20. **不要用 `childList: true` 观察 `document.body`** —— 聊天流式输出每来一个 token 都会触发回调，`place()` 里又走全 DOM 遍历 + 序列化 `innerHTML`，等于给主线程上刑。改为只观察 `attributeFilter: ['class']`，另加 1.5s 的存活检查处理 SPA 重渲染
21. **Java 源是 CRLF，不能用 `"\n\n"` 切声明结尾** —— 永远匹配不到，切片会一路吞到文件末尾，把后面的方法也当成字符串内容。必须用 `/\r?\n\r?\n/`。这个错误会让注入脚本语法崩掉，但**看起来完全像源码没问题**

---

## 已知限制

| 限制 | 说明 | 影响 |
|---|---|---|
| **需要 UDP 8792 入站放行** | Windows 默认拦入站 UDP | 未放行时发现失败，回退手动输地址 |
| **AP 隔离** | 部分热点默认开启，设备间互相不可见 | 广播无效，必须手动输地址 |
| **不做扫码** | 本机无可用的 QR 库（npm 不通） | 换网时靠广播而非重扫 |
| **自签 APK** | 无 Play Store 上架 | 需手动允许未知来源 |
| **Target SDK 34** | Android 14+ 对后台行为有额外限制 | 目前只用到前台 WebView，不受影响 |
| **明文 HTTP** | `usesCleartextTraffic=true` | 同网段可嗅探；仅限可信网络使用 |
| **配色需手动对齐** | 无法读取电脑端 settings 文档 | 电脑显式选了深色时，APP 也要切深色 |
| **`setForceDark` 需 API 29+** | Android 10 以下该调用被跳过 | 旧机型配色始终跟随系统 |

### 若发现失败，先查这条

UDP 8792 可能需要防火墙放行（**管理员权限**）：

```bat
netsh advfirewall firewall add rule name="DSH Phone Gateway Discovery" dir=in action=allow protocol=UDP localport=8792 profile=private,public
```

撤销：

```bat
netsh advfirewall firewall delete rule name="DSH Phone Gateway Discovery"
```

---

## 卸载

APP 内无数据。卸载即可。

电脑侧若要彻底关闭：插件管理里禁用 `dsh-phone-gateway`，8791 与 8792 同时释放。
