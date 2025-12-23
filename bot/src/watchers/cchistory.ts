/**
 * cchistory Integration
 * Extracts and diffs Claude Code system prompts between versions
 * Uses the @mariozechner/cchistory npm package
 */

import { spawn } from 'bun';
import { readFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'path';

const WORK_DIR = process.env.CCHISTORY_WORK_DIR || '/tmp/cchistory';

/**
 * Run cchistory to extract prompts for a version
 * Returns the path to the generated markdown file
 */
export async function extractPrompts(version: string): Promise<string> {
  // Ensure cchistory is installed
  const checkResult = await spawn(['which', 'cchistory']).exited;
  if (checkResult !== 0) {
    throw new Error('cchistory not installed. Run: npm install -g @mariozechner/cchistory');
  }

  // Create work directory
  const Bun = await import('bun');
  await Bun.spawn(['mkdir', '-p', WORK_DIR]).exited;

  // Run cchistory
  const proc = spawn(['cchistory', version], {
    cwd: WORK_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`cchistory failed: ${stderr}`);
  }

  const outputFile = join(WORK_DIR, `prompts-${version}.md`);
  if (!existsSync(outputFile)) {
    throw new Error(`Expected output file not found: ${outputFile}`);
  }

  return outputFile;
}

/**
 * Extract prompts for a range of versions
 */
export async function extractPromptsRange(fromVersion: string, toVersion: string): Promise<string[]> {
  const Bun = await import('bun');
  await Bun.spawn(['mkdir', '-p', WORK_DIR]).exited;

  const proc = spawn(['cchistory', fromVersion, '--latest'], {
    cwd: WORK_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`cchistory failed: ${stderr}`);
  }

  // Find generated files
  const files = await readdir(WORK_DIR);
  return files
    .filter(f => f.startsWith('prompts-') && f.endsWith('.md'))
    .map(f => join(WORK_DIR, f));
}

/**
 * Generate a diff between two prompt files
 * Returns the raw diff output
 */
export async function diffPrompts(oldVersion: string, newVersion: string): Promise<string> {
  const oldFile = join(WORK_DIR, `prompts-${oldVersion}.md`);
  const newFile = join(WORK_DIR, `prompts-${newVersion}.md`);

  // Ensure both files exist
  if (!existsSync(oldFile)) {
    await extractPrompts(oldVersion);
  }
  if (!existsSync(newFile)) {
    await extractPrompts(newVersion);
  }

  // Run diff
  const proc = spawn(['diff', oldFile, newFile], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // diff returns 1 if files differ (that's expected)
  const stdout = await new Response(proc.stdout).text();
  return stdout;
}

/**
 * Clean up prompt diff output to remove noise
 * Filters out:
 * - Temp paths (/var/folders/...)
 * - Timestamps
 * - Random plan names
 */
export function cleanPromptDiff(rawDiff: string): string {
  const lines = rawDiff.split('\n');
  const meaningful: string[] = [];

  for (const line of lines) {
    // Skip if it matches noise patterns
    if (
      // Temp paths
      /\/var\/folders\/|\/tmp\/|\/private\/var/.test(line) ||
      // Timestamps like "2025-12-23T09:25:26.235Z"
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/.test(line) ||
      // Random plan names like "stateful-twirling-muffin"
      /\.claude\/plans\/[a-z]+-[a-z]+-[a-z]+\.md/.test(line) ||
      // Claude history temp dirs
      /claude-history-\d+-[a-z0-9]+/.test(line) ||
      // Empty diff context
      line.trim() === '---' ||
      line.trim() === ''
    ) {
      continue;
    }

    meaningful.push(line);
  }

  return meaningful.join('\n');
}

/**
 * Parse a cleaned diff into added/removed sections
 */
export interface ParsedDiff {
  added: string[];
  removed: string[];
  summary: string;
}

export function parseDiff(cleanedDiff: string): ParsedDiff {
  const lines = cleanedDiff.split('\n');
  const added: string[] = [];
  const removed: string[] = [];

  for (const line of lines) {
    if (line.startsWith('> ')) {
      added.push(line.slice(2));
    } else if (line.startsWith('< ')) {
      removed.push(line.slice(2));
    }
  }

  // Generate summary
  let summary = '';
  if (added.length > 0 && removed.length > 0) {
    summary = `+${added.length} lines, -${removed.length} lines`;
  } else if (added.length > 0) {
    summary = `+${added.length} lines added`;
  } else if (removed.length > 0) {
    summary = `-${removed.length} lines removed`;
  } else {
    summary = 'No significant changes';
  }

  return { added, removed, summary };
}

/**
 * Full workflow: extract, diff, clean, and parse
 */
export async function getPromptChanges(
  oldVersion: string,
  newVersion: string
): Promise<ParsedDiff & { raw: string }> {
  const rawDiff = await diffPrompts(oldVersion, newVersion);
  const cleaned = cleanPromptDiff(rawDiff);
  const parsed = parseDiff(cleaned);

  return {
    ...parsed,
    raw: cleaned,
  };
}

/**
 * Cleanup temp files
 */
export async function cleanup(): Promise<void> {
  try {
    const files = await readdir(WORK_DIR);
    for (const file of files) {
      if (file.startsWith('prompts-') && file.endsWith('.md')) {
        await unlink(join(WORK_DIR, file));
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}
