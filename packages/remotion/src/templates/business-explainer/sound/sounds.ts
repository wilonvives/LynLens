// 音效库注册表：id → 文件 + 分类 + 名称。音效文件随模板在 assets/sfx/，
// 安装后在 public/business-explainer/sfx/。分类只是用法建议，合适时都可混用。
export type SoundCategory = 'opening' | 'keypoint' | 'goldquote' | 'ending';

export interface SoundDef {
  id: string;
  file: string; // public/business-explainer/sfx/ 下的文件名
  category: SoundCategory;
  label: string;
}

export const SOUNDS: SoundDef[] = [
  // 开头 3 秒引人注目
  {id: 'suspense-boom', file: 'suspense-boom.mp3', category: 'opening', label: 'Suspense Boom'},
  {id: 'tense-transition', file: 'tense-transition.mp3', category: 'opening', label: 'Tense Transition'},
  {id: 'shh-tension', file: 'shh-tension.mp3', category: 'opening', label: 'Shh Tension (big thing coming)'},

  // 重点带出（随机混用，降低重复）
  {id: 'variety-suspense', file: 'variety-suspense.mp3', category: 'keypoint', label: 'Variety Suspense'},
  {id: 'variety-suspense-tap', file: 'variety-suspense-tap.mp3', category: 'keypoint', label: 'Variety Suspense Tap'},
  {id: 'ming-suspense', file: 'ming-suspense.mp3', category: 'keypoint', label: 'Ming Suspense'},
  {id: 'clang-light', file: 'clang-light.mp3', category: 'keypoint', label: 'Clang (light impact)'},
  {id: 'variety-suspense-wrong', file: 'variety-suspense-wrong.mp3', category: 'keypoint', label: 'Variety Suspense (something wrong)'},
  {id: 'eerie-drip', file: 'eerie-drip.mp3', category: 'keypoint', label: 'Eerie Drip'},

  // 结尾 / 金句 / 励志重点
  {id: 'flash-transition', file: 'flash-transition.mp3', category: 'goldquote', label: 'High Flash Transition'},
  {id: 'water-drop-soft', file: 'water-drop-soft.mp3', category: 'goldquote', label: 'Water Drop (soft)'},
  {id: 'water-drop', file: 'water-drop.mp3', category: 'goldquote', label: 'Water Drop'},

  // 结尾
  {id: 'wood-knock', file: 'wood-knock.mp3', category: 'ending', label: 'Wooden Knock (eerie)'},
  {id: 'impact-echo', file: 'impact-echo.mp3', category: 'ending', label: 'Impact Echo'},
  {id: 'pause-transition', file: 'pause-transition.mp3', category: 'ending', label: 'Pause Transition'},
];

export const SOUND_BY_ID: Record<string, SoundDef> = Object.fromEntries(
  SOUNDS.map((s) => [s.id, s]),
);
