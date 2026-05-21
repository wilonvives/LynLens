// Type declaration for the `@remotion-template` Vite alias (points at
// packages/remotion/src/templates/business-explainer). The live player
// imports the composition component from here.
declare module '@remotion-template' {
  import type { FC } from 'react';
  import type { BusinessExplainerSpec } from '@lynlens/core';
  export const BusinessExplainer: FC<{
    videoSrc: string;
    spec: BusinessExplainerSpec;
  }>;
}
