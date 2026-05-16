# Implementation Plan: LynLens 持续学习系统

> **状态**：草案，未开始实施。已经过一轮用户决策对齐（见 §7）。
> **写于**：v0.4.7 后
> **目标**：让 LynLens 越用越懂用户、越用越准确。借鉴 `wilon@subtitle-craft` skill
> 的"学习记忆机制设计思想"（不导入数据），把它从字幕扩展到 LynLens 的多个工作流维度。
> **跟 skill 的关系**：只借鉴架构思路（auto-promotion 阈值机制），**不共享数据、不互通**。
> LynLens 的学习记忆从零开始，自己跟用户长出来。

---

## 1. 设计原则

### 1.1 UI + Agent 双驱动等价

**钩子打在 engine 事件总线层**，不在 UI 或 MCP 任意一边。

```
UI 触发 ────→ preload ──→ ipcMain ──→ engine.method() ──┐
                                                          ├──→ eventBus.emit(...)
Agent 触发 ─→ MCP tool ──────────────→ engine.method() ──┘                    ↓
                                                                     LearningService 监听
                                                                             ↓
                                                                  写入 learning-memory.json
```

无论用户用 UI 还是用 chat，学习能力**完全对称**。

### 1.2 不一次铺所有维度

- M1 + M2：转录纠错 + 专有名词 + 保留原文（**先做这组**——直接借鉴 skill 的成熟模型）
- M3 之后：剪辑废话、高光偏好、文案口吻等 LynLens 独有维度

### 1.3 不一上来就自动改

- 用 `count >= 3` 晋升机制（同 skill）
- 前 2 次只记录，第 3 次后才自动应用
- 防误判 + 不烦用户

### 1.4 数据全局存

- `~/.lynlens/learning-memory.json`
- 跨工程持久——用户的口语习惯、品牌词典是跨视频一致的
- 单机软件无多用户冲突

---

## 2. 数据结构

```ts
// packages/core/src/learning-memory-types.ts

export interface LearningMemoryV1 {
  version: 1;

  transcript: {
    /** 已晋升为自动修正的规则：from → to，转录后无声应用 */
    autoCorrections: Record<string, string>;

    /** 用户教过的专有名词：term → category */
    properNouns: Record<string, string>;

    /** 用户要求保留原文不翻译的外语词 */
    keepOriginal: string[];

    /** 修正记录原始日志，count >= 3 时晋升到 autoCorrections */
    correctionLog: Array<{
      from: string;
      to: string;
      count: number;
      firstSeenAt: string;   // ISO date
      lastSeenAt: string;
      /** 哪个工程出现的：projectId 列表，仅记最近 5 个用于调试 */
      seenInProjects: string[];
    }>;
  };

  // ----- 以下是 M3+ 预留 slot，M1+M2 不实现 -----

  /** 用户标 cut 的废话句式 */
  editing?: {
    fillerPatterns: Array<{ text: string; count: number }>;
  };

  /** 用户 pin / 删 highlight variant 的特征学习 */
  highlight?: {
    preferredStyle: string | null;
    preferredTargetSeconds: number | null;
    pinnedFeatures: unknown[];  // 待 M4 设计
  };

  /** 文案口吻偏好（按平台） */
  copywriter?: Record<string, { editsLog: unknown[]; extractedVoice: string | null }>;

  /** 说话人命名：voiceprint hash → 用户给的名字 */
  speakers?: Record<string, string>;
}
```

---

## 3. 新增文件

### 3.1 `packages/core/src/learning-memory.ts`

```ts
export class LearningMemory {
  constructor(private readonly filePath: string) {}

  /** 从磁盘加载；不存在则用空记忆初始化 */
  async load(): Promise<void>

  /** 持久化到磁盘（原子写：先写 .tmp 再 rename） */
  private async save(): Promise<void>

  // ---- 读取 ----

  getAutoCorrections(): Readonly<Record<string, string>>
  getProperNouns(): Readonly<Record<string, string>>
  getKeepOriginal(): readonly string[]
  getCorrectionLog(): ReadonlyArray<...>

  // ---- 写入 ----

  /**
   * 记一条修正。如果同 from→to 已存在，count++。
   * 当 count 达到 PROMOTION_THRESHOLD (默认 3) 时，自动晋升到 autoCorrections。
   * 返回值告知调用方："recorded" | "promoted"。
   */
  async recordCorrection(from: string, to: string, opts: { projectId?: string }): Promise<'recorded' | 'promoted'>

  /** 直接加入 autoCorrections（agent 主动调用，跳过 count 门槛） */
  async addAutoCorrection(from: string, to: string): Promise<void>

  /** 记一个专有名词 */
  async addProperNoun(term: string, category: string): Promise<void>

  /** 标记一个词永远保留原文 */
  async addKeepOriginal(word: string): Promise<void>

  // ---- 管理 ----

  /** 撤销一条 autoCorrection / properNoun / keepOriginal */
  async forget(kind: 'correction' | 'noun' | 'keep', key: string): Promise<boolean>

  /** 全清空（小心，需 UI 二次确认） */
  async reset(): Promise<void>

  // ❌ 删除：importFromSkill —— 决策对齐后明确不做。
  //    LynLens 和 skill 是独立产品，不共享数据。
  //    LynLens 的学习记忆从零起步、由 LynLens 自己的用户行为长出。
}
```

### 3.2 `packages/core/src/learning-service.ts`

```ts
import type { EventBus } from './event-bus';
import type { LearningMemory } from './learning-memory';
import type { ProjectManager } from './project-manager';

/**
 * Connects engine events to LearningMemory writes. Lifecycle = app lifetime,
 * created once at boot, never destroyed.
 *
 * Event handlers are intentionally tiny — translate the engine event into a
 * memory call. No business logic here; LearningMemory owns the rules.
 */
export class LearningService {
  constructor(
    private readonly memory: LearningMemory,
    private readonly eventBus: EventBus,
    /** Used to look up projects for context (which projectId fired the event). */
    private readonly projects: ProjectManager
  ) {}

  start(): void {
    this.eventBus.onAny((event) => this.handle(event));
  }

  private async handle(event: LynLensEvent): Promise<void> {
    switch (event.type) {
      case 'transcript.segment.text-changed':
        // Enrich existing transcript.updated event with oldText/newText.
        if (event.oldText && event.newText && event.oldText !== event.newText) {
          await this.memory.recordCorrection(event.oldText, event.newText, {
            projectId: event.projectId,
          });
        }
        break;

      case 'transcript.find-replace':
        // High-confidence direct mapping — promote immediately (skip threshold).
        await this.memory.addAutoCorrection(event.find, event.replace);
        break;

      // M3+ slots:
      // case 'segment.added':       // user marked a cut — possible filler
      // case 'highlight.pinned':    // user liked a variant
      // case 'social-copy.updated': // user edited copywriter output
    }
  }
}
```

### 3.3 `packages/desktop/src/main/ipc/learning.ts`

```ts
import { ipcMain } from 'electron';
import type { IpcContext } from './_context';

export function registerLearningIpc(ctx: IpcContext): void {
  const { engine } = ctx;

  ipcMain.handle('learning-get-state', async () => {
    return engine.learningMemory.snapshot();  // counts + recent log
  });

  ipcMain.handle(
    'learning-forget',
    async (_ev, kind: 'correction' | 'noun' | 'keep', key: string) => {
      return engine.learningMemory.forget(kind, key);
    }
  );

  ipcMain.handle('learning-reset', async () => {
    await engine.learningMemory.reset();
  });
}
```

### 3.4 `packages/desktop/src/main/agent-tools/learning.ts`

```ts
// MCP tool definitions. Agent can:
//   - read what LynLens currently knows
//   - explicitly record a correction (e.g. user told agent "always change X to Y")
//   - manage memory (forget / import / reset)
//
// Mirrors the IPC handlers + adds an explicit record-correction tool.

export const LEARNING_TOOLS: LynLensToolDef[] = [
  {
    name: 'get_learning_state',
    description: 'Get a summary of what LynLens has learned (correction count, proper nouns, etc).',
    input: { /* no args */ },
    handler: async (_args, ctx) => ctx.engine.learningMemory.snapshot(),
  },
  {
    name: 'record_correction',
    description: 'Record a transcript correction. If the user told you "change X to Y everywhere", call this with from=X, to=Y. The system tracks counts and auto-applies once a correction has been confirmed 3+ times.',
    input: { from: z.string(), to: z.string() },
    handler: async (args, ctx) =>
      ctx.engine.learningMemory.recordCorrection(args.from, args.to, {}),
  },
  {
    name: 'forget_learning',
    description: 'Remove a learned rule. Use when the user says they were wrong about a previous teaching.',
    input: { kind: z.enum(['correction', 'noun', 'keep']), key: z.string() },
    handler: async (args, ctx) => ctx.engine.learningMemory.forget(args.kind, args.key),
  },
];
```

---

## 4. 修改现有文件

### 4.1 `packages/core/src/event-bus.ts` 增强事件类型

```ts
// 现有 transcript.updated 太粗，加一个细粒度版本：
type LynLensEvent =
  | ...
  | {
      type: 'transcript.segment.text-changed';
      projectId: string;
      segmentId: string;
      oldText: string;
      newText: string;
    }
  | {
      type: 'transcript.find-replace';
      projectId: string;
      find: string;
      replace: string;
      replacedCount: number;
    };
```

### 4.2 `packages/core/src/project-manager.ts` 在 mutate 时 emit 新事件

```ts
updateTranscriptSegment(segmentId: string, newText: string): boolean {
  const seg = this.transcript?.segments.find(s => s.id === segmentId);
  if (!seg) return false;
  const oldText = seg.text;
  seg.text = newText;
  this.eventBus.emit({
    type: 'transcript.segment.text-changed',
    projectId: this.id,
    segmentId,
    oldText,
    newText,
  });
  // existing transcript.updated emit stays for back-compat
  this.eventBus.emit({ type: 'transcript.updated', projectId: this.id, segmentId });
  return true;
}

replaceInTranscript(find: string, replace: string): number {
  // ... existing logic
  const count = this.applyReplace(find, replace);
  if (count > 0) {
    this.eventBus.emit({
      type: 'transcript.find-replace',
      projectId: this.id,
      find,
      replace,
      replacedCount: count,
    });
  }
  return count;
}
```

### 4.3 `packages/core/src/transcription.ts` 转录后应用学习

```ts
export interface TranscribeOptions {
  // ... existing fields
  /** Auto-corrections from learning memory. Applied after whisper, before return. */
  autoCorrections?: Readonly<Record<string, string>>;
}

// In WhisperLocalService.transcribe:
const transcript = parseWhisperCppJson(parsed, ...);
let result = transcript;
if (options.cutRanges?.length) {
  result = filterTranscriptByCuts(result, options.cutRanges);
}
if (options.autoCorrections) {
  result = applyAutoCorrections(result, options.autoCorrections);
}
return result;

// New helper:
export function applyAutoCorrections(
  transcript: Transcript,
  corrections: Readonly<Record<string, string>>
): Transcript {
  // For each segment: walk segments + words, replace any from→to match.
  // Word-level replace preserves timing.
  ...
}
```

### 4.4 `packages/desktop/src/main/ipc/transcript.ts` 传入 autoCorrections

```ts
const transcript = await engine.transcription.transcribe(project.videoPath, {
  // ... existing options
  autoCorrections: engine.learningMemory.getAutoCorrections(),
});
```

### 4.5 `packages/core/src/engine.ts` 持有 LearningMemory

```ts
export class LynLensEngine {
  readonly learningMemory: LearningMemory;
  readonly learningService: LearningService;
  // ...
  constructor(opts: { learningMemoryPath?: string; ... }) {
    this.learningMemory = new LearningMemory(
      opts.learningMemoryPath ?? defaultLearningMemoryPath()
    );
    this.learningService = new LearningService(this.learningMemory, this.eventBus, this.projects);
  }

  async boot(): Promise<void> {
    await this.learningMemory.load();
    this.learningService.start();
  }
}

function defaultLearningMemoryPath(): string {
  return path.join(os.homedir(), '.lynlens', 'learning-memory.json');
}
```

### 4.6 `packages/desktop/src/main/index.ts` boot 时调用

```ts
const engine = new LynLensEngine({ ffmpegPaths: ... });
await engine.boot();  // load learning memory + start learning service
```

### 4.7 `packages/desktop/src/main/ipc/index.ts` 注册新 domain

```ts
import { registerLearningIpc } from './learning';

export function registerAllIpc(ctx: IpcContext): void {
  // ... existing
  registerLearningIpc(ctx);
}
```

### 4.8 `packages/desktop/src/main/agent-tools/index.ts` 加新工具

```ts
import { LEARNING_TOOLS } from './learning';

export const ALL_TOOLS = [
  ...existing,
  ...LEARNING_TOOLS,
];
```

---

## 5. UI（M1+M2 范围内 = 轻量）

**最小可见反馈**（不做专门 tab，跟用户决策对齐 §7.4）：

1. **字幕面板顶部一行小字**：
   `🧠 已记忆 12 条修正、3 个专有名词`（count 来自实际记忆库）
   - 点开有 popover 列出最近 5 条修正
   - 每条有"忘掉"按钮

2. **设置菜单**新增一项 `学习记忆 → 查看 / 清空`
   - "查看"：列出所有 autoCorrections / properNouns / keepOriginal，可单条删
   - "清空"：二次确认后清掉全部（一键回到出厂状态）

3. **不做 toast 通知"刚学了一条"**——太烦（§7.2 确认）。
   用户自己在那行小字看 count 上涨。

---

## 6. 实施步骤（按依赖排序）

### Step 1：数据模型 + 基础设施（~1 小时）

- [ ] `packages/core/src/learning-memory-types.ts`
- [ ] `packages/core/src/learning-memory.ts` + 单元测试
- [ ] `packages/core/src/learning-service.ts`
- [ ] `packages/core/src/engine.ts` 持有 LearningMemory + boot()

### Step 2：事件总线扩展（~30 分钟）

- [ ] `packages/core/src/event-bus.ts` 新增事件类型
- [ ] `packages/core/src/project-manager.ts` 在 updateTranscriptSegment / replaceInTranscript emit

### Step 3：转录管线接学习记忆（~30 分钟）

- [ ] `packages/core/src/transcription.ts` 加 applyAutoCorrections
- [ ] `packages/desktop/src/main/ipc/transcript.ts` 传 autoCorrections

### Step 4：IPC + MCP 接口（~40 分钟）

- [ ] `packages/desktop/src/main/ipc/learning.ts`（IPC handlers）
- [ ] `packages/desktop/src/main/preload.ts` 新方法
- [ ] `packages/desktop/src/shared/ipc-types.ts` 类型
- [ ] `packages/desktop/src/main/agent-tools/learning.ts`（MCP 工具）
- [ ] `packages/desktop/src/main/agent-tools/index.ts` 注册

### Step 5：UI 触发（~40 分钟）

- [ ] `packages/desktop/src/renderer/SubtitlePanel.tsx` 顶部小字 + popover
- [ ] `packages/desktop/src/renderer/components/MenuBar.tsx` 加"学习记忆"菜单
- [ ] 简易"查看 / 导入 / 清空" dialog

### Step 6：测试 + 验证（~30 分钟）

- [ ] 单元测试：promotion 逻辑、import、应用 corrections
- [ ] 手动测：
  - 改同一个字幕段 3 次相同方式 → 转录新视频时自动应用
  - 导入 skill memory → 立即看到 count
  - 撤销一条 → 不再自动应用

**M1 + M2 总计：约 3.5-4 小时**（去掉 import skill 那步省了 20 分钟）

---

## 7. 决策对齐（已 ✅ 用户确认）

| # | 决策点 | 选择 | 备注 |
|---|---|---|---|
| 1 | 自动晋升阈值 | **count >= 3** | 跟 skill 对齐 |
| 2 | 学到一条是否 toast 通知 | **不通知** | 太烦 |
| 3 | 跟 skill 的关系 | **完全无关** | LynLens 独立学习记忆，不导入 skill 数据。skill 的 164 条留在 skill |
| 4 | "学习记忆"UI tab | **不做** | 只在字幕面板加一行小字 + 设置项 |
| 5 | 单文件锁 | **不加** | 单进程、无并发风险 |
| 6 | 写盘策略 | **原子写**（.tmp + rename）、**不存历史 .bak** | 防止写一半文件损坏；不存版本历史 |

---

## 8. 风险 & 缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| 学习记忆 JSON 损坏 | LynLens 启动崩 | 加载失败时降级到空记忆 + alert 提示用户 |
| 误学了用户不想学的（比如用户改错了反而被记） | 噪声修正 | 阈值 3 + 提供"忘掉"按钮 |
| 跨设备同步 | 一台学的另一台没 | M1 不管。未来若有需求做 sync |
| schema 演进 | 旧版本 JSON 不能读 | version 字段 + migration 函数 |

---

## 9. M3 及以后的扩展锚点

为了 M1+M2 写代码时不挡 M3+，要预留：

- `LearningMemoryV1.editing`、`.highlight`、`.copywriter`、`.speakers` slot 已在 type 里声明，运行时未填
- `LearningService.handle()` 用 switch 留好其他 event 类型的 case 注释
- `LEARNING_TOOLS` 数组未来可加更多 tool def

---

## 10. 验收标准

M1+M2 完成意味着：

- ✅ 用户用 UI 在字幕面板改字 → 学习记忆 count 上涨
- ✅ Agent 通过 MCP 调 update_transcript_segment → 学习记忆 count 也上涨
- ✅ 同一个 from→to 改 3 次 → 第 4 次转录自动应用
- ✅ 学习记忆持久化到 `~/.lynlens/learning-memory.json`
- ✅ LynLens 重启后记忆保留
- ✅ 写入采用原子写（.tmp + rename），死机不损坏文件
- ✅ 单元测试覆盖 promotion + atomic write 两条主路径
- ✅ 字幕面板有可见反馈（一行小字 + popover）
- ✅ LynLens 跟 skill 完全无关 —— 不读 / 不写 / 不依赖 skill 的任何文件

---

## 11. 下一步（人决定）

- [ ] 用户确认本 plan 的所有方向
- [ ] 用户回答 §7 的待决定细节
- [ ] 开始 Step 1
