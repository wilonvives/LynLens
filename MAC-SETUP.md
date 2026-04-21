# LynLens — Mac 开发环境指南

> **给 AI 助手的说明**: 这份文档写给 Mac 用户(或他们的 AI 助手,比如 Claude Code / Cursor)。
> 目标是在 macOS 上完整跑起 LynLens,包括字幕转录。
> 按章节顺序执行即可。所有命令都在 **Terminal** (终端) 运行。

## 这个软件是什么

LynLens 是一个口播视频剪辑工具:

- **手动剪辑**: 时间轴、标记删除段、预览成品、导出(快速 / 精确两种模式)
- **AI 快速标记**: 自动检测停顿、语气词、重复段,批量标记为待删除
- **字幕转录**: 本地 whisper.cpp 转录视频为带时间戳的文字稿
- **字幕审校**: 可编辑字幕、AI 给修改建议、一键接受/忽略
- **内置 Claude 聊天**: 右侧嵌入 Claude 助手,自然语言驱动所有功能
- **导出**: 精确到帧的剪辑,保留视频方向等元数据

架构: Electron + React + TypeScript 的 monorepo(pnpm workspace),4 个包:

- `@lynlens/core` — 业务逻辑(TypeScript / Node.js,无 UI 依赖)
- `@lynlens/desktop` — Electron 桌面应用 (主进程 + 渲染进程 React UI)
- `@lynlens/mcp-server` — MCP Server (供外部 AI 如 Claude Code CLI 调用)
- `@lynlens/cli` — 命令行工具 (probe / info / export)

---

## 1. 系统要求

- macOS 12 (Monterey) 或更新
- ~3 GB 磁盘空间 (Electron + node_modules + whisper 模型)
- **Apple Silicon (M1/M2/M3/M4) 推荐**,Intel Mac 也支持

---

## 2. 安装开发工具

全部都是一次性安装。

### 2.1 Xcode Command Line Tools (必需)

这是编译 whisper.cpp 的前提。Terminal 里跑:

```bash
xcode-select --install
```

弹窗点 "Install",等 5-15 分钟。完成后验证:

```bash
clang --version
# 应该看到: Apple clang version 15.x ...
```

### 2.2 Node.js 20+ (必需)

推荐用 **Homebrew** 装:

```bash
# 先装 Homebrew (如果还没有)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 装 Node.js
brew install node
```

或者从 https://nodejs.org 下 LTS 版本的 .pkg 安装。验证:

```bash
node --version   # 应该 v20.x 或更新
npm --version
```

### 2.3 pnpm (必需)

```bash
npm install -g pnpm
```

验证:

```bash
pnpm --version   # 应该 10.x 或更新
```

### 2.4 Git (可选但推荐)

```bash
brew install git
```

### 2.5 Claude Code CLI (可选,为了用 💬 Claude 聊天功能)

```bash
npm install -g @anthropic-ai/claude-code
claude   # 第一次运行会引导登录
```

---

## 3. 拿到源码

### 方式 A: 如果你拿到的是 `LynLens-source.zip`

```bash
# 解压到你想放的地方,比如 ~/Projects/LynLens
mkdir -p ~/Projects
cd ~/Projects
unzip ~/Downloads/LynLens-source.zip -d LynLens
cd LynLens
```

### 方式 B: 如果从 Git 仓库

```bash
git clone <repo-url> ~/Projects/LynLens
cd ~/Projects/LynLens
```

---

## 4. 装依赖

```bash
pnpm install
```

第一次会下载 Electron (~100 MB) 和其他依赖,大约 1-3 分钟。

如果 pnpm 提示 "Ignored build scripts",这是正常的。我们在仓库里已经白名单了需要的 (electron / esbuild)。

---

## 5. 下载 FFmpeg 二进制 (必需)

用于视频切片 / 导出 / 波形提取。

```bash
# 自动检测你的芯片,下载对应版本
pnpm bootstrap:ffmpeg
```

这会下载 ~80 MB 到 `packages/desktop/resources/ffmpeg/mac-arm64/` (或 `mac-x64/`)。

---

## 6. 构建 whisper.cpp (推荐,才能用字幕转录)

whisper.cpp 官方不提供 Mac 预编译,所以需要你自己 build。**在 Mac 上这只需要几分钟,完全自动。**

### 6.1 克隆 whisper.cpp

```bash
# 任选目录,比如临时放到 ~/build
mkdir -p ~/build
cd ~/build
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
```

### 6.2 编译 (Apple Silicon 会启用 Metal 加速)

```bash
# CMake 构建(最新版官方推荐这条)
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
```

大约 1-2 分钟。完成后 `build/bin/whisper-cli` 就是我们要的二进制。

### 6.3 复制到 LynLens 的资源目录

回到 LynLens 项目根:

```bash
# 替换下面的 /PATH/TO/LynLens 为你实际的路径
cd /PATH/TO/LynLens

# Apple Silicon:
mkdir -p packages/desktop/resources/whisper/mac-arm64
cp ~/build/whisper.cpp/build/bin/whisper-cli packages/desktop/resources/whisper/mac-arm64/
chmod +x packages/desktop/resources/whisper/mac-arm64/whisper-cli

# Intel Mac:
# mkdir -p packages/desktop/resources/whisper/mac-x64
# cp ~/build/whisper.cpp/build/bin/whisper-cli packages/desktop/resources/whisper/mac-x64/
# chmod +x packages/desktop/resources/whisper/mac-x64/whisper-cli
```

### 6.4 下载模型

```bash
# 这会下 ggml-base.bin (约 142 MB) 到正确目录
pnpm bootstrap:whisper
```

> 如果 `bootstrap:whisper` 脚本试图重新下载 binary (mac 没有官方 prebuilt 它会报 warning),忽略即可 —— 我们刚手动放过了。

### 6.5 验证 whisper 可运行

```bash
# Apple Silicon:
./packages/desktop/resources/whisper/mac-arm64/whisper-cli --help
```

看到 `usage: ... whisper-cli [options] file0 ...` 就对了。

---

## 7. 构建 TypeScript

```bash
pnpm build
```

构建 4 个包。通常 10-20 秒。

---

## 8. 运行

```bash
pnpm --filter @lynlens/desktop dev
```

会同时启动:
- Vite 开发服务器 (渲染进程 React)
- tsc --watch (主进程 TypeScript)
- Electron 窗口(等前两个 ready)

几秒后会看到 **LynLens 窗口弹出**,标题"LynLens"。

### 停止

终端按 **Ctrl+C** 两次。

---

## 9. 测试你的设置工作正常

在 LynLens 窗口里:

1. **拖一个 mp4 / mov 视频进去** → 应该立刻显示首帧 + 加载波形
2. **按空格键** → 视频播放
3. **按住 D 键** → 播放经过的地方被标成红色删除段 (松开结束标记)
4. 点顶部 **⚡ 快速标记** → 弹出滑块对话框 → 选阈值 → 开始 → 应该看到紫色的 AI 标记段出现
5. 点顶部 **🎤 生成字幕** → 弹出方向选择 → 确认 → 转录开始 (95 秒视频大约 10-30 秒出结果)
6. 切到右侧栏 **字幕稿** Tab → 应该看到所有段落,可以编辑
7. 点右上 **💬 Claude** → 右侧滑出聊天面板 (需要 Claude Code 已登录)
8. **Ctrl+E 导出** → 选精确模式 → 几十秒后看到成品

---

## 10. 快捷键全表

| 快捷键               | 功能                      |
| -------------------- | ------------------------- |
| `Space`              | 播放 / 暂停               |
| `J` / `K` / `L`      | 倒放 / 暂停 / 快放        |
| `← / →`              | 后退 / 前进 1s            |
| `Shift + ← / →`      | 后退 / 前进 5s            |
| `D`(按住)            | 刷选删除                  |
| `Shift + 拖动时间轴` | 选中标记段                |
| `Ctrl + 拖动时间轴`  | 擦除选中范围的标记        |
| `Ctrl + 滚轮`        | 时间轴缩放                |
| `Alt + 滚轮`         | 时间轴左右平移            |
| `Cmd + Z / Shift+Z`  | 撤销 / 重做               |
| `Cmd + S`            | 保存工程 (.qcp)           |
| `Cmd + E`            | 导出视频                  |
| `0`                  | 时间轴适应窗口            |
| `Esc`                | 退出预览 / 关闭对话框     |

---

## 11. 代码结构速查

想改什么在哪改:

| 想改什么 | 文件 |
|---|---|
| UI 外观 / 主题 | `packages/desktop/src/renderer/styles.css` |
| 按钮布局 / 菜单 | `packages/desktop/src/renderer/App.tsx` |
| 时间轴交互 | `packages/desktop/src/renderer/Timeline.tsx` |
| 字幕审校面板 | `packages/desktop/src/renderer/SubtitlePanel.tsx` |
| Claude 聊天面板 | `packages/desktop/src/renderer/ChatPanel.tsx` |
| Claude 能用哪些工具 / 系统提示词 | `packages/desktop/src/main/agent.ts` |
| 剪辑核心逻辑 (段管理、撤销重做) | `packages/core/src/segment-manager.ts` |
| 导出 (ffmpeg 调用) | `packages/core/src/export-service.ts` |
| 字幕分行规则 | `packages/core/src/subtitle.ts` |
| 静音 / 语气词 / 重复检测 | `packages/core/src/transcription.ts` |
| IPC 契约 | `packages/desktop/src/shared/ipc-types.ts` |

---

## 12. 常见问题

### Q: `pnpm install` 报错 "Cannot find module..."

清一下缓存:
```bash
pnpm store prune
rm -rf node_modules packages/*/node_modules
pnpm install
```

### Q: Electron 启动时卡住 / 白屏

确保 `pnpm build` 跑过。如果 vite 热更没生效,手动刷:Cmd+R 或 Cmd+Shift+R。

### Q: 转录按钮灰着没反应

检查 `packages/desktop/resources/whisper/mac-arm64/whisper-cli` 存在且可执行:
```bash
ls -la packages/desktop/resources/whisper/mac-arm64/
# 应该看到 whisper-cli 有 x 权限
```

如果缺,重新做 §6。

### Q: 打开视频后画面是黑的但能听到声音

iPhone MOV 通常是 HEVC (H.265),Electron 的 Chromium 默认不能软解。两个方案:
- 装 macOS 的 HEVC Video Extension (系统商店免费)
- 或者用 ffmpeg 转码为 H.264: `ffmpeg -i input.mov -c:v libx264 -crf 18 output.mp4`

### Q: 💬 Claude 说 "未检测到 Claude Code 登录状态"

去终端跑 `claude`,按提示登录一次,然后退出 LynLens 重开。

### Q: 想改内容后打包给别人用

```bash
# Apple Silicon 自己用:
pnpm package:desktop
```

产出 `release/` 下的 .dmg 或 .app。第一次需要 electron-builder 下载工具链。

---

## 13. 给 AI 助手的提示

如果你是 Claude Code / Cursor / 其他 AI 助手,帮用户跑起来:

1. 依次确认: `clang --version`, `node --version`, `pnpm --version`, `git --version` 各自有输出。缺的按 §2 装
2. 进入项目根目录后依次跑 `pnpm install` → `pnpm bootstrap:ffmpeg` → §6 (编译 whisper.cpp) → `pnpm build` → `pnpm --filter @lynlens/desktop dev`
3. 卡在哪一步就把报错贴回来,大多数问题在 §12 已列过
4. 用户要改功能时参考 §11 的"代码结构速查"定位文件
5. 改完代码,`pnpm dev` 模式下会热更新,不需要重启 Electron (除非改了 main 进程 或 preload)
6. 修改 main 进程 / preload 代码 (即 `packages/desktop/src/main/` 下) 需要重启: Ctrl+C 然后重新 `pnpm --filter @lynlens/desktop dev`
7. 改 core 包的代码,如果只改 source 不改公开 API,运行中的 tsc --watch 会自动重编,desktop 也会热更新
