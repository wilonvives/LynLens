import { useCallback, useEffect, useState } from 'react';
import {
  PLATFORM_LABELS,
  type HighlightVariant,
  type SocialCopySetData,
  type SocialPlatform,
  type SocialStylePresetData,
} from './core-browser';
import { GenerateCopyDialog } from './GenerateCopyDialog';
import { SocialCopyCard } from './SocialCopyCard';
import { useStore } from './store';

/**
 * Main surface for the 文案 tab. Shows every persisted SocialCopySet as a
 * group; each group contains one SocialCopyCard per platform. Generation
 * is per-click and persisted in main — UI only renders what's stored.
 */
export function SocialCopyPanel(): JSX.Element {
  const projectId = useStore((s) => s.projectId);
  const transcript = useStore((s) => s.transcript);
  const [sets, setSets] = useState<SocialCopySetData[]>([]);
  const [variants, setVariants] = useState<HighlightVariant[]>([]);
  const [styleNote, setStyleNote] = useState<string>('');
  const [stylePresets, setStylePresets] = useState<SocialStylePresetData[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [savingCopyId, setSavingCopyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate everything we need on mount / project change.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void Promise.all([
      window.lynlens.getSocialCopies(projectId),
      window.lynlens.getHighlights(projectId),
      window.lynlens.getState(projectId),
      window.lynlens.getSocialStylePresets(projectId),
    ]).then(([s, v, qcp, presets]) => {
      if (cancelled) return;
      setSets(s);
      setVariants(v);
      setStyleNote(qcp.socialStyleNote ?? '');
      setStylePresets(presets);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshSets = useCallback(async () => {
    if (!projectId) return;
    const next = await window.lynlens.getSocialCopies(projectId);
    setSets(next);
  }, [projectId]);

  async function handleGenerate(opts: {
    sourceType: 'rippled' | 'variant';
    sourceVariantId?: string;
    platforms: SocialPlatform[];
    userStyleNote?: string;
    saveStyleNoteGlobally: boolean;
  }): Promise<void> {
    if (!projectId) return;
    setShowDialog(false);
    setGenerating(true);
    setError(null);
    try {
      if (opts.saveStyleNoteGlobally) {
        const next = opts.userStyleNote ?? '';
        setStyleNote(next);
        await window.lynlens.setSocialStyleNote(projectId, next || null);
      }
      const result = await window.lynlens.generateSocialCopies(projectId, {
        sourceType: opts.sourceType,
        sourceVariantId: opts.sourceVariantId,
        platforms: opts.platforms,
        userStyleNote: opts.userStyleNote,
      });
      await refreshSets();
      if (result.failures.length > 0) {
        const msg = result.failures
          .map((f) => `${PLATFORM_LABELS[f.platform]}: ${f.error}`)
          .join('\n');
        setError(`部分平台生成失败:\n${msg}`);
      }
    } catch (err) {
      setError(`生成失败: ${(err as Error).message}`);
    } finally {
      setGenerating(false);
    }
  }

  async function handleEditCopy(
    setId: string,
    copyId: string,
    patch: { title?: string; body?: string; hashtags?: string[] }
  ): Promise<void> {
    if (!projectId) return;
    setSavingCopyId(copyId);
    try {
      await window.lynlens.updateSocialCopy(projectId, setId, copyId, patch);
      await refreshSets();
    } finally {
      setSavingCopyId(null);
    }
  }

  async function handleDeleteCopy(setId: string, copyId: string): Promise<void> {
    if (!projectId) return;
    await window.lynlens.deleteSocialCopy(projectId, setId, copyId);
    await refreshSets();
  }

  async function handleDeleteSet(setId: string): Promise<void> {
    if (!projectId) return;
    if (!confirm('删除这整组文案?')) return;
    await window.lynlens.deleteSocialCopySet(projectId, setId);
    await refreshSets();
  }

  async function handleStyleNoteBlur(): Promise<void> {
    if (!projectId) return;
    await window.lynlens.setSocialStyleNote(projectId, styleNote.trim() || null);
  }

  async function refreshPresets(): Promise<void> {
    if (!projectId) return;
    setStylePresets(await window.lynlens.getSocialStylePresets(projectId));
  }

  async function handleSaveAsPreset(): Promise<void> {
    if (!projectId || !styleNote.trim()) {
      alert('当前风格是空的,先填点内容再保存。');
      return;
    }
    const name = prompt('给这个风格起个名字:');
    if (!name || !name.trim()) return;
    await window.lynlens.addSocialStylePreset(projectId, name.trim(), styleNote);
    await refreshPresets();
  }

  async function handleLoadPreset(preset: SocialStylePresetData): Promise<void> {
    if (!projectId) return;
    // Only overwrite if different. Persist new style note.
    if (preset.content !== styleNote) {
      setStyleNote(preset.content);
      await window.lynlens.setSocialStyleNote(projectId, preset.content || null);
    }
  }

  async function handleRenamePreset(preset: SocialStylePresetData): Promise<void> {
    if (!projectId) return;
    const name = prompt('重命名风格:', preset.name);
    if (!name || name.trim() === preset.name) return;
    await window.lynlens.updateSocialStylePreset(projectId, preset.id, { name: name.trim() });
    await refreshPresets();
  }

  async function handleUpdatePresetContent(preset: SocialStylePresetData): Promise<void> {
    if (!projectId) return;
    if (!confirm(`把当前风格保存覆盖到「${preset.name}」?`)) return;
    await window.lynlens.updateSocialStylePreset(projectId, preset.id, { content: styleNote });
    await refreshPresets();
  }

  async function handleDeletePreset(preset: SocialStylePresetData): Promise<void> {
    if (!projectId) return;
    if (!confirm(`删除风格「${preset.name}」?`)) return;
    await window.lynlens.deleteSocialStylePreset(projectId, preset.id);
    await refreshPresets();
  }

  // --- Empty states ---
  if (!projectId) {
    return (
      <div className="highlight-empty">
        <h2>请先打开视频</h2>
      </div>
    );
  }

  if (!transcript || transcript.segments.length === 0) {
    return (
      <div className="highlight-empty">
        <h2>请先生成字幕</h2>
        <div className="hint">
          社群文案基于字幕内容生成。回到「粗剪」tab 点「生成字幕」后再来。
        </div>
      </div>
    );
  }

  return (
    <div className="copy-panel">
      <div className="copy-panel-header">
        <div>
          <div className="copy-panel-title">社群媒体文案</div>
          <div className="copy-panel-sub">
            为每个平台生成原生感文案 · 已有 {sets.length} 组
          </div>
        </div>
        <div className="spacer" />
        <button
          className="primary"
          onClick={() => setShowDialog(true)}
          disabled={generating}
        >
          {generating ? '生成中...' : '生成新文案'}
        </button>
      </div>

      <div className="copy-panel-stylenote">
        <div className="copy-panel-stylenote-head">
          <label>全局风格 / 账号定位(所有生成都会参考)</label>
          <span className="copy-set-spacer" />
          <button
            className="copy-style-save-as"
            onClick={() => void handleSaveAsPreset()}
            title="把当前风格存为一个可随时切换的预设"
          >
            另存为...
          </button>
        </div>
        <textarea
          className="copy-card-input"
          rows={2}
          placeholder="比如: 马来西亚华人创业账号,偏轻松直白,避免说教"
          value={styleNote}
          onChange={(e) => setStyleNote(e.target.value)}
          onBlur={handleStyleNoteBlur}
        />
        {stylePresets.length > 0 && (
          <div className="copy-style-presets">
            <div className="copy-style-presets-label">已保存的风格(点击加载):</div>
            <div className="copy-style-presets-row">
              {stylePresets.map((p) => {
                const isActive = p.content === styleNote;
                return (
                  <div
                    key={p.id}
                    className={`copy-style-preset${isActive ? ' active' : ''}`}
                  >
                    <button
                      className="copy-style-preset-load"
                      onClick={() => void handleLoadPreset(p)}
                      title={p.content.slice(0, 200)}
                    >
                      {p.name}
                    </button>
                    <button
                      className="copy-style-preset-action"
                      onClick={() => void handleRenamePreset(p)}
                      title="重命名"
                    >
                      改名
                    </button>
                    <button
                      className="copy-style-preset-action"
                      onClick={() => void handleUpdatePresetContent(p)}
                      title="用当前风格覆盖这个预设"
                    >
                      覆盖
                    </button>
                    <button
                      className="copy-style-preset-action delete"
                      onClick={() => void handleDeletePreset(p)}
                      title="删除"
                    >
                      删除
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error && <div className="highlight-error">{error}</div>}

      {generating && (
        <div className="gen-banner">
          <span className="gen-banner-dot" />
          <div>
            <div className="gen-banner-title">Claude 正在为每个平台并行写文案...</div>
            <div className="gen-banner-hint">通常 20-40 秒。平台越多越慢,单个平台失败不影响其他。</div>
          </div>
        </div>
      )}

      {sets.length === 0 && !generating && (
        <div className="highlight-empty" style={{ marginTop: 40 }}>
          <div className="hint">
            还没生成过文案。点右上「生成新文案」,选个源 + 要的平台即可。
            <br />
            每次生成都会独立存进工程,即使之后改了高光/粗剪也不会丢。
          </div>
        </div>
      )}

      {sets.map((set) => (
        <div key={set.id} className="copy-set">
          <div className="copy-set-head">
            <div>
              <div className="copy-set-source">源: {set.sourceTitle}</div>
              <div className="copy-set-meta">
                {new Date(set.createdAt).toLocaleString('zh-CN')}
              </div>
            </div>
            <span className="copy-set-spacer" />
            <button
              className="copy-set-delete"
              onClick={() => handleDeleteSet(set.id)}
              title="删除这整组"
            >
              删除这组
            </button>
          </div>

          <div className="copy-grid">
            {set.copies.map((c) => (
              <SocialCopyCard
                key={c.id}
                setId={set.id}
                copy={c}
                platformLabel={
                  PLATFORM_LABELS[c.platform as SocialPlatform] ?? c.platform
                }
                saving={savingCopyId === c.id}
                onEdit={(patch) => void handleEditCopy(set.id, c.id, patch)}
                onDelete={() => void handleDeleteCopy(set.id, c.id)}
              />
            ))}
          </div>
        </div>
      ))}

      {showDialog && (
        <GenerateCopyDialog
          variants={variants}
          initialStyleNote={styleNote}
          onCancel={() => setShowDialog(false)}
          onConfirm={handleGenerate}
        />
      )}
    </div>
  );
}
