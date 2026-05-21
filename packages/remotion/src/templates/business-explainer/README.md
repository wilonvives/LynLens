# 模板 · 商务讲解（business-explainer）

把任意一条竖屏口播视频，包装成带**动效字幕 + 镜头特效 + 音效**的成片。
视觉：思源宋体 + 白字描边/投影 + 黄色强调，权威 / 严肃 / 编辑感。适配任意视频。

> 这是一个**可移植的 Remotion 模板**。前提：你的电脑已装好 Remotion 项目（这里不教装 Remotion）。

---

## 1. 安装（复制资产到 public，即算装好）

本模板自带要用的字体和音效，在 `assets/` 里。把它们复制到你项目的 `public/business-explainer/`：

```bash
# 假设本模板文件夹已放在 你的项目/templates/business-explainer/
mkdir -p public/business-explainer
cp -R templates/business-explainer/assets/fonts public/business-explainer/fonts
cp -R templates/business-explainer/assets/sfx   public/business-explainer/sfx
```

完成后应有：
```
public/business-explainer/fonts/SourceHanSerifCN-Regular.otf
public/business-explainer/fonts/SourceHanSerifCN-Heavy.otf
public/business-explainer/sfx/*.mp3   （15 个）
```
模板代码用 `staticFile('business-explainer/...')` 找这些文件——这就是安装的全部。

---

## 2. 用法（给一条视频套模板）

把你的视频放进 `public/`，然后在你的 `src/Root.tsx` 注册一个合成：

```tsx
import {Composition, staticFile} from 'remotion';
import {BusinessExplainer, type BusinessExplainerSpec} from '../templates/business-explainer';

const spec: BusinessExplainerSpec = {
  cues: [
    {start: 0.0, text: '第一句普通字', style: 'plain'},
    {start: 2.0, text: '这是关键词强调', style: 'strongWord', highlight: ['关键词']},
    {start: 4.0, text: '它比破产更恐怖', style: 'sentence', segments: ['它', '比破产', '更恐怖']},
    // …按 RULES.md 的规则铺
  ],
  effects: [
    {type: 'vignetteFocus', start: 0, end: 3.5},
    {type: 'impactPunch', start: 4.0, end: 6.0},
  ],
  sounds: [
    {id: 'shh-tension', start: 0.2},
    {id: 'ming-suspense', start: 4.0},
  ],
};

export const Root = () => (
  <Composition
    id="MyVideo"
    component={() => <BusinessExplainer videoSrc={staticFile('my-video.mp4')} spec={spec} />}
    durationInFrames={Math.round(63.78 * 30)} // = 视频秒数 × fps
    fps={30}
    width={1080}
    height={1920}
  />
);
```

渲染：`npx remotion render MyVideo out/my-video.mp4`。

> spec 的字幕时间戳从视频 0:00 起算。**怎么决定哪句用哪个样式 / 特效 / 音效、密度、重复率——全部在 [`RULES.md`](RULES.md)，务必先读。**

---

## 3. 这套模板有什么

- **字幕样式**（`subtitles/`）：`plain` 普通 · `strong` 加强 · `strongWord` 加强+词级 · `sentence` 三行Hero · `cross` 十字交叉句。
- **镜头特效**（`effects/`）：`impactPunch` 冲击推近 · `vignetteFocus` 黑边压暗 · `bottomScrim` 底部底盘 · `coolGrade` 去色冷调。
- **音效**（`sound/` + `assets/sfx/`）：15 个，分 opening / keypoint / goldquote / ending 四类。

对外只需 import：`BusinessExplainer`（入口组件）、`BusinessExplainerSpec`（spec 类型）、`SOUNDS`（音效库清单）。

---

## 4. 持续进化（怎么改 / 怎么加）

全部规则与步骤在 **[`RULES.md`](RULES.md)**：
- 加字幕样式（第 8 节）、加镜头特效（第 9 节）、加 / 换音效（第 10 节）。
- ⚠️ 改样式前先读 **第 6 节「实现约束」**（两层渲染、词边界切分、不可拆词表、cross 居中等硬性约束）。
- 做新风格系列：复制本文件夹改名，改 `manifest.ts` 与 `theme.ts` 等 token。

---

## 目录

```
business-explainer/
├── README.md         ← 本文件（安装 + 用法）
├── RULES.md          ← 权威文档：所有样式/特效/音效的规则、用法、坑
├── index.ts          ← 对外出口（BusinessExplainer / 类型 / SOUNDS）
├── BusinessExplainer.tsx  ← 入口组件（videoSrc + spec → 成片）
├── spec.ts           ← 内容契约（Cue / BusinessExplainerSpec）
├── manifest.ts theme.ts fonts.ts
├── subtitles/        字幕样式 + 注册表
├── effects/          镜头特效 + CameraLayer
├── sound/            音效库 + SoundLayer
└── assets/           随模板发布的字体 + 音效（安装时复制到 public/business-explainer/）
```
