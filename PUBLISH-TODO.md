# npm 发布待办（定时任务会读取本文件）

## 为什么还没发

npm 平台规则：

```
403 dsh-phone-gateway cannot be republished until 24 hours have passed.
```

整包删除后，**同一包名 24 小时内禁止重新发布**。

| | |
|---|---|
| 删除时间 | 2026-11-11 08:23:53 UTC |
| 可重发 | 2026-11-12 08:23:53 UTC |
| 北京时间 | **2026-11-12 16:23:53** |
| 定时任务触发 | 2026-11-12 16:40（留 17 分钟缓冲） |

## 当前已完成 / 待完成

| 项 | 状态 |
|---|---|
| 本地代码统一（版本 0.1.0，全库 0 处旧名） | ✅ |
| 15 套测试 / 502 断言 | ✅ 全过 |
| GitHub 仓库重建 + 首次提交 | ✅ `MrKillerBad/dsh-phone-gateway`，1 个提交 |
| **npm 发布 0.1.0** | ⏳ 等锁定期 |
| **GitHub Release v0.1.0** | ⏳ 等 npm 成功后一起做 |
| **市场 PR** | ⏳ 仓库需满 24 小时，同样在 2026-11-12 后 |

## 令牌

在 `D:\B\令牌.txt`：

- npm：`npm_tLbO...`（Automation 类型，bypass_2fa=true，**可发布但不允许删除**）
- GitHub：`ghp_OUB9...`（scope 只有 `repo`；**建仓够用，删仓需要 `delete_repo`**）

## 发布命令（已验证可行的写法）

```powershell
$root='D:\B\DeepSeekWork\deepseek-dshbridge'
$nt=(Get-Content 'D:\B\令牌.txt' | Select-String 'npm令牌').Line -replace '.*：',''
$npmrc="$root\dsh-phone-gateway\.npmrc"
[System.IO.File]::WriteAllText($npmrc, "//registry.npmjs.org/:_authToken=$nt`n", (New-Object System.Text.UTF8Encoding($false)))
Push-Location "$root\dsh-phone-gateway"
& "D:\A\DSH\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "D:\A\DSH\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" `
  publish --access public --no-git-checks --reporter=append-only
Pop-Location
Remove-Item $npmrc -Force
```

**不要下载 npm CLI**——那个包 26 MB，在这个网络下必然超时（已试过两次）。

## 发布后必须检查的三件事

1. **`latest` 标签**：这个账号发布后标签偶尔不跟（`latest` 停在旧版本）。用
   `npm dist-tag add dsh-phone-gateway@0.1.0 latest` 修正。
2. **`npm pack` 下载验证**：确认包内 `assets/dsh-phone-gateway.apk` 存在且 37,510 B。
3. **三处逐字节比对**：本地 / GitHub raw / npm tarball。

## GitHub Release 要点

- tag `v0.1.0`
- 资产名 **`dsh-phone-gateway.tgz`（不带版本号）**
  → 否则下次发版 `releases/latest/download/...` 会 404，而且没人会察觉
- 上传端点：`https://uploads.github.com/repos/MrKillerBad/dsh-phone-gateway/releases/<id>/assets?name=dsh-phone-gateway.tgz`

## 市场 PR（Release 之后）

条目文件已备好：`marketplace/catalog-entry.yml`

提交到 `awesome-dsh-plugin/awesome-dsh-plugin`，路径：

```
data/plugins/MrKillerBad__dsh-phone-gateway--dsh-phone-gateway.yml
```

仓库创建于 2026-11-11，CI 要求满 24 小时，**与 npm 锁定期同步解除**。
