// 所有字幕样式共用的入参。每个样式自己用 useCurrentFrame 做动画，
// Sequence 已把帧号归零到「本句出现的那一刻」。

/** 通用(simple)样式的全局外观配置(spec.subtitleStyle)。 */
export interface SimpleSubtitleStyle {
  positionFromBottom: number; // 0..1，距底部高度比例
  size: number; // px @ 合成分辨率
  color: string; // 普通字颜色
  outlineColor: string; // 描边颜色
  outlineWidth: number; // 描边粗细 px
}

export interface SubtitleStyleProps {
  text: string;
  highlight?: string[]; // 需要高亮的词（部分样式会用到）
  segments?: string[]; // 句子分节（重点句样式用：上/中/下）
  durationInFrames?: number; // 本句显示时长（帧），用于「整体隐出」等收尾动画
  style?: SimpleSubtitleStyle; // 通用样式的全局外观（仅 SimpleSubtitle 用）
}
