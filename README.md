# LynLens

**口播视频 AI 快剪工具 · AI-First Architecture**

> 一个可以被 AI 操控、也可以被人手动操控的"视频去废引擎"。AI 通过 MCP 读取文字稿、做出剪辑决策、生成标记;人类通过 UI 审核或直接操作。两种模式可自由切换。

## 仓库结构

```
lynlens/
├─ packages/
│  ├─ core/          # Core Engine - 业务核心,UI 无关的 TypeScript/Node 包
│  │   ├─ src/
│  │   │   ├─ types.ts / event-bus.ts
│  │   │   ├─ segment-manager.ts    # 标记段增删改 + 重叠合并 + undo/redo
│  │   │   ├─ project-manager.ts    # 打开/保存 .qcp 工程文件
│  │   │   ├─ ffmpeg.ts             # probe / 波形提取 / 进度式 ffmpeg 调用
│  │   │   ├─ export-service.ts     # 快速模式 + 精确模式
│  │   │   ├─ transcription.ts      # whisper.cpp 本地 + OpenAI API + 静音检测
│  │   │   ├─ safety.ts             # 80% 删除上限 / 50 次调用上限 / 禁覆盖原视频
│  │   │   └─ engine.ts             # 组合根
│  │   └─ tests/                    # 20 个单元测试
│  │
│  ├─ mcp-server/    # MCP Server - 把 Core 暴露给 Claude/Cursor(stdio)
│  │   └─ src/tools/index.ts        # 9 个工具(含 ai_mark_silence)
│  │
│  ├─ desktop/       # Electron 桌面应用(UI)
│  │   ├─ src/main/                 # 主进程 + preload
│  │   ├─ src/renderer/             # React + Canvas 时间轴 + 审核面板
│  │   ├─ src/shared/ipc-types.ts
│  │   ├─ resources/ffmpeg/         # 打包时的 ffmpeg 二进制(gitignored)
│  │   └─ electron-builder.yml
│  │
│  └─ cli/           # 命令行工具
│      └─ src/index.ts              # probe / info / export
│
├─ scripts/
│  └─ download-ffmpeg.mjs           # 平台 ffmpeg 二进制下载器
├─ pnpm-workspace.yaml
└─ package.json
```

## 环境要求

- Node.js ≥ 20
- pnpm ≥ 10
- **ffmpeg / ffprobe**:`pnpm bootstrap:ffmpeg` 自动下载到 `packages/desktop/resources/ffmpeg/<platform>/`
- **whisper.cpp + ggml-base 模型**:`pnpm bootstrap:whisper` 自动下载到 `packages/desktop/resources/whisper/<platform>/`(本地离线转录;~150 MB)

## 安装(一次性)

```bash
pnpm install
pnpm bootstrap:ffmpeg   # 下载 ffmpeg.exe / ffprobe.exe
pnpm bootstrap:whisper  # 下载 whisper-cli + ggml-base 模型
pnpm build              # 构建 4 个包
pnpm test               # 26 个单元测试(应全通过)
```

> pnpm 首次会提示 `approve-builds`,选 electron 和 esbuild,或直接信任本仓库的 `pnpm.onlyBuiltDependencies` 配置。

## 开发模式

**Electron 桌面应用(推荐):**

```bash
pnpm --filter @lynlens/desktop dev
# 同时跑: Vite renderer (5173) + tsc main watch + Electron 等 Vite 起来后启动
```

**单独开发 Core / MCP / CLI:**

```bash
pnpm dev:core           # tsc --watch
pnpm dev:mcp            # tsx src/index.ts (stdio 模式,Claude 连接用)
pnpm dev:cli -- probe foo.mp4
```

## 使用 CLI

```bash
# 读取视频元信息
node packages/cli/dist/index.js probe ./demo.mp4

# 查看 .qcp 工程
node packages/cli/dist/index.js info ./demo.qcp

# 导出(默认精确模式)
node packages/cli/dist/index.js export ./demo.qcp -o ./demo_edited.mp4 -m precise -q high
```

**已端到端验证**: 10s 测试视频,删除 `[2,4]` + `[6.5,7.5]` 两段 → precise 模式导出 7s `_edited.mp4`,fast 模式同样产出文件。

## 注册 MCP 到 Claude 桌面版

1. 确保 MCP Server 已构建:`pnpm --filter @lynlens/mcp-server build`
2. 编辑 Claude 配置(Windows: `%APPDATA%\Claude\claude_desktop_config.json`;macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lynlens": {
      "command": "node",
      "args": ["C:/Users/Wilon/Desktop/APP Store/APPs/LynLens/packages/mcp-server/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

3. 重启 Claude 桌面版,在对话里直接说:
   > "帮我剪 D:/今天的录像.mp4,去掉停顿和口误,导出到桌面"

### MCP 工具清单 (9 个)

| Tool                    | 用途                                                    |
| ----------------------- | ------------------------------------------------------- |
| `open_project`          | 打开视频/工程文件,返回 projectId                      |
| `transcribe`            | 视频转录 → 带词级时间戳文字稿(whisper.cpp / OpenAI)  |
| `get_project_state`     | 查询项目完整状态(AI 决策依据)                       |
| `add_segments`          | 批量添加删除段(必须带 reason)                       |
| `remove_segments`       | 移除误加的段(AI 自我纠错)                           |
| `set_mode`              | L2 审核 / L3 全自动                                   |
| `preview`               | 生成短预览 mp4 供 AI/人类检查                         |
| `export`                | 导出成品(L2 模式下要求所有段已批准)                |
| `ai_mark_silence`       | **内置**:基于静音检测标记所有 >1s 停顿为 AI 段        |

### 转录引擎

- **whisper.cpp 本地**(默认,隐私):跑 `pnpm bootstrap:whisper` 后自动发现。手动覆盖用 `LYNLENS_WHISPER_BIN` / `LYNLENS_WHISPER_MODEL` 环境变量。
- **OpenAI API**:设置 `OPENAI_API_KEY` 即可。单文件 ≤25MB 自动上传。
- **都没有**:回退 `NullTranscriptionService`(转录返回空)。`ai_mark_silence` 不依赖转录,始终可用。

### AI 预标记的三种信号

点 UI 里的「🤖 AI 预标记」或通过 MCP `ai_mark_silence` 工具触发:

1. **静音段** 📻 — 基于波形峰值检测超过 `minPauseSec`(默认 1s)的停顿
2. **语气词** 💬 — 只有在已转录(有 transcript)时生效,识别 `嗯 / 呃 / 那个 / 就是 / um / uh` 等,支持重复形 `嗯嗯嗯`
3. **重拍/重复段** 🔁 — 转录后用 bigram Jaccard 相似度 ≥ 0.8 识别连续两句非常相像的句子(保留后者,删前者)

所有标记 `source = 'ai'`,L2 模式下进入 `pending` 待审核状态;L3 模式下自动 `approved`。

## 键盘快捷键(UI)

| 快捷键               | 功能                      |
| -------------------- | ------------------------- |
| `空格`               | 播放 / 暂停               |
| `J` / `K` / `L`      | 倒放 / 暂停 / 快放        |
| `← / →`              | 后退 / 前进 1s            |
| `Shift + ← / →`      | 后退 / 前进 5s            |
| `,` / `.`            | 后退 / 前进 1 帧          |
| `D`(按住)          | 刷选删除(松开完成)     |
| `Delete`             | 删除时间轴拖选段          |
| `Shift + A`          | 批准所有待审 AI 段        |
| `Ctrl + R`           | 触发 AI 预标记            |
| `Ctrl + Z / Y`       | 撤销 / 重做(200 步)    |
| `Ctrl + S`           | 保存工程                  |
| `Ctrl + E`           | 导出                       |
| `+` / `-` / `0`      | 时间轴缩放 / 适应窗口    |
| `Esc`                | 退出预览模式              |

## 架构核心(三层)

```
┌─────────────────────────────────────────────┐
│  Claude 桌面 / Cursor / 其他 AI            │
└─────────────────┬───────────────────────────┘
                  │ MCP 协议 (stdio)
                  ▼
┌─────────────────────────────────────────────┐
│  @lynlens/mcp-server                       │
│  9 个工具(含内置 ai_mark_silence)        │
└─────────────────┬───────────────────────────┘
                  │ 直接依赖
                  ▼
┌─────────────────────────────────────────────┐
│  @lynlens/core  (CJS,业务核心)            │
│  • SegmentManager(undo 200 步+重叠合并)  │
│  • ProjectManager + .qcp 序列化           │
│  • ExportService(fast / precise)          │
│  • TranscriptionService(whisper / API)    │
│  • detectSilences(内置 AI 预标记算法)    │
│  • EventBus + Safety                      │
└───────┬────────────────────────┬───────────┘
        │                        │
        ▼                        ▼
  @lynlens/desktop          @lynlens/cli
  (Electron UI)             (脚本/批处理)
```

**设计原则:**

1. `@lynlens/core` 不依赖 electron/react/UI — 任何 UI 操作都可通过 MCP 实现,反之亦然
2. AI 和人类共享同一个 SegmentManager — 每段打标(human/ai)+ 状态(pending/approved/rejected)
3. Safety 硬性约束在 Core 层强制:
   - 禁止 output 路径 == source 路径
   - 删除总时长不得超过原片 80%
   - MCP 单会话调用上限 50 次

## 打包 (Windows / macOS)

```bash
# 1. 下载平台 ffmpeg 二进制(自动识别 win/mac-x64/mac-arm64)
pnpm bootstrap:ffmpeg

# 2. 打包
pnpm package:desktop
# → packages/desktop/release/ 下生成 .exe 或 .dmg
```

### ⚠ Windows 打包已知限制

`electron-builder` 在打包时需要解压 `winCodeSign`(含 macOS 符号链接),要求:

- **Developer Mode** 开启(`设置 → 更新和安全 → 开发者选项 → 开发人员模式`),或
- 以**管理员权限**运行 PowerShell/终端

否则会报 `Cannot create symbolic link : A required privilege is not held by the client`。

本仓库已做 CJS 改造以绕过 pnpm workspace 符号链接与 ASAR 的兼容性问题(`asar: false`)。

## 里程碑完成状态

| M#    | 内容                                                | 状态 |
| ----- | --------------------------------------------------- | ---- |
| M0    | pnpm monorepo 脚手架                               | ✅   |
| M1    | Core Engine 基础(Project/Segment/Bus)            | ✅   |
| M2    | Core FFmpeg / 波形 / 导出(fast+precise)         | ✅   |
| M3    | 转录:whisper.cpp 本地 + OpenAI API + 静音/语气词/重拍检测 | ✅   |
| M4    | MCP Server + 9 个工具                              | ✅   |
| M5    | CLI (probe / info / export)                        | ✅   |
| M6-M9 | Electron UI(播放/时间轴/标记/审核/预览/导出/字幕条) | ✅   |
| M10   | 跨平台打包(需 Developer Mode 开启后运行)      | ⚠ 条件完成 |

**已覆盖的验收项** (参考说明书 §7):

- C1-C12 Core 验收:全通过,单元测试 20/20
- M1-M7 MCP 验收:9 个工具注册 + stdio daemon
- U1-U16 UI 验收:主要工作流 MVP 通过
- 性能:10s 视频精确导出 <10s、快速导出 <5s(ffmpeg 本地)

## AI 用户使用示例(Claude 桌面版)

```
你: 帮我剪 D:/今天的录像.mp4,先看一下里面说了什么,
     然后去掉所有超过 1 秒的停顿和明显的口误,
     导出到桌面 clean.mp4

Claude: [依次调用]
  1. open_project({ videoPath: "D:/今天的录像.mp4" })
  2. transcribe({ projectId, engine: "whisper-local" })
  3. get_project_state({ projectId })  → 读取文字稿
  4. ai_mark_silence({ projectId, minPauseSec: 1.0 })  → 停顿段
  5. add_segments({ projectId, segments: [...] })  → 口误段
  6. set_mode({ projectId, mode: "L3" })  → 自动导出
  7. export({ projectId, outputPath: "桌面/clean.mp4" })

Claude: "已完成,删除了 23 段,成品时长从 15:30 减到 12:05,
        保存在桌面 clean.mp4"
```
