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
    // A timeout kills only the shell. Its own process group lets the whole
    // tree be reaped, deliberately including background processes left after a
    // normal exit. Commands that call setsid/setpgid leave the group and escape.
    const options = {
      cwd,
      shell: true,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf-8' as const,
      env: process.env,
      // spawnSync honors detached at runtime; its option types omit it.
      detached: process.platform !== 'win32',
    };
    const res = spawnSync(command, options);
    if (res.pid && process.platform !== 'win32') {
      try {
        process.kill(-res.pid, 'SIGKILL');
      } catch {
        // The group is already empty.
      }
    }

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

/** Dependency and runtime directories stay out of patches so a merge cannot rewrite them. */
export const PATCH_EXCLUDES = [
  ':(exclude).pi',
  ':(exclude).swarm',
  ':(exclude)BLACKBOARD.md',
  ':(exclude)node_modules',
];

/**
 * Generate a .patch artifact from git diff HEAD and save to .pi/messenger/artifacts/<taskId>.patch.
 * Returns the relative path to the generated patch file, or null if no diff or not in git.
 */
export function generatePatch(cwd: string, taskId: string, outputRoot?: string): string | null {
  const gitCheck = spawnSync('git rev-parse --is-inside-work-tree', {
    cwd,
    shell: true,
    encoding: 'utf-8',
  });
  if (gitCheck.status !== 0 || gitCheck.stdout.trim() !== 'true') {
    return null;
  }

  // Intent-to-add captures new source files; without it they would silently
  // drop out of a patch that is still merged. Only listed files are added,
  // because git add exits 1 when an excluded path is also gitignored.
  const listed = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...PATCH_EXCLUDES],
    { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }
  );
  const added =
    listed.status === 0 && listed.stdout
      ? spawnSync('git', ['add', '-N', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          cwd,
          input: listed.stdout,
          encoding: 'utf-8',
        })
      : listed;
  if (added.status !== 0)
    throw new Error(`Failed to generate patch: git add -N failed: ${added.stderr || added.error}`);

  try {
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
