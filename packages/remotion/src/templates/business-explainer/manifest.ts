// 模板清单：模板的身份信息。以后做新系列就复制这个目录、改 manifest。
export const manifest = {
  id: 'business-explainer',
  name: '商务讲解',
  description: '思源宋体 + 金色强调，权威 / 严肃 / 编辑感的口播包装模板。',
  // 字幕样式先做，特效与音效后续加入。
  categories: ['subtitles'] as const,
} as const;

export type Manifest = typeof manifest;
