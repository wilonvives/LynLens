// 「商务讲解」模板的设计 token：颜色、字体、字号、版式、描边、阴影。
// 调整这里 = 整套字幕的视觉统一变化。
export const theme = {
  fontFamily: 'Source Han Serif SC',
  colors: {
    normal: '#ffffff',
    highlight: '#FFD60A',
  },
  sizes: {
    normal: 64,
    emphasis: 84,
  },
  layout: {
    // 字幕竖直中心所在位置，用「距底部的高度比例」表示。0.25 = 1/4 高。
    verticalCenterFromBottom: 0.25,
    maxWidth: '86%',
  },
  // 普通字基础外观：白字 + 细黑描边 + 黑色投影，无底色 box。
  stroke: {
    color: '#000000',
    width: 4, // px @ 1080 宽；paint-order=stroke 后可见描边约为一半，偏细
  },
  dropShadow: '0 5px 12px rgba(0,0,0,0.6)',
  // 强调用的金色发光（叠加在投影之上）。
  glowShadow: '0 0 20px rgba(255,180,0,0.55), 0 5px 12px rgba(0,0,0,0.7)',
  highlightShadow: '0 0 22px rgba(255,190,0,0.6)',
} as const;
