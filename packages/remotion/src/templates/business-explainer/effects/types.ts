// 镜头特效：作用在背景视频上的「相机」动作（缩放/位移/压暗/底盘/调色），与字幕解耦。
export type EffectType = 'impactPunch' | 'vignetteFocus' | 'bottomScrim' | 'coolGrade';

// 收尾形式：
//   release = 独立使用，结束时推回 + 压暗淡出
//   hold    = 后面还接其他特效，跳过推回、保持推近状态交给下一个特效
export type EffectTail = 'release' | 'hold';

export interface EffectSpec {
  type: EffectType;
  start: number; // 秒
  end: number; // 秒
  origin?: string; // transform-origin，默认脸部 '50% 28%'
  tail?: EffectTail; // 默认 'release'
}

// 某一帧的相机状态。
export interface CameraState {
  scale: number;
  x: number; // px 位移（抖动用）
  y: number;
  vignette: number; // 边缘压暗强度 0~1
  scrim?: number; // 底部柔和阴影底盘的升起进度 0~1
  desaturate?: number; // 去色 + 冷调 强度 0~1
}

// 特效函数：给「窗口内局部帧 f」「窗口总帧数 len」「收尾形式 tail」，算出相机状态。
export type EffectFn = (f: number, len: number, tail: EffectTail) => CameraState;
