# 高能 (High-Energy) Packaging Template

## 风格定位

**适合**:
- 短视频钩子段 (前 3-10 秒"你不敢相信...")
- 情绪反转 / 爆点段 ("没想到的是...")
- 揭露 / 控诉 / 警示类内容
- 节奏快, 信息密度高的科普

**不适合**:
- 长访谈 / 圆桌对话
- 平淡的解释段 (会显得用力过猛)
- 教学 / 课程类 (字太多会干扰理解)
- 情绪低沉 / 治愈系内容

判断: 这段如果在 TikTok / 抖音 / 视频号刷到, 用户会想停下来看? 是 → 用高能.

---

## 关键词挑选规则

**每段挑 2-3 个关键词**. 但不是每段都要挑 — 平铺直叙的解释段、过渡段就**完全不要花字**, 让金句段自己跳出来。

挑选优先级 (按 manifest.subtitle.keywords.categoriesByPriority):

1. **数字** — 最具体, 视觉记忆点最强. "3 个", "10 万人", "第一次", "全网", "100%".
2. **情绪强词** — 让观众生理反应的词. "噩梦", "可怕", "崩溃", "爽", "神", "炸裂", "震惊".
3. **动词高潮** — 带画面的动作词. "爆", "崩", "炸", "杀", "抢", "拽", "砸", "撕".
4. **品牌 / 人名 / 专有名词** — 观众记得的实体. "SLAPP", "苹果", "马斯克", "比亚迪".

**避免**:
- 代词 (我, 你, 这, 那)
- 时间副词 (现在, 已经, 突然) — 除非语义关键
- 程度副词 (很, 非常, 极其) — 没有画面感
- 助词 / 语气词 (了, 吗, 啊, 嘛)

**段内同色不连用**: 同一段如果有 2 个关键词, palette 里轮换不同颜色, 不要全用 #ff3333.

---

## 颜色规则

Palette: `["#ff3333", "#ffd700", "#ff6b00"]`

按词性映射:
- 情绪强词 / 动词高潮 → 红色系 `#ff3333` 优先, 次选 `#ff6b00`
- 数字 / 品牌名 → 金色 `#ffd700`
- 段内第 N 个关键词 (N ≥ 2) → palette 里轮换没用过的色

**禁用**:
- 描边色覆写 — defaults 是 `#000000 4px`, 不要改
- 全段 color 覆盖 — 整体白字是基线, 改了会乱
- 渐变 / 不在 palette 里的色

---

## 字号规则

- 默认字号 = manifest.subtitle.defaults.size (64)
- 关键词字号 = default × manifest.subtitle.keywords.sizeBoost (= 64 × 1.3 ≈ 83)
- **不要主动设 `size`, 让 runtime 按 sizeBoost 自动算** — 否则跨视频分辨率会乱

实测 83px 在 1080×1920 portrait 上是 ~4.3% 帧高, 一段最多 3 个加大词, 不会爆字.

---

## 音效触发 (runtime 可选)

manifest.audio.sfx 定义了 2 个音效:

- **punch** (`on-punchline-segment`): 当一段是钩子 / 金句开头时触发. 你输出 PackagingPlan 的 segment 时, 在 `meta.role` 字段标注 `"punchline"`, runtime 会把 sfx 叠在这一段开头.
- **whoosh** (`on-segment-start`): 段切换时触发, 节奏感. runtime 自动加, 你不需要标记.

如果当前 runtime 不支持音效, 这些字段被忽略, 不报错.

---

## 节奏指导 (v0.6+ runtime 可选)

manifest.camera 允许:
- 钩子段 / 金句段 → 画面 zoom 1.3x (focus 在人脸 — runtime 自动)
- 普通段 → zoom 1.0x

你可以在 PackagingPlan 的 segment 里输出 `camera: { zoom: 1.3, focus: { x: 0.5, y: 0.4 } }`. 老版本 runtime 忽略, v0.6+ 应用.

---

## 例子

### 例 1 — 数字 + 情绪词
**输入**: "今天讲一个**很可怕**的事情, 涉及**3 万**人"
- "可怕" — 情绪强词, 优先级 2 → `#ff3333` (红, sizeBoost ×1.3)
- "3 万" — 数字, 优先级 1 → `#ffd700` (金, sizeBoost ×1.3)

输出:
```json
{
  "segmentIdx": 0,
  "subtitle": {
    "wordEffects": [
      { "wordIdx": 3, "highlight": "#ff3333" },
      { "wordIdx": 7, "highlight": "#ffd700" }
    ]
  }
}
```

### 例 2 — 品牌 + 动词
**输入**: "**苹果****炸了**网络"
- "苹果" — 品牌, 优先级 4 → `#ffd700`
- "炸了" — 动词高潮, 优先级 3 → `#ff3333`

### 例 3 — 平淡过渡, 不挑
**输入**: "刚才说的就是这个意思"
- 全是助词 / 代词, **没有花字**. 不输出此段的 segments 条目, runtime 用默认样式。

### 例 4 — 钩子段
**输入** (段是变体的第一段): "**100% 不**能想到的**真相**"
- "100%" — 数字 → 金
- "不" — 不挑 (副词)
- "真相" — 情绪强词 → 红

```json
{
  "segmentIdx": 0,
  "subtitle": {
    "wordEffects": [
      { "wordIdx": 0, "highlight": "#ffd700" },
      { "wordIdx": 4, "highlight": "#ff3333" }
    ]
  },
  "meta": { "role": "punchline" }    // runtime 会触发 sfx/punch.mp3
}
```

---

## 反例 (不要这么做)

❌ 全段染红:
```json
{ "segmentIdx": 0, "subtitle": { "color": "#ff3333" } }  // 错: 不要全行覆盖
```
应该: 只挑关键词改色, 其他字保持默认白色.

❌ 一段挑 5 个词:
```json
{ "wordEffects": [{...},{...},{...},{...},{...}] }  // 错: 超过 max=3
```
应该: 最多 3 个, 挑最重要的.

❌ 全用一种颜色:
```json
{ "wordEffects": [
  { "wordIdx": 0, "highlight": "#ff3333" },
  { "wordIdx": 3, "highlight": "#ff3333" }  // 错: 段内同色重复
] }
```
应该: palette 里轮换.

❌ 把代词 / 助词加花字:
```json
{ "wordEffects": [{ "wordIdx": 0, "highlight": "#ff3333" }] }
// 输入 "这是一个例子", wordIdx 0 是 "这" — 代词, 不该挑
```
应该: 跳过, 段里没值得挑的就不输出 segments 条目.

---

## 输出格式

按 LynLens PackagingPlan JSON schema. 顶层只关心 `segments` 数组. 每段:

```ts
{
  segmentIdx: number,         // 对应 transcript.segments[i] 的 index
  subtitle?: {
    wordEffects?: Array<{
      wordIdx: number,         // 词 index (空格分词, CJK 整段就是 wordIdx 0)
      highlight?: string,      // hex 颜色
      size?: number            // 可选, 一般不主动设
    }>
  },
  camera?: { zoom?: number, focus?: { x: number, y: number } },
  meta?: { role?: "punchline" | "hook" | "transition" }
}
```

**只列你要改的段**. 其他段不写, runtime 用 defaults.
