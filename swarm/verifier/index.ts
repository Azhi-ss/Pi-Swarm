import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface VerifierResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
  error?: string;
}

/**
 * Detect project test command from package.json if present and not a dummy placeholder.
 */
export function detectProjectTestCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const testScript = pkg?.scripts?.test;
    if (!testScript || typeof testScript !== 'string') return null;
    if (testScript.includes('no test specified')) return null;
    return 'npm test';
  } catch {
    return null;
  }
}

/**
 * Execute verification command synchronously with timeout and environment isolation.
 */
export function runVerification(
  cwd: string,
  command: string,
  timeoutMs: number = 60_000
): VerifierResult {
  const start = Date.now();
  let exitCode = 1;
  let stdout = '';
  let stderr = '';
  let errorMsg: string | undefined;

  try {
    const res = spawnSync(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf-8',
      env: process.env,
    });

    stdout = res.stdout ?? '';
    stderr = res.stderr ?? '';

    if (res.error) {
      if ((res.error as any).code === 'ETIMEDOUT') {
        exitCode = 124;
        errorMsg = `Verification command timed out after ${timeoutMs}ms`;
      } else {
        exitCode = res.status ?? 1;
        errorMsg = res.error.message;
      }
    } else {
      exitCode = res.status ?? 0;
    }
  } catch (err: any) {
    exitCode = 1;
    errorMsg = err?.message ?? String(err);
  }

  const durationMs = Date.now() - start;
  const passed = exitCode === 0;

  return {
    passed,
    exitCode,
    stdout,
    stderr,
    durationMs,
    command,
    error: errorMsg,
  };
}

/**
 * Generate a .patch artifact from git diff HEAD and save to .pi/messenger/artifacts/<taskId>.patch.
 * Returns the relative path to the generated patch file, or null if no diff or not in git.
 */
export function generatePatch(cwd: string, taskId: string, outputRoot?: string): string | null {
  try {
    const gitCheck = spawnSync('git rev-parse --is-inside-work-tree', {
      cwd,
      shell: true,
      encoding: 'utf-8',
    });
    if (gitCheck.status !== 0 || gitCheck.stdout.trim() !== 'true') {
      return null;
    }

    // Run git add -N . so untracked files are captured as unified diffs
    spawnSync('git add -N .', {
      cwd,
      shell: true,
      encoding: 'utf-8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const diffRes = spawnSync('git diff HEAD --binary', {
      cwd,
      shell: true,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });

    const diffContent = diffRes.stdout ?? '';

    if (!diffContent.trim()) {
      return null;
    }

    const destRoot = outputRoot || cwd;
    const artifactsDir = path.join(destRoot, '.pi', 'messenger', 'artifacts');
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }

    const patchFileName = `${taskId}.patch`;
    const patchFilePath = path.join(artifactsDir, patchFileName);
    fs.writeFileSync(patchFilePath, diffContent, 'utf-8');

    return path.join('.pi', 'messenger', 'artifacts', patchFileName);
  } catch {
    return null;
  }
}

export * from './merge.js';
