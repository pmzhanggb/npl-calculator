# GitHub 版本管理实操教程

> 调研范围：GitHub Docs 官方 + 一线工程实践（GitHub Flow、PR 流程、Issues/Projects/Discussions、Tags/Releases、Actions 基础）。

---

## 1. 概念地图：Git vs GitHub

**结论**：Git 是本地版本管理工具，GitHub 是托管 Git 仓库的协作平台。先掌握本地 Git 命令，再上 GitHub 用 PR / Issue 做协作。

| 维度 | Git | GitHub |
| --- | --- | --- |
| 形态 | 本地 CLI / 桌面 GUI | 云端 SaaS（也支持自建 GHES） |
| 主要能力 | commit、branch、merge、rebase、tag | Pull Request、Issue、Actions、Release |
| 离线 | 完全可用 | 不可用 |
| 协作 | 需手动 push/pull | 内置 PR 评审、CODEOWNERS、规则检查 |

**版本管理要解决的 4 个问题**：

1. **回滚**：误删/出错能回到任意历史点（commit + tag）
2. **并行**：多人同时改同一仓库互不干扰（branch + PR）
3. **审计**：谁、什么时候、改了什么（commit author + PR history）
4. **发布**：把某个稳定版本固化并对外宣布（Release + SemVer）

---

## 2. 分支模型：GitHub Flow

**结论**：小到中型团队、上线频繁的产品首选 **GitHub Flow**：主干（main）永远可发布，所有改动通过 `feature/*` → PR → merge 回 main。

| 模型 | 分支复杂度 | 适用场景 |
| --- | --- | --- |
| **GitHub Flow** | 仅 main + 短命 feature 分支 | SaaS / Web 应用 / 持续部署 |
| Git Flow | main / develop / feature / release / hotfix | 长期版本（桌面软件、移动端） |
| Trunk-Based Development | 全员直接 commit 到 main（短时分支 ≤1 天） | 高水平 CI/CD + Feature Flag |

**GitHub Flow 6 步实战**：

```bash
# 1. 始终从最新 main 拉分支
git checkout main && git pull origin main
git checkout -b feat/login-page

# 2. 本地多次提交（粒度细）
git add . && git commit -m "feat: 登录表单 UI"
git commit -m "feat: 表单校验逻辑"

# 3. 推送并开 PR
git push -u origin feat/login-page
gh pr create --title "feat: 登录页" --body "## 改动\n- 新增表单\n- 接入 API"

# 4. 评审 + 自动检查通过后合并
gh pr merge --squash --delete-branch

# 5. 同步本地 main
git checkout main && git pull origin main
```

**保护 main 分支**：Settings → Branches → Branch protection rules，勾选：

- ✅ Require a pull request before merging
- ✅ Require approvals (≥1)
- ✅ Require status checks to pass

---

## 3. Pull Request 完整流程

**结论**：PR 不仅是"合并代码"，它是**评审 + 自动化检查 + 历史回溯**的载体。

**PR 生命周期**：创建 → 自动检查（CI）→ 评审者评审 → 修改迭代 → 通过 → 合并 → 删除分支

### 合并策略对比

| 策略 | 提交历史 | 适用场景 | 命令 |
| --- | --- | --- | --- |
| **Merge Commit** | 保留完整分支拓扑与所有人 | 需要追溯"哪些 commit 属于哪个特性" | `gh pr merge --merge` |
| **Squash Merge** | 多个 commit 折成 1 个 | 团队偏好"一个 PR = 一个 commit"，main 历史干净 | `gh pr merge --squash` |
| **Rebase Merge** | 把 PR commit 线性追加到 main | 想保留细粒度但不要合并节点 | `gh pr merge --rebase` |

> 设置默认合并方式：Settings → General → Pull Requests → Allow squash merging / merge commit / rebase。

**PR 模板**（`.github/pull_request_template.md`）：

```markdown
## 改动说明
-

## 关联 Issue
Closes #

## 自测
- [ ] 单元测试通过
- [ ] 手动验证截图
```

**关键约定**：

- 分支保护启用后，main 必须 ≥1 个 **approving review** 才能 merge
- ⚠️ 注意 GitHub 术语是 "approving review"（不是 "Required Reviewer"——后者是 GitLab 的概念）
- 新 push 会重置已批准状态，需重新 approve

---

## 4. Issues / Projects / Discussions

**结论**：三者职能不重叠——选错工具会让协作变混乱。

| 工具 | 核心用途 | 谁来用 | 何时关闭 |
| --- | --- | --- | --- |
| **Issues** | 任务、缺陷、功能请求（具体可执行） | 开发者、维护者 | 完成对应 PR 合并后自动关闭 |
| **Projects** | 看板视图，组织跨 Issue/PR 的工作流 | 团队 PM / Tech Lead | 永远不"关闭"，按 Sprint 滚动 |
| **Discussions** | 问答、公告、开放讨论（不直接产生代码） | 社区、用户 | 维护者标记"已回答" |

**典型场景示例**：

- "Bug：登录 500" → **Issue**（带复现步骤、报错日志）
- "Q2 路线图跟踪" → **Project**（表格或看板视图，列：Backlog / In Progress / Done）
- "为什么选 Vite 而不是 Webpack？" → **Discussion**（问答分类）

**Issue 模板**（`.github/ISSUE_TEMPLATE/bug.yml`）：

```yaml
name: Bug Report
description: 报告缺陷
labels: ["bug"]
body:
  - type: textarea
    id: reproduce
    attributes:
      label: 复现步骤
      placeholder: 1. xxx 2. yyy
    validations:
      required: true
```

---

## 5. Tags 与 Releases（语义化版本）

**结论**：Tag 是 Git 的提交指针，Release 是 GitHub 在 Tag 之上的可编辑封装（可写 changelog、上传二进制）。**公开发布用 annotated tag + Release，不要用 lightweight tag**。

| 类型 | 命令 | 是否含作者/消息/签名 | 适用 |
| --- | --- | --- | --- |
| Lightweight | `git tag v1.0` | 否 | 本地临时标记 |
| **Annotated** | `git tag -a v1.0 -m "release 1.0"` | 是 | **公开发布（推荐）** |
| GPG 签名 | `git tag -s v1.0 -m "..."` | 是（带签名） | 高安全要求场景 |

**SemVer 2.0.0 三段语义**：

- **MAJOR**：不兼容 API 变更
- **MINOR**：向后兼容的新功能
- **PATCH**：向后兼容的 Bug 修复
- 预发布：`1.0.0-rc.1`、`2.0.0-beta.3`
- 构建元数据：`1.0.0+20240615.sha`

**实战命令**：

```bash
# 创建附注标签
git tag -a v1.2.0 -m "feat: 登录模块；fix: 支付回调"

# 推送标签
git push origin v1.2.0
git push origin --tags  # 推送所有本地标签

# 在 GitHub 上基于 tag 创建 Release
gh release create v1.2.0 --title "v1.2.0" --notes-file CHANGELOG.md

# 预发布
gh release create v2.0.0-beta.1 --prerelease --notes "Beta 测试版"

# 草稿（普通用户不可见，可继续编辑）
gh release create v2.1.0 --draft --notes "待发布"
```

> 💡 **自动化建议**：用 [release-please](https://github.com/googleapis/release-please) 让 Conventional Commits 自动生成 Release PR 与 changelog，省去手动操作。

---

## 6. GitHub Actions 基础

**结论**：Actions 是 GitHub 内置的 CI/CD，由 **event → job → step** 三层组成，写在仓库 `.github/workflows/*.yml`。

**YAML 骨架**：

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test

      - name: Build
        run: npm run build
```

**关键概念**：

- `on:` — 触发事件（push、pull_request、schedule 定时、workflow_dispatch 手动）
- `runs-on:` — Runner 环境（ubuntu-latest / windows-latest / macos-latest）
- `needs:` — Job 间依赖（默认并行）
- `secrets:` — 敏感值用 `${{ secrets.MY_TOKEN }}`，**不要硬编码**
- `uses:` vs `run:` — 复用社区 Action vs 执行 shell

**常用 Actions**：

- `actions/checkout@v4` — 拉代码
- `actions/setup-node@v4` / `actions/setup-python@v5` — 装运行时
- `actions/cache@v4` — 缓存依赖（npm/pip/maven）
- `actions/upload-artifact@v4` — 归档构建产物

**调试技巧**：`gh run watch <id>` 实时看日志；本地可用 [act](https://github.com/nektos/act) 跑 workflow。

---

## 7. 推荐起步清单（30 分钟搭好协作环境）

- [ ] **1.** 仓库初始化：`git init` → 首次 commit → 推到 GitHub
- [ ] **2.** 写 `README.md`、`LICENSE`、`.gitignore`（用 [gitignore.io](https://gitignore.io) 生成）
- [ ] **3.** 启用 main 分支保护：Require PR + Require ≥1 approval + Require status checks
- [ ] **4.** 添加 PR 模板（`.github/pull_request_template.md`）与 Issue 模板（`.github/ISSUE_TEMPLATE/`）
- [ ] **5.** 配置 `.github/CODEOWNERS` 指定关键目录的强制评审人
- [ ] **6.** 启用 Squash merge 作为默认合并策略
- [ ] **7.** 写第一个 workflow：`.github/workflows/ci.yml`，至少跑 lint + test
- [ ] **8.** 约定 Conventional Commits（`feat:` / `fix:` / `chore:`），为后续自动 changelog 铺路

**Commit 消息模板**：

```text
<type>(<scope>): <subject>

<body>

<footer>
```

常用 type：`feat`、`fix`、`docs`、`style`、`refactor`、`test`、`chore`、`perf`。

---

## 参考

- [GitHub Flow 官方介绍](https://docs.github.com/en/get-started/using-github/github-flow)
- [About protected branches（分支保护规则）](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [About pull request merges（合并策略）](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges)
- [About Issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/about-issues/about-issues)
- [About Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)
- [About Discussions](https://docs.github.com/en/discussions/collaborating-with-your-community-using-discussions/about-discussions)
- [About releases（Releases 总览）](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Managing releases in a repository](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [git-scm.com: Git Basics - Tagging（lightweight vs annotated）](https://git-scm.com/book/en/v2/Git-Basics-Tagging)
- [git-tag 手册页](https://git-scm.com/docs/git-tag)
- [Semantic Versioning 2.0.0 规范](https://semver.org/)
- [googleapis/release-please（自动化 Release）](https://github.com/googleapis/release-please)
- [Understanding GitHub Actions（event/job/step 结构）](https://docs.github.com/en/actions/get-started/understand-github-actions)
- [Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)
