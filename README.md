# LynLens

**口播视频 AI 快剪工具 · AI-First Architecture**

> 一个可以被 AI 操控、也可以被人手动操控的"视频去废引擎"。AI 通过 MCP 协议读取文字稿、做剪辑决策、改字幕、生成高光片段、写社媒文案;人类通过 Electron UI 审核、微调、直接操作。两种模式随时切换,**同一份项目状态,同一套工具**。

## 下载

最新稳定版从 GitHub Releases 拿：**<https://github.com/wilonvives/LynLens/releases/latest>**

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS (Apple Silicon) | `LynLens-<version>-arm64.dmg` | M1 / M2 / M3 / M4 |
| macOS (Intel) | `LynLens-<version>.dmg` | 旧 Mac |
| Windows | `LynLens-Setup-<version>.exe` | x64 安装包 |

> 当前未代码签名。首次启动 Mac 端右键→打开、Windows 端"更多信息→仍要运行"绕过系统警告。代码签名 + 公证已在 `electron-builder.yml` 配好,等运营准备好再启用。

## AI Agent 对接

LynLens 是为 AI agent 设计的。安装应用后,agent（Claude / Codex / OpenClaw 等）可以通过这两条通道操作工程：

1. **进程内 Claude Agent SDK** — 应用内置聊天面板,Claude 直接调 47 个 MCP 工具(列表见下方"工具表")
2. **外部 HTTP MCP server** — 应用启动时自动开 `http://127.0.0.1:<port>/mcp`,Codex / Cursor / 任何支持 MCP 的 IDE 都能连。在 agent 这一端登录(`claude` 或 `codex` CLI)后,LynLens 就能用了

agent 没装 / 没登录时应用本身仍然可用,只是聊天面板会提示"未登录"。

## 仓库结构

```
lynlens/
├─ packages/
│  ├─ core/                           # Core Engine — UI 无关的业务核心
│  │   ├─ src/
│  │   │   ├─ types.ts                # .qcp 工程文件的持久化类型
│  │   │   ├─ event-bus.ts            # 跨层事件总线
│  │   │   ├─ segment-manager.ts      # 删除段增删改 + 重叠合并 + undo/redo 200 步
│  │   │   ├─ project-manager.ts      # 打开/保存 .qcp;聚合根
│  │   │   ├─ ripple.ts               # source ↔ effective 时间换算
│  │   │   ├─ variant-status.ts       # 高光变体失效检测(纯函数)
│  │   │   ├─ ffmpeg.ts               # probe / 波形 / 进度式 ffmpeg
│  │   │   ├─ export-service.ts       # fast(流拷贝)+ precise(重编码)
│  │   │   ├─ transcription.ts        # whisper.cpp 本地 + OpenAI API + 静音/语气词/重拍检测
│  │   │   ├─ diarization.ts          # 说话人识别基础设施
│  │   │   ├─ diarization-sherpa.ts   # sherpa-onnx 真实引擎(可选)
│  │   │   ├─ highlight-prompts.ts    # 高光变体生成 prompt
│  │   │   ├─ highlight-parser.ts     # Claude/Codex 回传 JSON → 变体
│  │   │   ├─ copywriter-platforms.ts # xhs/ig/tt/yt/tw 规则
│  │   │   ├─ copywriter-prompts.ts   # 文案生成 prompt
│  │   │   ├─ copywriter-parser.ts    # 模型回传 → SocialCopy
│  │   │   ├─ subtitle.ts             # 字幕排版(横/竖屏行数)
│  │   │   ├─ safety.ts               # 80% 删除上限 / 50 次调用上限 / 禁覆盖源
│  │   │   └─ engine.ts               # 组合根
│  │   └─ tests/                      # 118 个单元测试
│  │
│  ├─ desktop/                        # Electron 桌面应用(主要入口)
│  │   ├─ src/main/
│  │   │   ├─ index.ts                # 主进程 + 所有 IPC handlers
│  │   │   ├─ preload.ts              # contextBridge 暴露 IpcApi
│  │   │   ├─ agent.ts                # Claude Agent SDK(进程内 MCP 工具)
│  │   │   ├─ agent-codex.ts          # OpenAI Codex SDK(外部 HTTP MCP)
│  │   │   ├─ agent-dispatcher.ts     # 按当前 provider 分发
│  │   │   ├─ mcp-http-server.ts      # 本地 HTTP MCP server(给 Codex)
│  │   │   ├─ diarize-helper.ts       # 共享的说话人识别路由
│  │   │   └─ auto-updater.ts         # electron-updater 集成
│  │   ├─ src/renderer/               # React + Canvas 时间轴
│  │   ├─ src/shared/ipc-types.ts     # IpcApi 类型定义
│  │   ├─ resources/
│  │   │   ├─ ffmpeg/                 # 打包二进制(gitignored,bootstrap 下载)
│  │   │   ├─ whisper/                # 打包二进制(gitignored,bootstrap 下载)
│  │   │   └─ diarization/            # 打包二进制(gitignored,bootstrap 下载)
│  │   └─ electron-builder.yml
│  │
│  ├─ mcp-server/                     # 外部 MCP Server — 给 Claude Desktop / Cursor 直连
│  │   └─ src/tools/index.ts          # stdio MCP(独立进程,不依赖 Electron)
│  │
│  └─ cli/                            # 命令行工具 — probe / info / export
│
├─ scripts/
│  ├─ download-ffmpeg.mjs             # ffmpeg 下载器
│  ├─ download-whisper.mjs            # whisper.cpp 下载器
│  └─ download-diarization.mjs        # sherpa-onnx 下载器
├─ pnpm-workspace.yaml
└─ package.json
```

## 核心能力

| 领域 | 能力 |
|---|---|
| 转录 | whisper.cpp 本地(离线免费)/ OpenAI API / 空回退。支持词级时间戳。 |
| 自动标记 | 停顿 / 语气词 / 重拍 三类信号。全部进 pending 等人或 AI 审核。 |
| 手工编辑 | 时间轴拖选标记、擦除、调边、撤销/重做 200 步。 |
| 字幕 | 内联编辑、± 微调时间、点时间戳跳转、说话人标签、横跨剪切警告、自动滚动跟播。 |
| 剪切 | Ripple cut 把批准段整段压掉,时间轴自动缩短;随时可还原。 |
| 高光变体 | 让 AI 从粗剪后的字幕里挑段组合,同风格多变体;持久化到 .qcp;收藏/删除/逐段微调。 |
| 说话人识别 | sherpa-onnx 本地引擎(可选)+ mock 回退;重命名、合并、最近邻自动补标签。 |
| 文案生成 | 五个平台(小红书/Instagram/TikTok/YouTube/Twitter)并行生成,支持自定义风格说明。 |
| 导出 | 流拷贝(秒级)/ 重编码(画面一致)。成片 + 单独变体。 |

## AI 集成(44 个 MCP 工具)

**两条路径,同样的工具集**:

1. **内嵌 Agent 窗口**(推荐)— 点应用顶部的 `AGENT` 按钮,开独立聊天弹窗
   - 可选 **Claude Code**(`@anthropic-ai/claude-agent-sdk`,进程内 MCP)
   - 可选 **OpenAI Codex**(`@openai/codex-sdk`,通过本地 HTTP MCP)
   - 两边**同一套 44 个工具**,在 header 的下拉里随时切

2. **外部 MCP Server** — `packages/mcp-server` 跑 stdio,给 Claude Desktop / Cursor / 其他 MCP 客户端连

### 工具清单(44 个,按领域)

| 领域 | 工具 |
|---|---|
| **项目** | `get_project_state` · `transcribe` · `save_project` · `set_mode` |
| **删除段** | `add_segments` · `remove_segments` · `erase_range` · `resize_segment` · `set_segment_status` · `approve_all_pending` · `reject_segment` · `reject_all_pending` · `undo` · `redo` · `commit_ripple` · `revert_ripple` · `ai_mark_silence` |
| **字幕** | `update_transcript_segment` · `update_transcript_segment_time` · `suggest_transcript_fix` · `accept_transcript_suggestion` · `clear_transcript_suggestion` · `replace_in_transcript` |
| **说话人** | `diarize` · `rename_speaker` · `merge_speakers` · `set_segment_speaker` · `auto_assign_unlabeled_speakers` · `clear_speakers` |
| **高光** | `generate_highlights` · `get_highlights` · `clear_highlights` · `set_highlight_pinned` · `delete_highlight_variant` · `update_highlight_variant_segment` · `add_highlight_variant_segment` · `delete_highlight_variant_segment` · `reorder_highlight_variant_segment` |
| **文案** | `generate_social_copies` · `get_social_copies` · `update_social_copy` · `delete_social_copy` · `delete_social_copy_set` · `set_social_style_note` |
| **导出** | `export_final_video` · `export_highlight_variant` |

所有工具在 `packages/desktop/src/main/agent.ts`(Claude)和 `packages/desktop/src/main/mcp-http-server.ts`(Codex)都有实现;UI 和 Agent 用的是**同一个 engine 实例**,状态完全同步。

## 环境要求

- Node.js ≥ 20
- pnpm ≥ 10
- **ffmpeg / ffprobe** — `pnpm bootstrap:ffmpeg` 自动下载
- **whisper.cpp + ggml-base 模型** — `pnpm bootstrap:whisper`(~150 MB,本地离线转录)
- **sherpa-onnx 说话人模型**(可选) — `pnpm bootstrap:diarization`(如果要真实说话人识别;不装回退 mock)
- **Agent 要用的话**:
  - Claude 路径:需要本机有 `claude` CLI(Claude Code),登录过
  - Codex 路径:需要 OpenAI Codex CLI,首次运行会弹 ChatGPT 登录

## 安装

```bash
pnpm install
pnpm bootstrap:ffmpeg     # 下 ffmpeg 二进制
pnpm bootstrap:whisper    # 下 whisper.cpp + 模型
pnpm bootstrap:diarization # 可选 — 下 sherpa-onnx
pnpm build                # 构建所有包
pnpm test                 # 118 个单元测试全绿
```

## 开发

```bash
# 跑 Electron 桌面(推荐)
pnpm --filter @lynlens/desktop dev
# 等价于: concurrently -k "vite" "tsc main --watch" "wait-on :5173 && electron"

# 单独跑 core
pnpm dev:core

# 单独跑外部 MCP server(给 Claude Desktop 用的 stdio 版本)
pnpm dev:mcp

# CLI
pnpm dev:cli -- probe foo.mp4
```

## 打包(发版给用户)

```bash
# 1. 确保二进制资源都下好了
pnpm bootstrap:ffmpeg
pnpm bootstrap:whisper
pnpm bootstrap:diarization

# 2. 构建 + 打包
pnpm package:desktop
# → packages/desktop/release/ 产出 .dmg / .exe / .AppImage
```

**打包前的 checklist**:
- [ ] `pnpm test` 全过
- [ ] `pnpm typecheck` 无错
- [ ] 在无 `~/.codex/config.toml` / `~/.claude.json` 的干净机器测试 — 聊天应当提示「未登录」而不是崩
- [ ] 用一个真视频走完:打开 → 转录 → 识别说话人 → 粗剪 → 生成高光 → 编辑 → 生成文案 → 导出成片
- [ ] macOS 打包需要证书 + 公证(见下)

### macOS 公证(发版给公众必须)

```bash
# 在 electron-builder.yml 里配 afterSign + notarize
# 需要 Apple Developer 账号,设置环境变量:
export APPLE_ID=...
export APPLE_ID_PASSWORD=...  # app-specific password
export APPLE_TEAM_ID=...
pnpm package:desktop
```

### Windows 打包限制

`electron-builder` 解包 `winCodeSign` 含 macOS 符号链接,需:
- **Developer Mode** 开启,或
- **管理员权限** 运行终端

本仓库已做 CJS 改造 + `asar: false` 绕过 pnpm workspace 符号链接兼容性问题。

## 注册外部 MCP 到 Claude Desktop

外部 `packages/mcp-server` 是**独立进程**,可以不启动 LynLens 就让 Claude Desktop 操作 `.qcp` 文件。

```bash
pnpm --filter @lynlens/mcp-server build
```

编辑 Claude Desktop 配置:
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lynlens": {
      "command": "node",
      "args": ["/absolute/path/to/lynlens/packages/mcp-server/dist/index.js"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

## AI 预标记的三种信号(基于波形 + 转录)

| 信号 | 条件 | 依赖 |
|---|---|---|
| **静音段** | 波形峰值超过 `minPauseSec`(默认 1.0s)的停顿 | 只需波形 |
| **语气词** | 识别 `嗯 / 呃 / 那个 / 就是 / um / uh` 等,支持重复形「嗯嗯嗯」 | 需转录 |
| **重拍/重复段** | bigram Jaccard 相似度 ≥ 0.8 的连续句对(保留后者) | 需转录 |

所有 AI 标记 `source = 'ai'`;`L2` 模式进 pending、`L3` 模式直接 approved。

## 架构

```
┌─────────────────────────────────────────────────┐
│  用户界面层                                       │
│  ├─ Electron 主窗口(粗剪/高光/文案)             │
│  ├─ 独立 Agent 弹窗(Claude / Codex 可切换)      │
│  └─ Claude Desktop / Cursor(通过外部 MCP)       │
└──────────┬──────────────────────┬───────────────┘
           │ IPC                  │ MCP (stdio + HTTP)
           ▼                      ▼
┌─────────────────────────────────────────────────┐
│  packages/desktop/src/main                       │
│  ├─ index.ts — IPC handlers                     │
│  ├─ agent.ts — Claude 进程内工具(44)            │
│  ├─ mcp-http-server.ts — Codex HTTP 工具(44)    │
│  └─ agent-dispatcher.ts — provider 路由          │
└──────────┬──────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────┐
│  @lynlens/core                                   │
│  • Project · SegmentManager · ExportService      │
│  • TranscriptionService · Diarization            │
│  • Highlight · Copywriter · Safety               │
└─────────────────────────────────────────────────┘
```

**设计原则**:

1. `@lynlens/core` 不依赖 Electron / React — 任何 UI 操作都可以通过 MCP 实现,反之亦然
2. AI 和人类共享同一个 `SegmentManager` — 每段打 source 标(human / ai)+ status(pending / approved / rejected / cut)
3. 删除段编辑 → `Ctrl+Z` 撤销 200 步;高光变体改动自动清 sourceSnapshot;字幕级联编辑保 500ms 最小时长
4. Safety 硬约束在 Core 层强制:禁止 output == source,删除总时长 ≤ 80%,MCP 单会话调用上限 50 次

## 键盘快捷键(UI)

| 快捷键 | 功能 |
|---|---|
| `空格` | 播放 / 暂停 |
| `J` / `K` / `L` | 倒放 / 暂停 / 快放 |
| `← / →` | 后退 / 前进 1s |
| `Shift + ← / →` | 后退 / 前进 5s |
| `,` / `.` | 后退 / 前进 1 帧 |
| `D`(按住) | 刷选删除(松开完成) |
| `Shift+拖拽` | 标记删除段 |
| `Cmd/Ctrl+拖拽` | 擦除时间范围 |
| `Cmd+Shift+拖拽`(蓝框两端) | 拖动调整字幕时间戳 |
| `Delete` | 删除时间轴拖选段 |
| `Shift + A` | 批准所有待审 AI 段 |
| `Ctrl + R` | 触发 AI 预标记 |
| `Ctrl + Z / Y` | 撤销 / 重做 |
| `Ctrl + S` | 保存工程 |
| `Ctrl + E` | 导出 |
| `+` / `-` / `0` | 时间轴缩放 / 适应窗口 |
| `Esc` | 退出预览模式 |

## AI 使用示例

```
你: 帮我剪 ~/Desktop/录像.mp4,转录后去掉停顿和语气词,
    再挑 3 个 30 秒左右的高光片段,最后生成小红书文案。

Agent 会依次调用:
  1. transcribe(projectId)
  2. ai_mark_silence(projectId, minPauseSec=1.0)
  3. approve_all_pending(projectId)
  4. commit_ripple(projectId)           ← 真正剪掉
  5. generate_highlights(projectId, style='default', count=3, targetSeconds=30)
  6. set_highlight_pinned(projectId, variantId, pinned=true)  ← 收藏你喜欢的
  7. generate_social_copies(projectId, sourceType='variant', sourceVariantId=..., platforms=['xiaohongshu'])
  8. export_final_video(projectId, outputPath='~/Desktop/clean.mp4')
```

---

**当前版本**: 0.2.0 · **测试**: 118 unit tests 全过 · **打包目标**: macOS (arm64/x64), Windows (x64)
