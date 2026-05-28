// 「商务讲解」模板的对外内容契约。消费者给一条视频 + 一份 spec，模板负责渲染。
// spec 怎么填（什么内容用什么样式/特效/音效）见 RULES.md。
import type {EffectSpec} from './effects/types';
import type {SoundCue} from './sound/types';
import type {SimpleSubtitleStyle} from './subtitles/types';

// 一句字幕。
export interface Cue {
  start: number; // 出现时间（秒）
  text: string;
  style: string; // 字幕样式 id：plain / strong / strongWord / sentence / cross / simple
  highlight?: string[]; // 词级强调的词（strongWord / simple 用）
  segments?: string[]; // 分节（sentence 上中下；cross 竖+横）
}

// 一条视频的完整包装内容。
export interface BusinessExplainerSpec {
  cues: Cue[]; // 字幕线
  effects?: EffectSpec[]; // 镜头特效线
  sounds?: SoundCue[]; // 音效线
  soundsVolume?: number; // 全体音效音量倍率 0..1（默认 1），每条最终音量 = (cue.volume ?? 0.85) × 此值
  subtitleStyle?: SimpleSubtitleStyle; // 通用模板的全局字幕外观
}

export type {SimpleSubtitleStyle};

export type {EffectSpec, SoundCue};
