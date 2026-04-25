# 贡献指南 · Contributing

谢谢你愿意帮 LynLens 变得更好。这份指南把"想贡献什么样的改动 → 怎么走完整个流程"说清楚，省去你猜的时间。

## 项目哲学（先看这条）

LynLens 是 **AI-first** 设计——所有面向用户的功能既要能在 UI 里点，也要能被 AI agent 通过 MCP 工具调。这不是"以后再补"，是**写新代码的硬要求**。

- 新功能必须**同时**：（a）UI 能用、（b）有对应的 MCP 工具暴露给 agent
- 完整原则、文件大小、命名规则、refs 不可靠等踩过的坑：见仓库根目录的 `CLAUDE.md`，这是给 AI 看的也是给人看的标准

## 5 分钟跑起来

```bash
# 你需要：Node.js ≥ 20，pnpm ≥ 10
git clone https://github.com/wilonvives/LynLens.git
cd LynLens
pnpm install
pnpm bootstrap:ffmpeg     # 下 ffmpeg 二进制
pnpm bootstrap:whisper    # 下 whisper.cpp + ggml-base 模型 (~150 MB)
pnpm --filter @lynlens/desktop dev
```

应用窗口弹出来 → 拖一个视频进去 → 你就在跑开发版了。

## 想改点什么？流程

### 小改动（typo / 一个明显的 bug 修复）

1. Fork 仓库 → 在你自己的 fork 上改 → 推上去
2. 在 GitHub 上点 "Compare & pull request" → 写清楚改了什么、为什么
3. 等 review

### 大改动（新功能 / 重构 / 改架构）

**先开 issue 讨论**——不是为了官僚，是为了不让你白做。
设计方向不确定的时候动手，最后被打回来浪费的是双方的时间。

1. 开 issue 描述你想做什么 + 为什么 + 大致怎么实现
2. 等回复（同意 / 调方向 / 婉拒）
3. 同意了再开始写代码、按上面的流程发 PR

### 不用问就动手的范围

- 改 typo
- 修 README 里描述错误的内容
- 加测试
- 修一个明显的 bug（PR 描述里贴出来怎么复现）

## 代码规范

仓库已经配好了 ESLint + Prettier，跑这两个就行：

```bash
pnpm lint           # 检查
pnpm format         # 格式化
pnpm typecheck      # TypeScript 类型检查
pnpm test           # 跑全部单元测试
```

**进 main 之前**这四个都要绿。CI 会自动跑，但本地先跑一遍能省你来回推送的时间。

### 硬规则（CLAUDE.md 里也写了）

- **单文件 ≤ 800 行**（typical 400）。超了 ESLint 会喊；要么先拆再加。
- **新 IPC handler 进 `main/ipc/<domain>.ts`**，绝不加进 `main/index.ts`
- **新 UI 组件进 `renderer/components/<Name>.tsx`**，不加进 `App.tsx`
- **transcript 段是 source time，timeline 是 effective time**——参数名带 `srcSec` / `effSec`，转换在边界上一次性做（`core/ripple.ts`）
- **写 `videoElement.currentTime` 之前 `Number.isFinite` 守一下**——NaN 会把 RAF 链 throw 死

## Commit message 风格

用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>: <短描述>

<可选的详细 body — 解释 why，不是 what>
```

`type` 选一个：
- `feat:` 新功能
- `fix:` bug 修复
- `refactor:` 重构（行为不变）
- `docs:` 文档
- `test:` 加测试
- `chore:` 杂项（CI / 依赖升级 / 版本号）
- `perf:` 性能
- `ci:` CI 配置

例：

```
fix(export): preserve color tags for HDR sources

Mac plays correctly without explicit tags because QuickTime falls back
to BT.709, but Windows native player follows the tags strictly. Without
forwarding the source's color_primaries / color_transfer / color_space
into the output, HDR sources show a yellow-green cast on Windows.
```

PR 标题用同样的格式。

## PR 怎么写

PR 描述按 [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) 来——GitHub 会自动塞进编辑框，你填空即可。

关键三块：
- **改了什么** — 简短列点
- **为什么** — 解决什么问题 / 解锁什么场景
- **怎么测的** — 你自己跑过哪些路径

## 我会怎么 review

- **小 PR（< 100 行 diff）**：通常 24-72 小时内回复
- **大 PR**：一周内
- 风格上的小毛病（命名、注释）我会**直接帮你改了 push** 到你的 PR 分支，不让你来回挂
- 方向上的大问题会评论指出 + 给你选择（重构 / 关 PR）

## 报 bug / 提需求

- bug → 用 [bug 模板](.github/ISSUE_TEMPLATE/bug_report.md) 开 issue
- 功能 → 用 [需求模板](.github/ISSUE_TEMPLATE/feature_request.md) 开 issue
- 问题不确定属于哪种 → 直接开 issue，标 `question`

模板看着繁琐，但**填得清楚的 issue 我会优先处理**——有清晰的复现步骤是最大的礼物。

## 协议

LynLens 用 [MIT 协议](LICENSE)。提交 PR 即视为同意你的贡献也按 MIT 发布。

---

有什么不清楚的，开个 issue 标 `question` 直接问就行。
