# LynLens Packaging Template Spec (v1.0)

**This document is written for AI.** Paste it into ChatGPT / Claude / Gemini / any LLM, give it a few sample videos, and ask it to design a packaging template for you. The AI's output should be a `.lynpack` ZIP that LynLens can import and run — no LynLens-specific code required.

A "packaging template" is a portable bundle that tells an AI **how to design subtitle / audio / camera packaging for a video**. LynLens consumes the bundle at generation time: it feeds the template's instructions to its own LLM along with the user's transcript, and the LLM returns a concrete plan that LynLens renders into the final video.

The same bundle should be runnable by other tools too. If your AI follows this spec, the resulting `.lynpack` is forward-portable.

---

## File format

A `.lynpack` is a ZIP archive with this layout:

```
my-template.lynpack            (zip extension renamed to .lynpack)
├── manifest.json              (REQUIRED — schema below)
├── prompt.md                  (REQUIRED — AI instructions in Markdown)
├── preview/                   (RECOMMENDED — visual previews)
│   ├── thumbnail.png            (square, 256x256, used in card UI)
│   └── frames/                  (optional sample frames)
│       ├── 1.jpg
│       └── 2.jpg
├── sfx/                       (OPTIONAL — sound effects)
│   ├── punch.mp3
│   └── whoosh.mp3
├── music/                     (OPTIONAL — background music loops)
│   └── upbeat.mp3
└── fonts/                     (OPTIONAL — bundled TTF/OTF for portable rendering)
    └── Custom-Heavy.ttf
```

Paths inside the bundle are referenced from `manifest.json` using forward slashes. The runtime is responsible for resolving them at load time.

**Total size budget**: 25 MB. Larger templates won't import (UX choice; share heavy assets out-of-band).

---

## `manifest.json` schema

```jsonc
{
  // Always pin the spec version so the runtime can migrate / reject.
  "$schema": "lynpack@1.0.0",

  // --- Identity ---
  "id": "high-energy",                  // kebab-case, unique within a user's library
  "name": "高能",                       // display name (any language)
  "description": "钩子段密集花字, 红黄轮换, 字号 +30%",
  "version": "1.0.0",                   // semver
  "author": {
    "name": "your-handle",
    "url": "https://your-site.example"  // optional
  },
  "tags": ["短视频", "钩子", "高能"],    // optional, for search/filter

  // --- Preview (for the template picker card) ---
  "preview": {
    "thumbnail": "preview/thumbnail.png",   // 256x256 PNG/JPG; the card thumbnail
    "exampleFrames": [                       // OPTIONAL extra preview frames
      "preview/frames/1.jpg",
      "preview/frames/2.jpg"
    ]
  },

  // --- Subtitle design (the big one) ---
  "subtitle": {
    "defaults": {                            // applied to every line
      "font": "PingFang SC Heavy",           // family name; falls back if not installed
      "size": 64,                            // px @ 1080p reference. range [16, 120]
      "color": "#ffffff",                    // hex
      "outline": { "color": "#000000", "width": 4 },
      "position": "bottom"                   // "top" | "center" | "bottom"
    },
    "keywords": {
      "palette": ["#ff3333", "#ffd700", "#00ffff"],  // colours to rotate through
      "sizeBoost": 1.3,                              // multiplier on default size
      "perSegment": { "min": 2, "max": 3 },          // how many keywords/segment
      "categoriesByPriority": [                       // what to highlight first
        "数字",
        "情绪强词",
        "动词高潮",
        "品牌/人名/专有名词"
      ]
    }
  },

  // --- Audio (OPTIONAL, v0.6 limited support) ---
  "audio": {
    "sfx": [
      {
        "id": "punch",
        "file": "sfx/punch.mp3",
        "trigger": "on-punchline-segment",   // see TRIGGERS below
        "volume": 0.5                         // 0..1
      }
    ],
    "music": {
      "file": "music/upbeat.mp3",
      "energy": "high",                       // "low" | "medium" | "high"
      "volume": 0.2,
      "loop": true
    }
  },

  // --- Camera (OPTIONAL, v0.6+ placeholder) ---
  "camera": {
    "punchlineZoom": 1.3,    // segments tagged as punchline → zoom this much
    "focusOnFace": true       // when true, AI may emit camera.focus on faces
  },

  // --- Pointer to the AI guideline doc ---
  "instructions": "prompt.md"   // path inside the bundle
}
```

### Required fields
`$schema`, `id`, `name`, `version`, `author.name`, `subtitle.defaults`, `instructions`.

Everything else is optional. The runtime fills in safe defaults when fields are missing.

### Unknown fields
Unknown top-level fields produce a **warning** at import, not an error. Extra fields in nested objects are silently dropped. This keeps forward-compat: a template authored against `lynpack@1.1.0` will still import (with warnings) on a runtime that only knows `lynpack@1.0.0`.

---

## `prompt.md` — the AI instructions

This is **the heart of the template**. The runtime appends this Markdown to its own system prompt when it calls the LLM to generate a packaging plan. Think of it as the "personality" of the template.

Write it for an LLM to read. Be specific, give examples.

### Required sections

```markdown
# Template name

## 风格定位
Who is this for? What kind of video?
(Hook segments / explainer / 综艺 / 教学 / 长访谈 / ...)

## 关键词挑选规则
How many words to highlight per segment? What categories?
What to avoid?

## 颜色规则
Which palette entries for what kind of word?
Any forbidden colour combinations?

## 字号规则
When to boost size? When to leave default?

## 例子 (REQUIRED — at least 2)
Show the LLM what good output looks like.

Input transcript line: "今天讲一个可怕的事情"
Expected wordEffects: [
  { wordIdx: 4, highlight: "#ff3333", size: 80 }   // "可怕"
]
Reason: emotion-heavy word, segment is a hook.

Input transcript line: "我刚才说过这一点"
Expected: no wordEffects (filler, not a punchline).
```

### Optional sections

```markdown
## 音效触发
When the AI emits a punchline segment, the runtime can layer an SFX from
manifest.audio.sfx[]. Tell it when:
- "on-punchline-segment" triggers when the segment is the first of a hook
- "on-keyword" triggers per highlighted word

## 节奏指导
Where camera zoom or transition makes sense. v0.6+ runtimes act on this;
older runtimes ignore.

## 反例 (anti-examples)
What NOT to do. The LLM learns from these.
```

### Length
Aim for **800–2000 words**. Long enough to give the LLM real guidance, short enough to fit in a single Claude turn alongside the transcript.

---

## How LynLens consumes a template

1. **Import**: user drops `.lynpack` into LynLens → file is unzipped to `~/Library/Application Support/LynLens/templates/<id>/`. Manifest is validated.
2. **Card UI**: 包装 tab's 模板 tab shows a card with `name`, `description`, `preview.thumbnail`. User picks one.
3. **Generation**: user clicks "✨ 一键包装". LynLens:
   - Builds its base system prompt (transcript, segment count, etc).
   - Appends the template's `prompt.md` verbatim.
   - Adds `manifest.subtitle` as a STRUCTURED CONSTRAINT block (so the LLM follows palette/sizeBoost/perSegment numerically, not just textually).
   - Calls the AI provider. Gets a `PackagingPlan` JSON back.
4. **Render**: the plan goes through the existing renderer (PackagingSubtitleOverlay) and exporter (ass-generator). Template's audio.sfx / music get layered in at export time if the runtime supports it.

## How OTHER tools can consume a template

The `.lynpack` is pure data. If you're building your own tool:
- Read `manifest.json` for structural constraints.
- Read `prompt.md` as the LLM instruction block.
- Send your transcript + both to any LLM (Claude, GPT-4, Gemini, ...).
- Get back JSON that follows whatever schema your tool expects.

LynLens publishes its expected output schema at:
`https://lynlens.app/docs/packaging-plan-schema.json` (TODO: stub URL)

If your tool uses the same schema, the LLM's output runs in both.

---

## Worked example — minimum viable template

This is enough to get a working `.lynpack`. Save as `simple/manifest.json`:

```json
{
  "$schema": "lynpack@1.0.0",
  "id": "simple",
  "name": "极简",
  "description": "白字黑边, 关键词金色, 每段最多 1 个高亮",
  "version": "1.0.0",
  "author": { "name": "anonymous" },
  "subtitle": {
    "defaults": {
      "font": "PingFang SC Heavy",
      "size": 56,
      "color": "#ffffff",
      "outline": { "color": "#000000", "width": 3 },
      "position": "bottom"
    },
    "keywords": {
      "palette": ["#ffd700"],
      "sizeBoost": 1.2,
      "perSegment": { "min": 0, "max": 1 },
      "categoriesByPriority": ["数字", "品牌/人名"]
    }
  },
  "instructions": "prompt.md"
}
```

And `simple/prompt.md`:

```markdown
# 极简

## 风格定位
通用. 任何类型视频. 优先可读性, 不喧宾夺主.

## 关键词挑选规则
每段最多 1 个. 不是每段都需要 — 平淡段不要硬加.
优先级: 数字 > 品牌/人名. 其他类别都不要碰.

## 颜色规则
就一个色: #ffd700. 不要换.

## 字号规则
关键词 size = default × 1.2. 别的不要改.

## 例子
"今天我们讲三个理论" → wordEffects: [{ wordIdx: 3, highlight: "#ffd700", size: 67 }]
"刚才说的是这样" → no wordEffects (no number, no name)
```

Zip the directory:
```bash
cd simple && zip -r ../simple.lynpack . && cd ..
```

Drop `simple.lynpack` into LynLens. Done.

---

## Authoring with your own AI — recipe

1. Pick 3-5 sample videos that represent the style you want.
2. Open ChatGPT / Claude / Gemini.
3. Paste this entire SPEC document into the chat.
4. Paste your sample video descriptions (or upload them if multimodal).
5. Ask: "Design a `.lynpack` template that matches this style. Output `manifest.json` and `prompt.md` separately."
6. Iterate: ask the AI to adjust palette, perSegment, etc.
7. Save the files, add a `preview/thumbnail.png`, ZIP it.
8. Import into LynLens.

If the AI gets confused about field types, paste this SPEC again — the schema section is canonical.

---

## Versioning

| Spec version | LynLens runtime | Notes |
|---|---|---|
| 1.0.0 | v0.6+ | This document. |
| 1.1.0 | v0.7? | Adds transition rules, multi-language subtitle support. |

The runtime always supports the major version it shipped with. New minor versions are forward-compatible (unknown fields warn but don't break).

---

## Reference implementation

LynLens ships two built-in templates as live examples:
- `templates/default/` — 通用 baseline
- `templates/energetic/` — 高能 with palette rotation

Both follow this spec exactly. Cracking them open is the fastest way to see what a real `.lynpack` looks like.
