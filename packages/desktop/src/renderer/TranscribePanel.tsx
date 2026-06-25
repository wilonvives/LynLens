import { useEffect, useMemo, useState } from 'react';
import { applyCorrections, type Transcript, type TranscriptTemplate } from './core-browser';
import { Waveform } from './transcribe/Waveform';
import { TermsTab } from './transcribe/TermsTab';
import { DraftTab } from './transcribe/DraftTab';
import { AlignTab } from './transcribe/AlignTab';
import { baseName, stem } from './transcribe/util';

interface Props {
  projectId: string | null;
  videoPath: string | null;
  /** Chosen source (audio/video). Controlled by App so drag-drop can set it. */
  sourcePath: string | null;
  onSourceChange: (p: string | null) => void;
}

type TabKey = 'terms' | 'draft' | 'align';
type AlignCfg = Awaited<ReturnType<typeof window.lynlens.lynscripeGetAlign>>;

/** The auto-saved session sidecar (next to the source file). Renderer-owned. */
interface SavedSession {
  template?: TranscriptTemplate | null;
  corrections?: Record<string, string>;
  vocabChecked?: string[];
  draftLines?: string[];
  transcript?: Transcript | null;
}

/** Derive editable draft lines from the template + current corrections. */
function deriveLines(template: TranscriptTemplate, corrections: Record<string, string>): string[] {
  return applyCorrections(template, corrections)
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

/**
 * 转录 tab (Lynscripe) — standalone, path-based subtitle transcription. Three
 * sub-tabs over one source file: ① AI 转录 (Gemini text + flag uncertain terms),
 * ② 文稿生成 (apply corrections → clean draft), ③ 音轨对齐 (whisper word timings
 * char-aligned → timed subtitles). This file is the composition root: it owns
 * all state + IPC + persistence; each sub-tab is a presentational component.
 */
export function TranscribePanel({
  projectId,
  videoPath,
  sourcePath,
  onSourceChange,
}: Props): JSX.Element {
  const [config, setConfig] = useState<{ keySet: boolean; model: string } | null>(null);
  const [alignCfg, setAlignCfg] = useState<AlignCfg | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [keyInput, setKeyInput] = useState('');

  const [tab, setTab] = useState<TabKey>('terms');
  const [confirming, setConfirming] = useState(false);
  const [playTime, setPlayTime] = useState(0);
  const [template, setTemplate] = useState<TranscriptTemplate | null>(null);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [vocabChecked, setVocabChecked] = useState<Set<string>>(new Set());
  const [vocab, setVocab] = useState<Record<string, string> | null>(null);
  const [draftLines, setDraftLines] = useState<string[]>([]);
  const [preview, setPreview] = useState<Transcript | null>(null);

  const [transcribing, setTranscribing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const language = 'auto';

  useEffect(() => {
    void window.lynlens.lynscripeGetConfig().then(setConfig);
    void window.lynlens.lynscripeGetAlign().then(setAlignCfg);
  }, []);

  async function pickFwFolder(): Promise<void> {
    const p = await window.lynlens.lynscripePickFwFolder();
    if (p) setAlignCfg(await window.lynlens.lynscripeSetAlign(p, alignCfg?.alignModel || 'medium'));
  }

  async function setAlignModel(key: string): Promise<void> {
    setAlignCfg(await window.lynlens.lynscripeSetAlign(alignCfg?.fwPath || '', key));
  }

  // Source change → clear results, then restore a previously auto-saved session.
  useEffect(() => {
    let cancelled = false;
    setTemplate(null);
    setCorrections({});
    setVocabChecked(new Set());
    setDraftLines([]);
    setPreview(null);
    setApplied(null);
    setExported(null);
    setRestored(false);
    setError(null);
    setTab('terms');
    if (!sourcePath) return;
    void window.lynlens.lynscripeLoadSession(sourcePath).then((raw) => {
      if (cancelled || !raw) return;
      const s = raw as SavedSession;
      if (s.template) setTemplate(s.template);
      if (s.corrections) setCorrections(s.corrections);
      if (s.vocabChecked) setVocabChecked(new Set(s.vocabChecked));
      if (s.draftLines) setDraftLines(s.draftLines);
      else if (s.template) setDraftLines(deriveLines(s.template, s.corrections ?? {}));
      if (s.transcript) setPreview(s.transcript);
      if (s.template || s.transcript) setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [sourcePath]);

  // Debounced auto-save (skips the empty state so it never clobbers a session).
  useEffect(() => {
    if (!sourcePath || (!template && !preview)) return;
    const handle = setTimeout(() => {
      const session: SavedSession = {
        template,
        corrections,
        vocabChecked: [...vocabChecked],
        draftLines,
        transcript: preview,
      };
      void window.lynlens.lynscripeSaveSession(sourcePath, session);
    }, 700);
    return () => clearTimeout(handle);
  }, [sourcePath, template, corrections, vocabChecked, draftLines, preview]);

  const termValues = useMemo(
    () =>
      template
        ? template.uncertainTerms.map((t) => corrections[t.id] || t.guess || t.heard)
        : [],
    [template, corrections]
  );
  const canApply = !!projectId && !!sourcePath && sourcePath === videoPath;

  async function saveKey(): Promise<void> {
    const k = keyInput.trim();
    if (!k) return;
    setConfig(await window.lynlens.lynscripeSetKey(k));
    setKeyInput('');
    setShowSettings(false);
  }

  async function pickFile(): Promise<void> {
    const p = await window.lynlens.lynscripePickFile();
    if (p) onSourceChange(p);
  }

  async function runTranscribe(): Promise<void> {
    if (!sourcePath) return;
    setTranscribing(true);
    setError(null);
    setRestored(false);
    setTemplate(null);
    setPreview(null);
    try {
      const tpl = await window.lynlens.lynscripeTranscribe(sourcePath, language);
      const init: Record<string, string> = {};
      const checked = new Set<string>();
      for (const t of tpl.uncertainTerms) {
        init[t.id] = t.guess || t.heard;
        if (['person', 'brand', 'place', 'org', 'abbr'].includes(t.category)) checked.add(t.id);
      }
      setCorrections(init);
      setVocabChecked(checked);
      setDraftLines(deriveLines(tpl, init));
      setTemplate(tpl);
    } catch (err) {
      setError(`转录失败: ${(err as Error).message}`);
    } finally {
      setTranscribing(false);
    }
  }

  function reseedDraft(): void {
    if (template) setDraftLines(deriveLines(template, corrections));
  }

  function draftText(): string {
    if (draftLines.length) return draftLines.join('\n');
    return template ? deriveLines(template, corrections).join('\n') : '';
  }

  async function loadVocab(): Promise<void> {
    setVocab(await window.lynlens.lynscripeGetVocab());
  }

  async function runAlign(): Promise<void> {
    const text = draftText();
    if (!sourcePath || !text.trim()) return;
    setBuilding(true);
    setError(null);
    setApplied(null);
    setExported(null);
    try {
      const commitVocab = (template?.uncertainTerms ?? [])
        .filter((t) => vocabChecked.has(t.id))
        .map((t) => ({ term: corrections[t.id] || t.guess || t.heard, category: t.category }))
        .filter((v) => v.term.trim());
      setPreview(await window.lynlens.lynscripeBuild(sourcePath, text, { language, commitVocab }));
    } catch (err) {
      setError(`对齐失败: ${(err as Error).message}`);
    } finally {
      setBuilding(false);
    }
  }

  async function exportSrt(): Promise<void> {
    if (!preview) return;
    try {
      const saved = await window.lynlens.lynscripeExportSrt(preview, sourcePath ? stem(sourcePath) : 'transcript');
      if (saved) setExported(saved);
    } catch (err) {
      setError(`导出失败: ${(err as Error).message}`);
    }
  }

  async function exportTxt(): Promise<void> {
    try {
      await window.lynlens.lynscripeExportTxt(draftText(), sourcePath ? stem(sourcePath) : 'transcript');
    } catch (err) {
      setError(`导出失败: ${(err as Error).message}`);
    }
  }

  async function runApply(): Promise<void> {
    if (!projectId || !preview) return;
    try {
      const r = await window.lynlens.lynscripeApply(projectId, preview);
      setApplied(r.applied);
    } catch (err) {
      setError(`应用失败: ${(err as Error).message}`);
    }
  }

  return (
    <div className="transcribe-panel">
      {/* Header + settings gear */}
      <div className="transcribe-header">
        <div className="transcribe-title">字幕转录 <span className="transcribe-badge">Lynscripe</span></div>
        <div className="transcribe-gear-wrap">
          <button className="transcribe-icon-btn" onClick={() => setShowSettings((s) => !s)} title="设置 Gemini Key">
            ⚙
          </button>
          {showSettings && (
            <div className="transcribe-settings-pop">
              <div className="transcribe-section-title">
                Gemini Key {config?.keySet ? `· 已配置 (${config.model})` : '· 未配置'}
              </div>
              <div className="transcribe-key-edit">
                <input
                  type="password"
                  placeholder="粘贴 Gemini API Key"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  style={{ width: 240 }}
                />
                <button className="primary" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
                  保存
                </button>
              </div>

              <div className="transcribe-section-title" style={{ marginTop: 12 }}>
                对齐引擎 ·{' '}
                {alignCfg?.engine === 'faster-whisper'
                  ? `faster-whisper(${alignCfg.alignModel},你的本地包,GPU)`
                  : 'whisper.cpp large-v3(内置,慢)'}
              </div>
              <div className="transcribe-key-edit">
                <button onClick={() => void pickFwFolder()}>选择 faster-whisper 包文件夹</button>
              </div>
              {alignCfg?.fwPath && (
                <div className="transcribe-source-none" style={{ fontSize: 11, maxWidth: 280, wordBreak: 'break-all' }}>
                  {alignCfg.fwPath}
                  {!alignCfg.ready && ' ⚠ 无效:缺 python/模型'}
                </div>
              )}
              {alignCfg && alignCfg.models.length > 0 && (
                <label className="transcribe-source-none" style={{ fontSize: 12 }}>
                  对齐模型{' '}
                  <select
                    value={alignCfg.alignModel}
                    onChange={(e) => void setAlignModel(e.target.value)}
                  >
                    {alignCfg.models.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Source picker */}
      <div className="transcribe-source">
        <button onClick={() => void pickFile()}>选择音频/视频文件</button>
        {sourcePath ? (
          <span className="transcribe-source-name" title={sourcePath}>
            {baseName(sourcePath)}
            {sourcePath === videoPath && <span className="transcribe-cat" style={{ marginLeft: 6 }}>当前视频</span>}
            {restored && <span className="transcribe-applied" style={{ marginLeft: 8 }}>✓ 已恢复进度</span>}
          </span>
        ) : (
          <span className="transcribe-source-none">还没选文件 — 选一个,或直接拖进来</span>
        )}
      </div>

      {/* Waveform player — frozen above the scrolling tab content */}
      <Waveform sourcePath={sourcePath} onTime={setPlayTime} />

      {error && <div className="transcribe-error">{error}</div>}

      {/* Sub-tab nav (frozen) */}
      <div className="transcribe-subtabs">
        <button className={tab === 'terms' ? 'active' : ''} onClick={() => setTab('terms')}>1 · AI 转录</button>
        <button className={tab === 'draft' ? 'active' : ''} onClick={() => setTab('draft')}>2 · 文稿生成</button>
        <button className={tab === 'align' ? 'active' : ''} onClick={() => setTab('align')}>3 · 音轨对齐</button>
      </div>

      <div className="transcribe-scroll">
      {tab === 'terms' && (
        <TermsTab
          keySet={!!config?.keySet}
          transcribing={transcribing}
          sourcePath={sourcePath}
          template={template}
          corrections={corrections}
          onCorrection={(id, value) => setCorrections((c) => ({ ...c, [id]: value }))}
          vocabChecked={vocabChecked}
          onToggleVocab={(id, checked) =>
            setVocabChecked((s) => {
              const n = new Set(s);
              if (checked) n.add(id);
              else n.delete(id);
              return n;
            })
          }
          onTranscribe={() => setConfirming(true)}
          vocab={vocab}
          onLoadVocab={() => void loadVocab()}
          onNext={() => setTab('draft')}
        />
      )}
      {tab === 'draft' && (
        <DraftTab
          ready={!!template}
          lines={draftLines}
          setLines={setDraftLines}
          termValues={termValues}
          onReseed={reseedDraft}
          onExportTxt={() => void exportTxt()}
          onNext={() => setTab('align')}
        />
      )}
      {tab === 'align' && (
        <AlignTab
          ready={!!template}
          building={building}
          preview={preview}
          setPreview={setPreview}
          currentTime={playTime}
          onAlign={() => void runAlign()}
          onExportSrt={() => void exportSrt()}
          canApply={canApply}
          onApply={() => void runApply()}
          exported={exported}
          applied={applied}
        />
      )}
      </div>

      {/* #1 — confirm before spending Gemini tokens */}
      {confirming && (
        <div className="transcribe-modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="transcribe-modal" onClick={(e) => e.stopPropagation()}>
            <div className="transcribe-modal-title">开始转录?</div>
            <div className="transcribe-modal-body">
              将用 <b>Gemini ({config?.model ?? 'gemini-2.5-flash'})</b> 转录这段音频,
              会消耗你的 Gemini API token(按音频时长计费)。whisper 时间轴对齐在本地跑、不消耗 token。
            </div>
            <div className="transcribe-modal-foot">
              <button onClick={() => setConfirming(false)}>取消</button>
              <button
                className="primary"
                onClick={() => {
                  setConfirming(false);
                  void runTranscribe();
                }}
              >
                确认转录
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
