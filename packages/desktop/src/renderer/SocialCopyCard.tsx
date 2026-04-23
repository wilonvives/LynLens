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
 * Minimal copy icon — two overlapping rectangles, the universal
 * clipboard/duplicate shape. Rendered as an inline SVG so we get crisp
 * scaling and a consistent look regardless of OS emoji fonts.
 */
function CopyIcon({ copied }: { copied: boolean }): JSX.Element {
  return (
    <svg
      className="copy-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ color: copied ? '#4ec9b0' : undefined }}
    >
      <rect x="4" y="3" width="8" height="10" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2" y="1" width="8" height="10" rx="1.2" fill="#1e1e1e" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * Displays one platform's copy. Every field is an editable textarea that
 * auto-saves on blur. Each field has its own small inline copy icon on the
 * label row so the user can grab title / body / hashtags individually
 * without scrolling to a bottom action row. Card-level actions (全部复制,
 * 删除) sit on the right of the header.
 */
export function SocialCopyCard({
  copy,
  platformLabel,
  saving,
  onEdit,
  onDelete,
}: Props) {
  const [titleDraft, setTitleDraft] = useState(copy.title);
  const [bodyDraft, setBodyDraft] = useState(copy.body);
  const [tagsDraft, setTagsDraft] = useState(copy.hashtags.join(' '));
  const [copiedField, setCopiedField] = useState<string | null>(null);

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
        <span className="copy-card-spacer" />
        <button
          className="primary copy-card-copy-all"
          onClick={() => copyField('all', assembleAll())}
          disabled={!assembleAll()}
        >
          {copiedField === 'all' ? '已复制' : '全部复制'}
        </button>
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
          <div className="copy-card-field-label">
            <button
              className="copy-card-field-copy"
              onClick={() => copyField('title', copy.title)}
              disabled={!copy.title}
              title="复制标题"
            >
              <CopyIcon copied={copiedField === 'title'} />
            </button>
            <label>标题</label>
          </div>
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
        <div className="copy-card-field-label">
          <button
            className="copy-card-field-copy"
            onClick={() => copyField('body', copy.body)}
            disabled={!copy.body}
            title="复制正文"
          >
            <CopyIcon copied={copiedField === 'body'} />
          </button>
          <label>正文</label>
        </div>
        <textarea
          className="copy-card-input"
          rows={6}
          value={bodyDraft}
          onChange={(e) => setBodyDraft(e.target.value)}
          onBlur={commitBody}
        />
      </div>

      <div className="copy-card-field">
        <div className="copy-card-field-label">
          <button
            className="copy-card-field-copy"
            onClick={() =>
              copyField('tags', copy.hashtags.map((t) => `#${t}`).join(' '))
            }
            disabled={copy.hashtags.length === 0}
            title="复制标签"
          >
            <CopyIcon copied={copiedField === 'tags'} />
          </button>
          <label>标签</label>
        </div>
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
    </div>
  );
}

// ---------- helpers ----------

function parseHashtags(raw: string): string[] {
  return raw
    .split(/[\s,，]+/)
    .map((t) => t.replace(/^\s*#\s*/, '').trim())
    .filter((t) => t.length > 0);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
