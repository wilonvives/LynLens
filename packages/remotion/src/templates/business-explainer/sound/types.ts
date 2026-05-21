// 音效触发：在某个时间点播放某个音效。
export interface SoundCue {
  id: string; // 对应 sounds.ts 注册表的 id
  start: number; // 触发时间（秒）
  volume?: number; // 默认 0.85
}
