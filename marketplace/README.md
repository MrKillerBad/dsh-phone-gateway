# 上架市场（无需 npm）

插件市场 `awesome-dsh-plugin/awesome-dsh-plugin` 的目录是**策展数据**：一条插件 =
`data/plugins/` 下的一个 YAML 文件。它**不要求发布到 npm**——可以指向 GitHub 仓库，
并附带一个预构建 tarball。

## 已准备好的内容

| 项 | 值 |
|---|---|
| 提交文件 | `data/plugins/MrKillerBad__dsh-phone-gateway--dsh-phone-gateway.yml` |
| 仓库 | https://github.com/MrKillerBad/dsh-phone-gateway |
| 包目录 | `dsh-phone-gateway/`（单仓子包，故用 `tree/main/<dir>` 与 `owner/repo#sub` 形式） |
| Release | https://github.com/MrKillerBad/dsh-phone-gateway/releases/tag/v0.1.0 |
| tarball | https://github.com/MrKillerBad/dsh-phone-gateway/releases/latest/download/dsh-phone-gateway.tgz（资产名**不带版本号**，否则下一次发版 `latest/download` 会 404） |
| 图标 | `android/res/mipmap-xxhdpi/ic_launcher.png`（必须是位图，SVG 不收） |

本地条目原文见 [`catalog-entry.yml`](catalog-entry.yml)。

## 还差一步：仓库满 24 小时

市场的 CI 有一条硬性门槛：

> The repo is at least **1 day old**.

仓库创建于 2026-11-11，**当天提交的 PR 会被自动判定不达标**。指南明确说明这不是
对插件质量的评价，只是为了过滤「PR 前几分钟才建好的仓库」，并且「重新提交不会有
任何影响」。

所以：**等满 24 小时后再提交**。届时把 `catalog-entry.yml` 的内容放到
`data/plugins/MrKillerBad__dsh-phone-gateway--dsh-phone-gateway.yml`，开一个 PR 即可。

## 提交步骤（第二天）

```sh
# 1. fork 并克隆
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin

# 2. 放文件（文件名必须严格按 owner__repo--path 规则）
cp /path/to/catalog-entry.yml \
   data/plugins/MrKillerBad__dsh-phone-gateway--dsh-phone-gateway.yml

# 3. 开 PR（只加这一个文件，不要改生成的 README）
git checkout -b add-mrkillerbad-dsh-phone-gateway
git add data/plugins/MrKillerBad__dsh-phone-gateway--dsh-phone-gateway.yml
git commit -m "Add MrKillerBad/dsh-phone-gateway"
git push -u origin add-mrkillerbad-dsh-phone-gateway
gh pr create --title "Add MrKillerBad/dsh-phone-gateway" --body "DSH Phone gateway: phone access over Wi-Fi, with a paired Android app."
```

合并后目录会自动重建，`dsh-plugin-catalog` 下次发布后市场即可搜到。

## 发版后的维护

- **每次发版都要同步更新 tarball**：Asset 名保持 `dsh-phone-gateway.tgz`（不带版本），
  这样 `latest/download` 永远有效。
- 版本号在 `android/AndroidManifest.xml`（versionCode/versionName）与
  `dsh-phone-gateway/package.json`（version）两处，必须一起改。

## 也可以只走 GitHub

市场支持只指向 GitHub 仓库 + tarball，不需要 npm。本仓库两条路都已备好。