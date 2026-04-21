#!/usr/bin/env node
/**
 * One-shot installer: writes the LynLens MCP server entry into the user's
 * Claude Desktop config, preserving existing preferences / other MCP servers.
 *
 * Usage:
 *   node scripts/install-mcp-to-claude.mjs
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const mcpEntryPath = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');

function configPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

// Find node.exe (on Windows Claude Desktop doesn't always inherit PATH)
async function findNodeExe() {
  if (process.platform !== 'win32') return 'node';
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'nodejs', 'node.exe'),
    process.execPath, // the node we're running from
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {}
  }
  return 'node';
}

async function main() {
  const cfgPath = configPath();
  console.log(`Claude config: ${cfgPath}`);

  // Make sure our MCP server has been built
  try {
    await fs.access(mcpEntryPath);
  } catch {
    console.error(`❌ MCP server not built yet: ${mcpEntryPath}`);
    console.error('   Run:  pnpm --filter @lynlens/mcp-server build');
    process.exit(1);
  }

  let existing = {};
  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    existing = JSON.parse(raw);
    console.log(`✓ Loaded existing config (${Object.keys(existing).join(', ')})`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('ℹ No existing config; will create a new one.');
      await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    } else {
      console.error('❌ Could not parse existing config as JSON:', err.message);
      console.error('   Fix the file manually, then re-run this script.');
      process.exit(1);
    }
  }

  const nodePath = await findNodeExe();
  console.log(`✓ Node binary: ${nodePath}`);

  // Back up the current file (only if it exists)
  try {
    await fs.access(cfgPath);
    const backup = cfgPath + '.before-lynlens.bak';
    await fs.copyFile(cfgPath, backup);
    console.log(`✓ Backup saved to: ${backup}`);
  } catch {}

  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      lynlens: {
        command: nodePath,
        args: [mcpEntryPath],
      },
    },
  };

  await fs.writeFile(cfgPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  console.log('✓ Wrote lynlens MCP entry into Claude Desktop config.');
  console.log('\nNext steps:');
  console.log('  1. Quit Claude Desktop completely (tray icon → Quit, not just close window)');
  console.log('  2. Relaunch Claude Desktop');
  console.log('  3. In a new chat, click "+" → Connectors, look for lynlens');
  console.log('  4. Ask: "用 lynlens 的 open_project 工具打开 D:/test.mp4"');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
