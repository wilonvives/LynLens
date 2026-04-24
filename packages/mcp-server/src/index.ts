#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LynLensEngine, WhisperLocalService } from '@lynlens/core';
import { registerTools } from './tools/index.js';

/**
 * Find whisper.cpp binary + model in the desktop package's resources folder,
 * or in custom env-var locations. Called from an MCP server started by Claude
 * desktop, we can't rely on Electron's process.resourcesPath.
 */
function resolveWhisper(): { binaryPath: string; modelPath: string } | null {
  const envBin = process.env.LYNLENS_WHISPER_BIN;
  const envModel = process.env.LYNLENS_WHISPER_MODEL;
  if (envBin && envModel && existsSync(envBin) && existsSync(envModel)) {
    return { binaryPath: envBin, modelPath: envModel };
  }
  const platformDir =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
        ? process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
        : null;
  if (!platformDir) return null;

  // In the monorepo, this file lives at packages/mcp-server/dist/index.js
  // Resources are at packages/desktop/resources/whisper/<platform>/
  const repoResources = path.resolve(
    __dirname,
    '..',
    '..',
    'desktop',
    'resources',
    'whisper',
    platformDir
  );
  const exe = process.platform === 'win32' ? '.exe' : '';
  const bin = path.join(repoResources, `whisper-cli${exe}`);
  const model = path.join(repoResources, 'ggml-base.bin');
  if (existsSync(bin) && existsSync(model)) return { binaryPath: bin, modelPath: model };
  return null;
}

async function main() {
  const engine = new LynLensEngine();
  const whisper = resolveWhisper();
  if (whisper) {
    engine.setTranscriptionService(
      new WhisperLocalService({
        binaryPath: whisper.binaryPath,
        modelPath: whisper.modelPath,
        ffmpegPaths: engine.ffmpegPaths,
      })
    );
     
    console.error('[lynlens-mcp] whisper.cpp ready at', whisper.binaryPath);
  } else {
     
    console.error('[lynlens-mcp] whisper not found; transcribe tool will be a no-op');
  }

  const server = new McpServer({
    name: 'lynlens',
    version: '0.1.0',
  });

  registerTools(server, engine);

  const transport = new StdioServerTransport();
  await server.connect(transport);
   
  console.error('[lynlens-mcp] ready on stdio');
}

main().catch((err) => {
   
  console.error('[lynlens-mcp] fatal:', err);
  process.exit(1);
});
