# DSH Phone Gateway

**用手机控制跑在电脑上的 DeepSeek Harness —— 同一个进程，不需要第二个实例，不需要公网。**
Let a phone reach the DeepSeek Harness that is already running on your computer, over the
same Wi-Fi or hotspot. One process, no second instance, no public network.

[![version](https://img.shields.io/badge/version-0.1.0-blue)]() [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 它解决什么 / What it solves

DSH 跑在电脑上，你想躺在床上用手机继续同一个会话。局域网里能连上，但手机上打开的是
一个 1024px 的桌面界面，地址每次换网就变，还没法把配对限定在自己人手里。

This plugin fronts the DSH that is already running:

| 你得到 | 怎么做的 |
|---|---|
| 手机访问同一个 DSH | 反向代理到 `127.0.0.1:<DSH 端口>`，改写 `Host`/`Origin` 过掉同源栅栏 |
| 换网不用重新输地址 | UDP 广播发现（`:8792`） |
| 只有你的手机能连 | 6 位配对码 + HMAC 签名设备 cookie（180 天，可吊销） |
| **同一时刻只有一台手机在控制** | 单控制席位：主控可随时接管，其它手机等待并看到「设备正在使用中」 |
| 原生 APP | WebView 壳 + 自动发现 + 心跳重连 + 字号/深色/上传 |
| 手机端新建工作区可选目录 | 网页选择器（盘符切换），电脑端仍用原生对话框 |

## 安装 / Install

**从 npm 安装（推荐）：**

```sh
dsh plugin add dsh-phone-gateway
```

**从本仓库安装：** 把 `dsh-phone-gateway/` 放进 profile 并启用：

```yaml
# cordis.patch.yml
- insert:
    - id: lan-gateway
      name: 'dsh-phone-gateway'
```

> 本机从目录安装时，`name` 要与 `package.json` 的 `name` 一致；仓库目录叫
> `dsh-phone-gateway/` 只是仓库内的路径。

启用后侧边栏会出现「局域网网关」：面板里有二维码、下载地址和配对码。
手机扫码装 APP → 输配对码 → 打开即用。

详细步骤见 **[dsh-phone-gateway/README.md](dsh-phone-gateway/README.md)**。

## 仓库结构 / Layout

```
dsh-phone-gateway/   插件（Node，14 个文件）：HTTP/WS 反代、配对、席位、发现、二维码
android/           APP（Java，无 Gradle）：WebView 壳、发现、心跳、UI 覆盖层
tools/             15 套测试 / 502 项断言 + 4 个诊断脚本
PROJECT-REPORT.md  架构、设计决策、踩过的坑、升级与排障
```

## 构建 / Build

插件不需要构建。APP：

```powershell
# 需要 Android SDK + Android Studio 的 JBR，见 android/AGENTS.md
cd android/build
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -Clean
```

产物会自动发布到 `dsh-phone-gateway/assets/`，手机从 `/__lan/app` 直接下载。

> 签名口令保存在本地 `.secrets.local`（已 gitignore）。**keystore 绝不在仓库里**：
> 泄露它就等于让任何人能给你的手机签一个「新版本」。

## 测试 / Tests

```powershell
node tools/test-slot.mjs       # 席位规则
node tools/ws-seat-probe.mjs   # 两台真实设备抢位（需要运行中的网关）
```

共 15 套、502 项断言。

## 安全边界 / Security

- 配对后的手机拥有**完整 owner 权限**——DSH 分不出「这是手机」。不用的设备请及时吊销。
- 局域网内**没有 TLS**，流量可被嗅探。只在可信网络使用。
- 默认只服务同网段设备。

## License

[MIT](LICENSE)