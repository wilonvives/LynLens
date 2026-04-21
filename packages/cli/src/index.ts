#!/usr/bin/env node
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LynLensEngine, type ExportMode, type ExportQuality } from '@lynlens/core';

const program = new Command();

program
  .name('lynlens')
  .description('LynLens CLI - script-friendly entry for talking-video quick-cut editing')
  .version('0.1.0');

program
  .command('probe <video>')
  .description('Read video meta info (duration/resolution/codec)')
  .action(async (video: string) => {
    const engine = new LynLensEngine();
    const project = await engine.openFromVideo({ videoPath: path.resolve(video) });
    console.log(JSON.stringify(project.videoMeta, null, 2));
  });

program
  .command('info <qcp>')
  .description('Print a summary of a .qcp project file')
  .action(async (qcpPath: string) => {
    const raw = await fs.readFile(qcpPath, 'utf-8');
    const data = JSON.parse(raw);
    const approved = (data.deleteSegments ?? []).filter((s: { status: string }) => s.status === 'approved');
    const pending = (data.deleteSegments ?? []).filter((s: { status: string }) => s.status === 'pending');
    const totalDeleted = approved.reduce(
      (sum: number, s: { start: number; end: number }) => sum + (s.end - s.start),
      0
    );
    console.log(`Project: ${qcpPath}`);
    console.log(`  video:     ${data.videoPath}`);
    console.log(`  duration:  ${data.videoMeta?.duration?.toFixed(2)}s`);
    console.log(`  segments:  ${data.deleteSegments?.length ?? 0} (approved: ${approved.length}, pending: ${pending.length})`);
    console.log(`  deleted:   ${totalDeleted.toFixed(2)}s`);
    console.log(`  aiMode:    ${data.aiMode}`);
  });

program
  .command('export <qcp>')
  .description('Export the video described by a .qcp file')
  .requiredOption('-o, --output <path>', 'output video path (must differ from source)')
  .option('-m, --mode <mode>', 'fast | precise', 'precise')
  .option('-q, --quality <quality>', 'original | high | medium | low', 'high')
  .action(async (qcpPath: string, opts: { output: string; mode: ExportMode; quality: ExportQuality }) => {
    const engine = new LynLensEngine();
    engine.eventBus.on('export.progress', (e) => {
      process.stdout.write(`\r[${e.stage}] ${e.percent.toFixed(1)}%   `);
    });

    const raw = await fs.readFile(qcpPath, 'utf-8');
    const data = JSON.parse(raw);
    const project = await engine.openFromVideo({
      videoPath: data.videoPath,
      projectPath: qcpPath,
    });

    const result = await engine.exports.export(project, {
      outputPath: path.resolve(opts.output),
      mode: opts.mode,
      quality: opts.quality,
    });
    process.stdout.write('\n');
    console.log(`Exported -> ${result.outputPath}`);
    console.log(`  duration: ${result.durationSeconds.toFixed(2)}s`);
    console.log(`  size:     ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  mode:     ${result.mode}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
