import { Config } from '@remotion/cli/config';

// Mirror the proven host-project config. jpeg frames render faster than png
// and are visually identical for h264 output.
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
