# Packaging Template Authoring — Real Friction Log

**This is a working document.** It captures the actual decision-points,
ambiguities, and reversals encountered while designing the first
LynLens packaging template from a reference video. Future AI authors
should read this BEFORE attempting their own template — it'll save
them from the same potholes.

The "v0 spec" in `PACKAGING_TEMPLATE_SPEC.md` was written from theory.
Once this exercise completes, the spec will be rewritten based on
what was actually needed.

---

## Reference video

`5月16日_edited_高光_SLAPP_让你闭嘴的策略性诉讼.mp4`
- 2:52, 1080×1920 portrait, 30fps, h264
- Contains AIGC metadata — likely processed by a third-party Chinese
  short-video tool (Kaipai / Jianying / similar) AFTER LynLens exported
  a bare highlight cut.
- Content: legal talk about SLAPP suits, single speaker, talking-head
  style.

## Frame sampling strategy

8 frames at 21.5s intervals + 10 dense frames every 6s in 0-60s +
10 tail frames every 8s in 95-167s. Total ~28 frames covering all
distinct subtitle moments.

Frames saved under `/tmp/lynlens-ref-analysis/` during the session.

---

## Observations (raw)

### Persistent hero title
- Top of frame, full width
- Two lines: **数码时代** / **你的人权还安全吗**
- Visible in EVERY single frame analyzed → present for the whole 172s
- Style: light blue → cyan gradient interior, thick dark outline,
  slight glow / second outline in lighter blue, heavy bold sans-serif
- This is **separate from segment subtitles** — it's a persistent
  "show title card" layered on top of the video

### Segment subtitles
Position: **NOT at the bottom** like a standard subtitle. They sit
around **Y = 60-75%** of the frame height (over the speaker's upper
chest / body, overlapping the t-shirt). Examples:

| Timestamp | Text | Char count | Y position (% of frame) |
|---|---|---|---|
| 2.0s  | 这个讲座是关于人权的议题      | 12 | ~69% |
| 16.0s | 一些涉嫌诈骗                    | 6  | ~63% |
| 23.5s | 我们不能看明知                  | 7  | ~64% |
| 28.0s | 也不可以去暗                    | 6  | ~65% |
| 40.0s | 都是已经被各大的保险公司        | 12 | ~67% |
| 45.0s | 还有segree commission禁止       | mixed | ~64% |
| 66.5s | 为什么                          | 3  | ~58% |
| 88.0s | 那个injunction就在门口里面了    | 12 | ~67% |
| 95.0s | 要你永远出不了身 + 👆             | 8  | ~70% |
| 109.5s| 衣食住行                        | 4  | ~62% |
| 119.0s| 什么是数码人权                  | 7  | ~64% |
| 131.0s| 如果你是利用大选go              | mixed | ~63% |
| 135.0s| 做潜力                          | 3  | ~62% |
| 152.5s| 你的惩罚 + 👆                    | 4  | ~75% |
| 167.0s| 如果你是一个成功的案例          | 10 | ~69% |

Style: uniform **yellow** (~#fed800 / #ffd700 family) with thick
**black outline**. NO per-word highlighting. NO color variation.
Heavy bold sans-serif (looks like 阿里巴巴普惠体 / 站酷高端黑 /
similar artistic bold).

Emoji decorations (👆) appear at 95s and 152.5s — accusatory /
emphatic moments. Editor-placed, not pattern-driven.

---

## Hypotheses & reversals

### ❌ HYPOTHESIS 1: "Short phrases get promoted to mid-frame"
**Reasoning**: Frame 003 (66.5s) "为什么" appeared HIGHER than other
subtitles. Initially read that as: short emotional phrases get
visually promoted.

**Reversal**: After plotting ALL observed Y positions, the variance
is 58%-75% with NO strong correlation to text length. "为什么"
(3 chars, ~58%) is high, but "衣食住行" (4 chars, ~62%) is closer
to average. And "你的惩罚" (4 chars, ~75%) is LOWER than average.

**Reality**: All subtitles sit in a single zone (upper-chest area,
~60-75%). Minor variance probably reflects manual editor placement
per-segment, not a deterministic rule. **The "promoted short phrase"
pattern is human-eye-confirmation-bias.**

**Spec implication**: A template can specify a single position
range (e.g., `position: "upper-chest"` or a y-fraction default).
Per-segment exact placement may be discretionary; the template
shouldn't try to encode complex placement rules.

### ❌ HYPOTHESIS 2: "Per-keyword color highlighting"
**Reasoning**: My v0 template (PACKAGING_TEMPLATE_SPEC.md draft)
assumed Stable-Diffusion-style palette rotation per keyword. I
designed `subtitle.keywords.palette: ["#ff3333", "#ffd700", "#ff6b00"]`.

**Reversal**: NONE of the 28 frames analyzed show ANY per-word
color variation. Every segment subtitle is uniformly yellow. The
"high energy" comes from:
1. Big bold yellow text (high contrast vs background)
2. Persistent dramatic title at top
3. Variable per-segment positioning (NOT random per-word color)
4. Occasional emoji adornment

**My v0 was a fundamental misread of what "高能" means**. The actual
template doesn't have keyword-level color logic at all.

**Spec implication**: The schema needs to distinguish two FUNDAMENTALLY
DIFFERENT styles of "energetic":
- **Uniform-line style** (the reference video) — entire line gets one
  bold color, emphasis via size / position / decorations
- **Per-keyword style** (what LynLens v0.5 currently does) — base line
  is white, individual words colored

These are not variations of the same template — they're separate
templates. A v1 spec should let a template DECLARE which style it
uses, so the runtime knows whether to feed `wordEffects` instructions
or `lineColor` instructions to the AI.

### ⚠ HYPOTHESIS 3: "Title is part of the same template as subtitles"
The hero title persists for the entire 172s. It's clearly a
separately-authored element (different font, different color scheme,
NOT speech-driven). 

**Question for the user**: is the title part of the packaging template
we're designing? Or is it a separate "title card" feature that should
be designed independently?

**My current take**: it should be a separate `titleOverlay` schema
field, not lumped into `subtitle`. Templates can declare:
```jsonc
{
  "titleOverlay": {
    "text": "{user supplies}",
    "position": "top",
    "style": { ... },
    "persist": "full" | "first-N-seconds"
  },
  "subtitle": { ... }
}
```

The reference video uses `persist: "full"`. A title card that only
shows for the first 3 seconds would use `persist: { firstSeconds: 3 }`.

**For now (this template iteration)**: skip the title overlay. Focus
on getting the subtitle behavior right. Add title overlay as a
follow-up template feature.

### ⚠ FRICTION: I can't see what font is used
The reference subtitle font is clearly an artistic Chinese bold
("得意黑" / "站酷高端黑" / "阿里巴巴普惠体 Heavy" or similar). It's NOT
PingFang SC. But I can't visually identify it precisely from a JPEG.

**Workaround**: template's `font` field can specify a family name; if
the runtime can't find it locally, fall back to PingFang Heavy. The
character of the template (uniform yellow + bold + dramatic) survives
the font fallback.

**Spec implication**: templates need a `fontFallbackChain` field
(array of family names), and the runtime tries each in order. This
matters because a template author on macOS may use a font that's not
on a user's Windows machine.

### ⚠ FRICTION: I can't hear audio
The user wanted me to capture audio SFX trigger points. I can extract
audio via ffmpeg but can't analyze WHEN audio events happen without
either:
- Listening (I'm not multimodal-audio)
- Visual cues that correlate with audio events (sometimes there are
  none)

**Workaround for this exercise**: skip audio entirely in the first
template draft. Document this as a known gap — the user (or a
human/multimodal AI) needs to annotate audio events for the spec
to be complete.

**Spec implication**: the SPEC should explicitly call out that audio
trigger authoring requires manual annotation when working from a
video; a text-only AI authoring a template needs the human to provide
"SFX fires at 0:12, 1:45, 2:30" annotations alongside the video.

### ⚠ FRICTION: Emoji decoration is contextual, not rule-based
👆 appears at 95s and 152.5s. Both are "you" + accusatory ("要你永远
出不了身" / "你的惩罚"). The pattern is:
- Subject = "你" (you)
- Tone = accusatory / warning
- Then 👆 appears below the text

But the rule is fuzzy ("punchy accusatory moments") — it'd be hard for
an AI to reliably emit 👆 at the same places a human editor did.

**Spec implication**: emoji decorations are a v0.7+ feature. For now,
the template can include an `emojiPool` (e.g., `["👆", "💥", "🔥"]`)
and an `emojiFrequency` ("rare" | "moderate") guideline. Don't try
to encode WHEN to use which emoji — let the AI improvise with the
pool, and the user can manually remove via UI later.

---

## Derived design rules (v0 — to be validated)

For a template that produces output matching this reference video:

### subtitle.defaults
- `font`: `"得意黑"` with fallback to `"PingFang SC Heavy"` (can't
  identify exact font from JPEG)
- `size`: ~80 (chars are big — roughly 5-6% of frame height on 1920p)
- `color`: `#fed800` (sampled from frames, may be slightly different)
- `outline`: `{ color: "#000000", width: 6 }` (thick, prominent)
- `position`: NEW concept needed — "upper-body" or "y-fraction: 0.65"

### subtitle.styleMode
- NEW field — `"uniform"` vs `"keyword-highlight"`
- This reference uses `"uniform"` → entire line single color, no
  wordEffects
- `keyword-highlight` mode (LynLens v0.5 current) is a separate style

### subtitle.lineSplitRule
- Reference video keeps long sentences on ONE line. The reference
  doesn't appear to break lines like LynLens default does. This may
  just be a side effect of `width: max-content` being used.
- For LynLens, transcript segments are already pre-broken into
  reasonably-short lines by Whisper, so this might not need a
  template-level rule.

### titleOverlay (NEW field, skip for v1 template)
Out of scope for this exercise. Document as a follow-up.

### audio (NEW field, skip for v1 template)
Can't observe from JPEGs. Out of scope. Document as a follow-up.

### emoji (NEW field, skip for v1 template)
Out of scope. Document as v0.7+.

---

## What v0 of "高能 — uniform yellow" template looks like

(To be drafted as `templates/energetic-uniform/`.)

```json
{
  "$schema": "lynpack@1.0.0",
  "id": "energetic-uniform",
  "name": "高能 · 整段黄字",
  "description": "胸前位置 · 整段黄字 · 黑边粗体 · 适合钩子段 / 控诉 / 警示",
  "subtitle": {
    "styleMode": "uniform",
    "defaults": {
      "font": "得意黑",
      "fontFallback": ["阿里巴巴普惠体 Heavy", "PingFang SC Heavy", "sans-serif"],
      "size": 80,
      "color": "#fed800",
      "outline": { "color": "#000000", "width": 6 },
      "position": { "y": 0.65 }
    }
  }
}
```

**Differences from spec v0:**
- New `styleMode` field
- `position` is now an OBJECT with `y` fraction (not just `top/center/bottom`)
- `fontFallback` chain added
- No `keywords.palette` (this template doesn't use per-word color)

---

## Open questions for the user — RESOLVED

User decisions (this round):

1. **Title overlay** → SKIP. Treat as separate feature later.
2. **Audio SFX** → SKIP. `audio` schema field can wait.
3. **Font** → SKIP. Use fallback chain; exact font ID not needed.
4. **Emoji** → SKIP. Not addressed.
5. **Style mode** → **DO NOT add styleMode field**. Stick with the
   existing keyword-highlight architecture (LynLens v0.5's
   `wordEffects` model). 高能 template = aggressive variant of
   keyword-highlight, NOT a literal reproduction of the reference
   video's uniform-yellow look.

### Why this is correct

When the user said "look at the reference and mimic it", I (the AI)
interpreted that as "the reference video IS the target style". But
when I forced the user to choose between:
- (A) literal uniform-yellow replication (changes architecture, drops
  AI's keyword-picking value), and
- (B) keyword-highlight done aggressively (no architecture change,
  preserves AI value)

…the user picked (B). So the reference video served as **VIBE** input
(bold / punchy / saturated / chest-area / yellow-dominant) but is NOT
the literal output target. 高能 just needs to feel as energetic as
the reference, using LynLens's keyword-highlight tooling.

### Lesson for the spec rewrite

The SPEC should explicitly tell authors:

> "A reference video gives you VIBE — the feeling of a finished
> packaging. It does NOT dictate the implementation. Map the vibe
> to the schema's available primitives. If the schema doesn't have a
> primitive for what you see (e.g., uniform-line color), use what's
> available (e.g., aggressive keyword highlighting in a saturated
> palette) to evoke the SAME feeling."

This pre-empts the "designer fixates on pixel-perfect replication"
failure mode I just walked into.

---

## Process meta-notes (for the spec rewrite)

- I extracted 28 frames before I had confidence in the patterns.
  This is probably the minimum density for a 2-3 min video.
- I formed and discarded TWO hypotheses ("short = up", "per-word
  colors"). A spec that encourages authors to "make hypothesis →
  challenge it → revise" would help.
- The biggest surprise was that **my v0 was fundamentally wrong about
  WHAT energetic means visually**. The spec should warn:
  - "Don't assume your training/intuition matches the reference."
  - "Test your hypothesis against MULTIPLE frames."
  - "If your design adds features the reference doesn't have (e.g.,
    per-word colors when reference uses uniform), you've overfit."
- The schema needs to be EXPRESSIVE enough to support multiple
  fundamentally-different styles. A `styleMode` enum + per-mode
  field sets is better than one giant union type.
