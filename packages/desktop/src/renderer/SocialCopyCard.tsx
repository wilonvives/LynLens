import { useEffect, useState } from 'react';
import type { SocialCopyData } from './core-browser';

interface Props {
  setId: string;
  copy: SocialCopyData;
  platformLabel: string;
  /** True while the parent is saving an edit to this card (debounce indicator). */
  saving: boolean;
  onEdit: (patch: { title?: string; body?: string; hashtags?: string[] }) => void;
  onDelete: () => void;
}

const TITLELESS = new Set<string>(['tiktok', 'twitter']);

/**
 * Displays one platform's copy. Every field is an editable textarea that
 * auto-saves on blur via onEdit. Three individual copy buttons plus a
 * 全部复制 compose the full clipboard story (decision #7). Delete is a
 * one-click remove with a quick confirm.
 */
export function SocialCopyCard({
  copy,
  platformLabel,
  saving,
  onEdit,
  onDelete,
}: Props) {
  // Local draft state so typing feels responsive; committed on blur.
  const [titleDraft, setTitleDraft] = useState(copy.title);
  const [bodyDraft, setBodyDraft] = useState(copy.body);
  const [tagsDraft, setTagsDraft] = useState(copy.hashtags.join(' '));
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // If the canonical copy changes (e.g., after regenerate), refresh the drafts.
  useEffect(() => {
    setTitleDraft(copy.title);
    setBodyDraft(copy.body);
    setTagsDraft(copy.hashtags.join(' '));
  }, [copy.title, copy.body, copy.hashtags]);

  const titleless = TITLELESS.has(copy.platform);

  function commitTitle(): void {
    if (titleDraft !== copy.title) onEdit({ title: titleDraft });
  }
  function commitBody(): void {
    if (bodyDraft !== copy.body) onEdit({ body: bodyDraft });
  }
  function commitTags(): void {
    const parsed = parseHashtags(tagsDraft);
    if (!arraysEqual(parsed, copy.hashtags)) onEdit({ hashtags: parsed });
  }

  async function copyField(field: string, text: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch (err) {
      alert(`复制失败: ${(err as Error).message}`);
    }
  }

  function assembleAll(): string {
    const parts: string[] = [];
    if (!titleless && copy.title.trim()) parts.push(copy.title.trim());
    if (copy.body.trim()) parts.push(copy.body.trim());
    if (copy.hashtags.length > 0) {
      parts.push(copy.hashtags.map((t) => `#${t}`).join(' '));
    }
    return parts.join('\n\n');
  }

  return (
    <div className="copy-card">
      <div className="copy-card-head">
        <span className="copy-card-platform">{platformLabel}</span>
        {saving && <span className="copy-card-saving">保存中...</span>}
        <div className="spacer" />
        <button
          className="copy-card-delete"
          onClick={() => {
            if (confirm(`删除 ${platformLabel} 这张文案卡片?`)) onDelete();
          }}
          title="删除这张卡片"
        >
          删除
        </button>
      </div>

      {!titleless && (
        <div className="copy-card-field">
          <label>标题</label>
          <textarea
            className="copy-card-input"
            rows={2}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
          />
        </div>
      )}

      <div className="copy-card-field">
        <label>正文</label>
        <textarea
          className="copy-card-input"
          rows={6}
          value={bodyDraft}
          onChange={(e) => setBodyDraft(e.target.value)}
          onBlur={commitBody}
        />
      </div>

      <div className="copy-card-field">
        <label>Hashtags (用空格或换行分隔,不要加 #)</label>
        <textarea
          className="copy-card-input"
          rows={2}
          value={tagsDraft}
          onChange={(e) => setTagsDraft(e.target.value)}
          onBlur={commitTags}
        />
        {copy.hashtags.length > 0 && (
          <div className="copy-card-tagchips">
            {copy.hashtags.map((t, i) => (
              <span key={i} className="copy-card-tagchip">
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="copy-card-actions">
        {!titleless && (
          <button onClick={() => copyField('title', copy.title)} disabled={!copy.title}>
            {copiedField === 'title' ? '已复制' : '复制标题'}
          </button>
        )}
        <button onClick={() => copyField('body', copy.body)} disabled={!copy.body}>
          {copiedField === 'body' ? '已复制' : '复制正文'}
        </button>
        <button
          onClick={() =>
            copyField('tags', copy.hashtags.map((t) => `#${t}`).join(' '))
          }
          disabled={copy.hashtags.length === 0}
        >
          {copiedField === 'tags' ? '已复制' : '复制 Hashtags'}
        </button>
        <button
          className="primary"
          onClick={() => copyField('all', assembleAll())}
          disabled={!assembleAll()}
        >
          {copiedField === 'all' ? '已复制' : '全部复制'}
        </button>
      </div>
    </div>
  );
}

// ---------- helpers ----------

function parseHashtags(raw: string): string[] {
  return raw
    .split(/[\s,，]+/) // whitespace + both English and Chinese commas
    .map((t) => t.replace(/^\s*#\s*/, '').trim())
    .filter((t) => t.length > 0);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
