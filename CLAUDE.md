# CLAUDE.md — Project rules for Claude (and humans)

This file is read automatically by Claude Code at the start of every session.
It encodes the conventions this repo enforces, why they exist, and the
non-obvious traps that have already cost real debugging time. Follow these
rules unless the user explicitly overrides them in-session.

## What LynLens is (one paragraph)

LynLens is a macOS Electron app for AI-assisted "talking-head" video editing.
The user drops in a long talking-camera recording; the app runs Whisper
transcription locally, lets the user mark/cut filler, generates short-form
highlight variants and social-copy drafts via Claude/Codex agents, and
exports the compacted video. It's a pnpm monorepo: `packages/core` is pure
TypeScript with no Electron dependencies (project state, ripple math,
transcription, agents); `packages/desktop` is the Electron shell (main +
renderer + IPC + shared types).

## File size limits (hard rule)

| Tier | Lines | Action |
|---|---|---|
| Typical | ≤400 | Default target for any file. |
| Acceptable | 400–800 | OK if the file is genuinely cohesive (e.g. one canvas-drawing component). |
| Over budget | >800 | **Must** be split. ESLint will warn. New code may not push an existing file over 800 — extract first. |

When you find yourself appending to a file already over 800 lines, **stop and
extract** before adding more. The user explicitly cares about "ease of finding
and modifying code" over micro-optimizations.

### Currently-known oversized files (technical debt)

These predate this rule. Don't grow them; ideally shrink them when working in
their area:

- `packages/desktop/src/main/index.ts` — being split into `main/ipc/<domain>.ts`.
- `packages/desktop/src/renderer/App.tsx` — being split into `components/` + `hooks/`.
- `packages/desktop/src/renderer/SubtitlePanel.tsx` — extract `TimestampEditor` and the SRT/copy logic when next touched.
- `packages/desktop/src/renderer/Timeline.tsx` — canvas drawing + interaction in one file. Tolerable for now (one concept), but extract `draw()` into a sibling file if it grows further.

## Directory layout & responsibility

```
packages/core/src/
├── engine.ts             Top-level facade — projects + agents + ffmpeg paths
├── project-manager.ts    One project's state machine (segments, transcript, variants)
├── segment-manager.ts    Mark / approve / reject / ripple commit
├── ripple.ts             Source⇄effective time math (see below)
├── transcription.ts      Whisper.cpp wrapper + JSON post-process
├── diarization*.ts       Speaker identification (mock + sherpa-onnx)
├── highlight-*.ts        Highlight variant generation prompts/parser
├── copywriter-*.ts       Social copy generation prompts/parser/platforms
├── export-service.ts     ffmpeg invocation
├── event-bus.ts          Engine→renderer event channel
└── types.ts              Public types shared via `@lynlens/core`

packages/desktop/src/main/
├── index.ts              Window/protocol/lifecycle ONLY — never an IPC handler
├── ipc/
│   ├── _context.ts       IpcContext type + factory
│   ├── project.ts        open/save/state/dialog/reload
│   ├── segments.ts       add/remove/erase/resize/approve/reject/undo/redo
│   ├── transcript.ts     transcribe/edit/resize-subtitle/diarize
│   ├── speakers.ts       rename/clear
│   ├── highlights.ts     generate/update/pin/delete/export-variant
│   ├── social.ts         copywriter handlers
│   ├── export.ts         export/cancel-export/get-waveform
│   ├── agent-window.ts   detached agent BrowserWindow lifecycle
│   └── settings.ts       ai-mode/orientation/etc.
├── agent-tools/          Shared LynLensToolDef list (Claude SDK + Codex MCP both consume)
├── agent.ts              Claude Agent SDK wiring
├── agent-codex.ts        Codex SDK wiring (HTTP MCP + sandbox config)
├── agent-dispatcher.ts   Provider switch
├── mcp-http-server.ts    External MCP for Codex
├── auto-updater.ts       Electron auto-update
└── preload.ts            contextBridge — keep IPC surface explicit

packages/desktop/src/renderer/
├── App.tsx               Composition root + cross-section state ONLY
├── components/           One file per screen region (toolbar, sidebar, player, ...)
├── dialogs/              Modal dialogs (ExportDialog, OrientationDialog, ...)
├── hooks/                Stateful logic factored out of App (usePlaybackLoop, ...)
├── styles/               CSS split by feature
├── store.ts              Zustand store
├── core-browser.ts       Re-exports from @lynlens/core for renderer (browser-safe subset)
└── util.ts               Tiny pure helpers
```

When adding a new IPC handler, find the correct `main/ipc/<domain>.ts`. If
none fits, **create a new domain file**, do not append to a wrong one.
`main/index.ts` should never gain a `ipcMain.handle(...)` call again.

When adding a new UI feature, identify which screen region or modal it
belongs to. Put it in that component's file — don't add to App.tsx.

## The ONE non-obvious data model rule: source-time vs effective-time

Segments and transcripts always store **source-time** seconds — i.e. seconds
into the unedited original video. Cuts (segments with `status: 'cut'`)
introduce a separate **effective-time** axis: source minus the cumulative
length of all earlier cuts. The Timeline renders effective-time; the `<video>`
element seeks in source-time.

Conversion lives in `core/ripple.ts`:

- `sourceToEffective(srcSec, cuts)` — for display
- `effectiveToSource(effSec, cuts)` — for seeking
- `getEffectiveDuration(srcDur, cuts)` — for progress bars

**Each function/handler must document which axis it accepts and returns.**
Callers must convert at the boundary. Confusing the two has bitten us
multiple times — most recently, SubtitlePanel was passing effective time to
`onJump` while App.onJumpTo expected source time, which made every subtitle
click seek to a position "from before the cuts".

When in doubt, name the parameter `srcSec` or `effSec`, never just `sec`.

## React patterns

- **Refs for DOM elements are unreliable in dev** (StrictMode + Vite Fast
  Refresh). For long-lived RAF loops or anywhere the ref might be read by
  code outside the immediate render, prefer `document.querySelector` against
  a stable selector and backfill the ref on first hit. The `<video>` element
  in App.tsx demonstrates this pattern.
- **Don't put unstable references in useEffect deps** unless you actually
  want the effect to tear down on every change. zustand store array fields
  (`store.segments`) get a fresh reference on every `set` — putting them in
  the deps of an RAF/long-lived effect cancels the loop on every state
  change. Use a mirror ref (`segmentsRef.current`) read from inside the
  effect's closure.
- **Add NaN guards before writing `videoElement.currentTime`**. Before
  `loadedmetadata` fires, `v.duration` is NaN; `Math.min(NaN, x) = NaN`;
  setting `currentTime = NaN` throws an uncaught TypeError that kills the
  entire RAF chain. Always wrap with `Number.isFinite`.

## New feature workflow

1. **Discuss before refactor-class changes**. The user's standing rule:
   "大改动先讨论不要绕圈" — flag refactor-level cost early instead of trying
   a low-cost version first and getting kicked back.
2. **Decide where the code goes BEFORE writing it**. Look at the directory
   layout above. If no file fits and the new domain is large enough, create
   a new file rather than appending to a generic one.
3. **AI-friendly is a hard requirement**, not a nice-to-have. Any new feature
   that's exposed via UI also needs a corresponding MCP tool in
   `main/agent-tools/`. The user explicitly said: every stage must be
   AI-friendly so they can drive it from the chat panel by natural language.
4. **Restart dev after every code change** — the user explicitly disabled
   trust in HMR. After editing, kill the dev process and `pnpm dev` again.
5. **Don't chain tool calls beyond the literal request**. Each button / MCP
   tool does exactly what its name says, nothing more. The user explicitly
   pushed back on auto-chaining.
6. **Code review pass after writing**. Use the `code-reviewer` agent for
   non-trivial changes.

## Build / lint commands

- `pnpm dev` — Vite + tsc watch + Electron, all three concurrent (run from `packages/desktop/`)
- `pnpm lint` — ESLint flat config across the monorepo
- `pnpm test` — Vitest in `packages/core`
- `pnpm --filter @lynlens/desktop build` — production renderer build + tsc

## Release flow

The user's standing rule: when they say "发版" / "更新" / "推 git 打钉", run
the bump-tag-push triple immediately, no per-step confirmation:

1. Bump `package.json` version in root + `packages/desktop` + `packages/core` (keep three in sync).
2. `git add -A && git commit -F <tmpfile>` (heredoc with backticks fails — write the message to a temp file).
3. `git tag v<version> && git push origin main --tags`.

For commit messages: write the **why**, not the what. Conventional Commits
prefix (`feat:` / `fix:` / `chore:` / `refactor:`).

## Quick smoke-test checklist (use after risky refactors)

When asked to verify after a refactor, walk through:

- Open old `.qcp`, press play, playhead moves smoothly (RAF intact)
- Click a subtitle card, video seeks to the exact phrase (source/effective rule intact)
- Mark a delete segment via shift-drag, approve, ripple-commit, undo, redo
- Generate one highlight variant via the chat panel (agent IPC + tool calls intact)
- Export a 5-second clip (ffmpeg path resolution intact)

If any of these regress after a refactor, the refactor needs another pass.
