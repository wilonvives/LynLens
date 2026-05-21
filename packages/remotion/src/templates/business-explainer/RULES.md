# 「商务讲解」模板 · 使用与套用规则

> 模板的使用与套用规则。接手前先读完本文，再动手写 spec 或改样式。
>
> 视觉身份：思源宋体（Source Han Serif SC）+ 白字描边/投影 + 黄色（#FFD60A / 渐变 #FFF2C0→白）强调。权威、严肃、编辑感。竖屏 1080×1920 口播视频的字幕包装。

---

## 0. 设计哲学：内容 spec 与模板分离

- **内容 spec**（每条视频一份，一个 `BusinessExplainerSpec` 对象）：`cues`（字幕：何时出现 / 套哪个样式 / 强调哪个词）+ `effects`（镜头特效线）+ `sounds`（音效线）。**这是 AI 要产出的东西。**
- **模板**（本文件夹）：样式 / 特效 / 音效长什么样、怎么动。换视频只改 spec。

AI 的工作 = **按本文规则，给一条视频写出 spec**（选样式 / 重点词 / 拆节 + 排特效 + 排音效），不碰模板代码。

---

## 1. 工作流（消费者：从一条视频到成片）

1. **安装**：把模板 `assets/` 复制到 `public/business-explainer/`（见 [README.md](README.md)）。
2. 视频放进 `public/`，用 `@remotion/media-parser` 的 `parseMedia` 确认**时长 / fps / 尺寸**。
3. 写一份 spec（`BusinessExplainerSpec`）：
   - `cues`：从带时间戳的口播稿（`[mm:ss.cc] 文本`，**从视频 0:00 起算**）逐句定 `style` / `highlight` / `segments`（规则见第 4 节）。
   - `effects`：按第 9 节排镜头特效线。
   - `sounds`：按第 10 节排音效线。
4. 在你的 `Root.tsx` 注册 `Composition`，`component` 用 `<BusinessExplainer videoSrc={staticFile('你的视频')} spec={spec} />`，`durationInFrames = 视频秒数 × fps`。
5. `npx tsc --noEmit` 检查 → `npx remotion render <id> out/x.mp4` 出片；调样式用 `npx remotion still <id> out/x.png --frame=N` 看单帧。

---

## 2. 数据契约（spec 格式）

`spec.ts`：
```ts
interface Cue {
  start: number;        // 出现时间（秒）
  text: string;         // 整句原文
  style: string;        // plain / strong / strongWord / sentence / cross
  highlight?: string[]; // 词级强调的词（strongWord 用；词必须原样出现在 text 里）
  segments?: string[];  // 分节（sentence / cross 用）
}
interface BusinessExplainerSpec {
  cues: Cue[];
  effects?: EffectSpec[]; // 见第 9 节
  sounds?: SoundCue[];    // 见第 10 节
}
```

- `segments` 顺序 = **读序**，不是空间顺序：`sentence` = `[中, 上, 下]`（先中再上再下）；`cross` = `[竖, 横]`（先竖后横，竖节限中文）。

> `cues` 是纯数据，可手写，也可写个小脚本从带时间戳的 `.md` 解析（逐行选 plain/strong/strongWord/sentence/cross）。

---

## 3. 字幕样式清单（5 个正式样式）

| id | 名称 | 外观 | 动画 | 位置 | 适用 |
|---|---|---|---|---|---|
| `plain` | 普通 | 白字·宋 Regular·64px·细黑边(4px)·黑投影·无 box | 淡入上移 | 中心距底部 **25%** | 铺垫/连接句；**英文马来文长句**（自然换行） |
| `strong` | 加强普通 | 大粗白字·Heavy·96px·每字右 20% 渐隐·中文字距收紧(英文正常)·无描边 | 淡入；超界**阶梯换行**(左上→右下，错峰；**按词边界切，不拆词/字母**) | 中心 **35%** | 主体叙述、稍重要的句子 |
| `strongWord` | 加强普通+词级 | 同 strong；重点词 120px **黄→白渐变(左80黄/右20白)·逐字**·无描边·高blur阴影·凸出叠在白字上 | 同 strong + 词弹现 | 中心 35% | 句中有关键术语 |
| `sentence` | 重点句(三行Hero) | 3 节；中 150 白无描边，上下 130 黄渐变；上下按中间行宽×0.4 自然横移；竖向收拢、中间压顶凸出 | **中→上→下**；中大→缩定弹现，上下隐现；整体隐出 | 中心 **35%** | 金句/结论/强转折 |
| `cross` | 十字交叉句 | 2 节；竖 150 白(中文竖排) + 横 130 黄渐变(从中间断成两半夹竖字)；竖字恒居中、横字配合、可覆盖 | **竖→横**；竖弹现、横隐现；整体隐出 | 竖字**底边**锚定 **15%** | 2 节对仗/冲击句 |

---

## 4. 套用规则（语义角色 → 样式）

把每句话归到一个"角色"，再选样式：

- **铺垫 / 过渡 / 次要信息 / 英文马来文长句** → `plain`
- **普通叙述（主体）** → `strong`
- **句中有关键术语 / 数字 / 主题词 / 情绪词** → `strongWord`（并指明重点词）
- **金句 / 结论 / 强烈转折 / 升华** → `sentence`（拆 3 节）
- **2 节对仗、冲击力强的短句** → `cross`（一竖一横；竖排限中文）

### 密度与节奏（硬约束）
- `plain` **≤ 20%**（这是"highlight 适配"，要大胆表现；普通字越少越炸）。
- **开场第一句不用 `plain`**——开头通常要处理（装饰）才立得住，给 `strong` 或更强（hero/strongWord）。
- **Hero（sentence + cross）每 15–20 秒最多 1 个**，均匀分布全片，**不要连用**。
- 同一样式不要连续太多句堆叠；用 `strongWord` 的黄字和 Hero 打断节奏。
- 整体目标：plain 少量、strong 主体、strongWord 点亮、Hero 做高潮峰值。

### 重点词怎么选（strongWord 的 `words`）
- 选**名词/术语**（钱骡、苦主、黑名单）、**数字/金额**（几千块）、**情绪/后果词**（终身、无辜、恐怖）、**主题词**（诈骗、政策、权限）。
- 一句一般 1 个、最多 2 个，别全句变黄。
- 词必须**原样出现在 text 里**（区分大小写/简繁），否则不命中、不高亮。

### 重点句怎么拆节（sentence / cross 的 `segments`）
- **不拆断词**：按语义切，别把一个词劈两半。
- **sentence**：3 节，中节是焦点（先出现、最大、白色）；尽量让中节是句子里最有力的部分。读序 中→上→下要能拼回原句。
- **cross**：2 节；竖节(第1节)居中先现、限中文；横节(第2节)会被自动从中间对半切开夹住竖字。
- 节要短：sentence 每节 1–3 字较佳；cross 竖节 1–3 字、横节 2–5 字（太长会超宽）。

---

## 5. 内容处理硬规则（务必遵守）

1. **竖排只用中文**。`cross` 的竖节、任何竖排都不要放英文/马来文/罗马字（会被强制立起来，很难看）。
2. **超长纯英文/马来文句**仍建议 `plain`（CSS 自然换行最稳）。注：strong 的阶梯换行已用 `Intl.Segmenter` **按词边界切，中英文词都不拆断**；但若**单个词本身就超过一行宽**，仍会被迫拆——这种超长词用 plain。
3. 中英混排在 strong/strongWord 里没问题（已处理：中文收紧字距、英文正常、空格保留）。

---

## 6. 实现约束（改样式或新增「两行/逐字」逻辑前必看）

1. **黄字渐变填充与描边/阴影必须分两层**：`-webkit-text-stroke` + `-webkit-background-clip:text`（透明填充）放同一元素会冲突，阴影从透明字里透出来发黑。背层画描边/阴影，前层用渐变做不透明填充盖在内部（见 `gradientText.tsx` 的 `GradientFillText`）。
2. **逐字渲染要保留空格宽度**：每个字 `display:inline-block` 时，单独成块的空格会被折叠成 0 宽，英文单词粘连。给每个字 span 加 `whiteSpace:'pre'`（见 `StrongSubtitle.tsx` 的 `FadeChar`）。
3. **字距收紧只对 CJK**：用全局 `letterSpacing` 会压扁英文和空格。只对 CJK 字符加 `marginRight`（`isCJK()` 判断），英文保持正常。
4. **任何「两行」切分必须按词边界，且保护专有词**：
   - 用 `Intl.Segmenter('zh',{granularity:'word'})` 求词边界，只在词边界切，放不下才退回任意位置（`splitIntoTwoLines`）。
   - `Intl.Segmenter` 认不出新词/专有词（如「钱骡」会被当成「钱|骡」拆开），故另维护 `StrongSubtitle.tsx` 的 `PROTECTED_TERMS` 不可拆词表，强制不在其内部切。**新主题的专有词要加进这张表。**
5. **cross 竖字恒居中**：左右用**等宽弹性槽 `flex:1 1 0`**，不要 `justifyContent:center`（两半字数不同会把竖字推偏）。
6. **cross 以竖字底边为基准**：`bottom: VERT_BOTTOM_FROM_BOTTOM`、不要 `translateY` 居中，使不同字数的竖字底边对齐同一条线。
7. **measureText 依赖字体已加载**：`BusinessExplainer` 用 `delayRender` 等字体加载完成，分节/换行的宽度才准。
8. **Remotion defaultProps 不能传函数/组件**：在 `Composition` 用 `component={() => <BusinessExplainer .../>}` 闭包绑定 videoSrc/spec；spec 是纯数据，可安全传。

---

## 7. 调参索引（要微调去哪改）

- **全局视觉 token**：`theme.ts`（字体、颜色 normal/highlight、字号 normal=64/emphasis=84、普通字位置 0.25、描边 4px、各种阴影）。
- **strong / strongWord**：`StrongSubtitle.tsx` 顶部常量——`SIZE=96`、`WEIGHT=900`、`LETTER_SPACING=-0.05em`(仅中文)、`CENTER_FROM_BOTTOM=0.35`、`MAX_WIDTH_RATIO=0.86`、`STAGGER_FRAMES=7`、重点词 `HOT_SIZE=120`、`HOT_SHADOW`。
- **黄字渐变**：`gradientText.tsx`——`HOT_YELLOW=#FFF2C0`、`YELLOW_TO_WHITE`(左80黄→右白)。strongWord 与 sentence/cross 的黄字共用，改这里全部统一。
- **sentence**：`SentenceSubtitle.tsx`——`CENTER_FROM_BOTTOM=0.35`、`MIDDLE_SIZE=150`、`SIDE_SIZE=130`、`OFFSET_RATIO=0.4`(上下横移)、`LINE_OVERLAP=32`(竖向收拢/压顶)、`*_DELAY`(出现节奏)、`EXIT_FRAMES=8`。
- **cross**：`CrossSentenceSubtitle.tsx`——`VERT_BOTTOM_FROM_BOTTOM=0.15`、`VERT_SIZE=150`、`HORIZ_SIZE=130`、`OVERLAP=36`(横字被覆盖量)、`*_DELAY`、`EXIT_FRAMES=8`。
- **出现节奏**：`reveal.ts`（`useReveal`：淡入 + 可选 punch 大→缩定）。
- **样式注册**：`subtitles/index.ts`（`SUBTITLE_STYLES`：id→组件）。新增样式 = 写组件 + 注册一行。

---

## 8. 新增一个字幕样式的步骤

1. 在 `subtitles/` 写组件，props 用 `SubtitleStyleProps`（`text` / `highlight` / `segments` / `durationInFrames`）。
2. 复用共享件：`SubtitleBox`(单行容器)、`subtitleTextStyle`(白字描边投影)、`GradientFillText`(黄字渐变)、`useReveal`(节奏)。
3. 在 `subtitles/index.ts` 注册一行 `key: 组件`。
4. 在 `build-captions.mjs` 加对应标记类型 + 在生成分支里 push 这个 style。
5. 更新本文件第 3、4 节。

---

## 9. 镜头特效（effects）

特效作用在**背景视频层**（在字幕下方，不影响字幕清晰度），与字幕解耦。代码在 `effects/`：
- `CameraLayer.tsx`：包视频 + 按当前帧算出相机状态（缩放/位移/压暗/底盘/调色）并渲染。
- `EffectSpec = {type, start(秒), end(秒), origin?, tail?}`。`tail`：`release`=结束时收回（推回/淡出）；`hold`=保持特效状态不收回（用于结尾戛然而止，或与下一个特效串接）。
- 脸部原点默认 `50% 28%`，可按 cue 传 `origin` 覆盖。

### 已定稿特效

| id | 名称 | 效果 | 用途 | 重复率 | 窗口长度 |
|---|---|---|---|---|---|
| `impactPunch` | 冲击推近 | 3 帧极快 snap 推近到 **1.35×**(过冲) + 落定抖动(7帧) + 辅助压暗，朝脸部 | **很重要 / 很震撼**的点 | **高**（很常见；一条片约 **4 处**为宜，多配 Hero 句） | = 该重点句时长 |
| `vignetteFocus` | 黑边压暗聚焦 | 3 帧黑色边框内阴影向内压，凸显主体 | **注意 / 听我讲 / 恐惧 / 开头留人** | **中**（一般开头，内容需要可再用） | 看情况；开头约 3s 到话术讲完 |
| `bottomScrim` | 底部阴影底盘 | 3 帧黑色阴影从底升起、覆盖 **50%**，承托文字 | **大量 / 长段重点信息**衬托 | **高**（很常见，较长段落讲重点常用） | = 重点信息段时长（长） |
| `coolGrade` | 去色冷调 | 去饱和 + 压亮 + 叠冷蓝，画面转冷 | 仅**视觉惊悚瞬间**（进监牢、被警察抓这类画面感强的恐怖） | **极低**（多数集都不用；要用也要**短**） | 短（数秒内） |

> 重复率指允许出现的频次：高=可多次、中=适度复用、低=慎用甚至整场不用。

### 触发规则（建议与字幕联动）
- `impactPunch` 配 `sentence` / `cross` Hero 句，或单个最炸的重点。
- `vignetteFocus` 用在开头留人、或转入严肃/恐惧内容时。
- `bottomScrim` 配连续多句 `strong` / `strongWord` 的信息密集段。
- `coolGrade` **极少用，且要短**：只配**视觉惊悚瞬间**（进监牢、被警察抓这种画面感）。**沉重/后果类**内容（人生被毁、无法生存、找工作碰壁）**不算**——照常用 strong/strongWord/scrim。**大多数集一次都不用**；长时间去色画面会很奇怪。
- **节制但可重复**：按上表「重复率」放心复用——impactPunch / bottomScrim 可多用，vignetteFocus 适度，coolGrade 低频。不是"每种只用一次"。
- **窗口不重叠**：`CameraLayer` 同一帧只取第一个命中的特效（先到先得），所以特效窗口要排成不重叠的时间线；想衔接就首尾相接。
- **结尾特效不收回**：若特效窗口一直到**视频末尾**，用 `tail: 'hold'`——保持特效状态、戛然而止，不要 release（不推回 / 不淡出）。`release` 只用在片中、后面还有内容的特效。
- **结尾特效别太短**：尽量覆盖**完整的收尾句**——从引出句连到最后一句（如「你根本不可能…→继续生存」），不要只压在最后两三个字上。
- **太短的句子（<~0.7s）不要用 `sentence`/`cross`**：这两种要逐步展开（中→上→下 / 竖→横，约 0.4s+），太短显不完。常见于**最后一句**只有零点几秒——给它 `strong`，emphasis 靠结尾特效覆盖整段来收。
- **结尾音效跟上特效**：改了结尾特效的起点/长度，对应的**结尾音效也要对齐到特效起点**一起命中，别还停在最后一句。改特效记得顺手改音效。

### 接入方式
- 写进 spec 的 `effects: EffectSpec[]`，`BusinessExplainer` 经 `CameraLayer` 统一应用（和字幕、音效同一份 spec）。

### 新增一个特效的步骤
1. 在 `effects/` 写一个 `EffectFn`（输入局部帧 f / 窗口帧数 len / tail，返回 `CameraState`）。
2. 需要新视觉维度时，给 `CameraState` 加字段（如 `desaturate?`）并在 `CameraLayer` 渲染。
3. 在 `effects/types.ts` 的 `EffectType` 加 id，在 `CameraLayer` 的 `EFFECTS` 注册。
4. 定稿后更新本节表格。

---

## 10. 音效（sound）

音效与画面解耦，是一层 `<Audio>`。代码在 `sound/`：
- `sounds.ts`：音效库注册表（`id → file + 分类 + label`，全英文）。音频文件随模板在 `assets/sfx/`，安装后在 `public/business-explainer/sfx/`。
- `SoundLayer.tsx`：按 `SoundCue` 在时间点用 `<Sequence from><Audio></Sequence>` 触发一次性音效。
- `SoundCue = {id, start(秒), volume?}`，默认音量 `0.85`。
- 口播原声来自 `OffthreadVideo`，sfx 叠加其上一起输出。

### 音效库（15 个，分 4 类）
分类只是用法建议，**不写死，合适时都可混用**。下表 id 即 `SoundCue.id`。

| 分类 | 用途 | 音效 id | 重复率 |
|---|---|---|---|
| `opening` | 开头 3 秒引人注目 | `suspense-boom` / `tense-transition` / `shh-tension` | 一般开头一次 |
| `keypoint` | 重点带出（**随机混用、降低重复**） | `variety-suspense` / `variety-suspense-tap` / `ming-suspense` / `clang-light` / `variety-suspense-wrong` / `eerie-drip` | **高**，混着用 |
| `goldquote` | 结尾 / 金句 / 励志重点 | `flash-transition` / `water-drop-soft` / `water-drop` | 中 |
| `ending` | 结尾收束 | `wood-knock` / `impact-echo` / `pause-transition` | 低～中 |

### 铺排规则
- **音效必须落在被装饰的内容上，绝不落在 `plain` 字幕上**：音效命中点那一刻，画面应是 `strong`/`strongWord`/`sentence`/`cross` 或有镜头特效——普通白字没有视觉支撑，配音效会突兀。排音效时确认该时间点的 cue 不是 plain，且**尾音别飘到**紧接的 plain 句上。
- **开头**用 opening 类一记，配合 `vignetteFocus` 留人。
- **关键词 / Hero**用 keypoint 类，**每次换不同的**，避免重复；重复的也要拉开距离。
- **金句 / 收尾**用 goldquote / ending 类。
- **错开间隔**：相邻音效间隔 ≥ ~2.5s，避免叠音糊在一起。
- **密度**：可大胆铺（一条 60s 片约 10～12 个），但留呼吸。
- **跨集要变化**：不要每集同一套——开头音、结尾音、中段组合都在**整个 15 个音效库里轮换**，避免系列雷同、避免素材吃灰。每集刻意换一批不常用的（如 suspense-boom / tense-transition / water-drop / wood-knock / impact-echo / pause-transition）。特效与字幕节奏也尽量集间换花样。

### 新增 / 更换音效
1. 把音频放进模板 `assets/sfx/`（用 ASCII 文件名），并复制到 `public/business-explainer/sfx/`。
2. 在 `sounds.ts` 注册一行（id / file / category / label）。
3. 在 spec 的 `sounds: SoundCue[]` 里用 id 触发。
