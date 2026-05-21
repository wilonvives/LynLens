// ep8 测试 spec：字幕 cues + 特效线 + 音效线。仅 workshop 自测。
import type {BusinessExplainerSpec} from '../templates/business-explainer';
import {cues} from './ep8.cues';

export const ep8Spec: BusinessExplainerSpec = {
  cues,
  effects: [
    {type: 'vignetteFocus', start: 0, end: 3.5}, // 开头留人
    {type: 'impactPunch', start: 17.21, end: 18.14}, // sentence 什么是数码人权
    {type: 'bottomScrim', start: 18.14, end: 32.7}, // 数码人权/freedom/Touch n Go 解释
    {type: 'impactPunch', start: 32.7, end: 33.86}, // cross 借出去做钱骡
    {type: 'bottomScrim', start: 38.0, end: 52.98}, // 法庭提告/法典/认罪/惩罚延续
    {type: 'impactPunch', start: 52.98, end: 54.81}, // sentence 延续到几时是终身
    {type: 'impactPunch', start: 66.81, end: 70.94, tail: 'hold'}, // 站出来分享→一线希望（励志结尾，连贯，戛然而止）
  ],
  // 本集换一批音效：开头 suspense-boom、结尾 water-drop-soft（励志收尾）、中段加入 wood-knock。
  sounds: [
    {id: 'suspense-boom', start: 0.25},
    {id: 'tense-transition', start: 10.78}, // 落在 strong「但是你们知道吗」，不压在 plain 衣食住行上
    {id: 'ming-suspense', start: 17.21},
    {id: 'variety-suspense-tap', start: 24.85},
    {id: 'clang-light', start: 32.7},
    {id: 'variety-suspense-wrong', start: 37.8},
    {id: 'wood-knock', start: 41.7}, // 落在 strong「刑事法典424」，不压在 plain「420 洗黑钱」上
    {id: 'eerie-drip', start: 47.78},
    {id: 'ming-suspense', start: 52.98},
    {id: 'variety-suspense', start: 60.89},
    {id: 'water-drop-soft', start: 66.81}, // 励志结尾，跟上结尾推近起点
  ],
};
