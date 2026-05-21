import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';
import {theme} from './theme';

// 加载本模板用到的字体（思源宋体 CN 子集：Regular + Heavy）。
// 安装后字体在 public/business-explainer/fonts/（见模板 README 安装步骤）。
export const loadTemplateFonts = (): Promise<unknown> =>
  Promise.all([
    loadFont({
      family: theme.fontFamily,
      url: staticFile('business-explainer/fonts/SourceHanSerifCN-Regular.otf'),
      weight: '400',
      format: 'opentype',
    }),
    loadFont({
      family: theme.fontFamily,
      url: staticFile('business-explainer/fonts/SourceHanSerifCN-Heavy.otf'),
      weight: '900',
      format: 'opentype',
    }),
  ]);
