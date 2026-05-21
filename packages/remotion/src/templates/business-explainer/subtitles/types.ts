// 所有字幕样式共用的入参。每个样式自己用 useCurrentFrame 做动画，
// Sequence 已把帧号归零到「本句出现的那一刻」。
export interface SubtitleStyleProps {
  text: string;
  highlight?: string[]; // 需要高亮的词（部分样式会用到）
  segments?: string[]; // 句子分节（重点句样式用：上/中/下）
  durationInFrames?: number; // 本句显示时长（帧），用于「整体隐出」等收尾动画
}
