import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface MergeOptions {
  hostCwd: string;
  targetCwd: string;
  patchPath: string;
  taskId: string;
  workerId: string;
  verifyCommand?: string;
  patchSha?: string;
  summary?: string;
}

export interface PrecheckResult {
  ok: boolean;
  isGit: boolean;
  error?: string;
}

export interface MergeResult {
  ok: boolean;
  isGit: boolean;
  commitSha?: string;
  error?: string;
}

/**
 * Checks whether the given directory is inside a valid git repository with a resolvable working tree.
 */
export function isGitRepo(cwd: string): boolean {
  if (!cwd || !fs.existsSync(cwd)) return false;
  try {
    const res = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return res.status === 0 && res.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Computes SHA-256 hash of a patch file or string content.
 */
export function computePatchSha(patchPathOrContent: string): string {
  try {
    if (fs.existsSync(patchPathOrContent) && fs.statSync(patchPathOrContent).isFile()) {
      const content = fs.readFileSync(patchPathOrContent);
      return crypto.createHash('sha256').update(content).digest('hex');
    }
    return crypto.createHash('sha256').update(patchPathOrContent, 'utf-8').digest('hex');
  } catch {
    return crypto.createHash('sha256').update(patchPathOrContent, 'utf-8').digest('hex');
  }
}

/**
 * Pre-checks a patch against the host repository using git apply --check.
 * If hostCwd is not a git repository, returns { ok: true, isGit: false }.
 */
export function precheckPatchSync(options: MergeOptions): PrecheckResult {
  if (!isGitRepo(options.hostCwd)) {
    return { ok: true, isGit: false };
  }

  if (!options.patchPath || options.patchPath.trim() === '') {
    return { ok: true, isGit: true };
  }

  const resolvedPatchPath = path.isAbsolute(options.patchPath)
    ? options.patchPath
    : path.resolve(options.hostCwd, options.patchPath);

  if (!fs.existsSync(resolvedPatchPath)) {
    return { ok: false, isGit: true, error: `Patch file not found: ${options.patchPath}` };
  }

  try {
    const patchContent = fs.readFileSync(resolvedPatchPath, 'utf-8');
    if (patchContent.trim().length === 0) {
      return { ok: true, isGit: true };
    }

    const res = spawnSync('git', ['apply', '--check', resolvedPatchPath], {
      cwd: options.hostCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (res.status === 0) {
      return { ok: true, isGit: true };
    }

    const errorMsg = (res.stderr || res.stdout || '').trim() || 'git apply --check failed';
    return { ok: false, isGit: true, error: errorMsg };
  } catch (err: any) {
    return { ok: false, isGit: true, error: err?.message || String(err) };
  }
}

export async function precheckPatch(options: MergeOptions): Promise<PrecheckResult> {
  return precheckPatchSync(options);
}

/**
 * In-memory Promise mutex to serialize merge and commit operations,
 * preventing .git/index.lock collisions across concurrent workers.
 */
class MergeMutex {
  private queue: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => fn());
    this.queue = next.then(
      () => {},
      () => {}
    );
    return next;
  }
}

const mergeMutex = new MergeMutex();

function rollbackHostRepo(hostCwd: string): void {
  try {
    spawnSync('git', ['reset', '--hard', 'HEAD'], {
      cwd: hostCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnSync('git', ['clean', '-fd'], {
      cwd: hostCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Best effort rollback
  }
}

export function extractFilesFromPatch(patchPath: string, hostCwd: string): string[] {
  try {
    const res = spawnSync('git', ['apply', '--numstat', '-z', patchPath], {
      cwd: hostCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status === 0 && res.stdout) {
      const files: string[] = [];
      const entries = res.stdout.split('\0');
      for (const entry of entries) {
        if (!entry.trim()) continue;
        const parts = entry.split('\t');
        if (parts.length >= 3) {
          files.push(parts[2]);
        }
      }
      if (files.length > 0) return files;
    }
  } catch {
    // Fallback below
  }

  try {
    const content = fs.readFileSync(patchPath, 'utf-8');
    const files = new Set<string>();
    const regex = /^diff --git (?:a\/|"a\/)(.+?)(?:"| ) (?:b\/|"b\/)(.+?)(?:"|)$/gm;
    let match;
    while ((match = regex.exec(content)) !== null) {
      files.add(match[2].replace(/^b\//, '').replace(/"$/, ''));
    }
    return Array.from(files);
  } catch {
    return [];
  }
}

/**
 * Applies the patch and commits atomically to the host repository's current branch (synchronous execution).
 */
export function applyAndCommitPatchSync(options: MergeOptions): MergeResult {
  if (!isGitRepo(options.hostCwd)) {
    return { ok: true, isGit: false };
  }

  try {
    const isSameCwd =
      options.targetCwd &&
      options.hostCwd &&
      path.resolve(options.targetCwd) === path.resolve(options.hostCwd);

    if (!isSameCwd && options.patchPath && options.patchPath.trim() !== '') {
      const resolvedPatchPath = path.isAbsolute(options.patchPath)
        ? options.patchPath
        : path.resolve(options.hostCwd, options.patchPath);

      if (!fs.existsSync(resolvedPatchPath)) {
        return { ok: false, isGit: true, error: `Patch file not found: ${options.patchPath}` };
      }

      const patchContent = fs.readFileSync(resolvedPatchPath, 'utf-8');
      if (patchContent.trim().length > 0) {
        // Selective staging: apply directly to index and working tree, avoiding git add -A
        const applyRes = spawnSync(
          'git',
          ['apply', '--index', '--whitespace=nowarn', resolvedPatchPath],
          {
            cwd: options.hostCwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );

        if (applyRes.status !== 0) {
          rollbackHostRepo(options.hostCwd);
          const errMsg = (applyRes.stderr || applyRes.stdout || '').trim() || 'git apply failed';
          return { ok: false, isGit: true, error: errMsg };
        }
      }
    } else if (isSameCwd) {
      if (options.patchPath && options.patchPath.trim() !== '') {
        // In same-directory mode, selectively stage only files touched by the patch
        const resolvedPatchPath = path.isAbsolute(options.patchPath)
          ? options.patchPath
          : path.resolve(options.hostCwd, options.patchPath);

        if (fs.existsSync(resolvedPatchPath)) {
          const touchedFiles = extractFilesFromPatch(resolvedPatchPath, options.hostCwd);
          if (touchedFiles.length > 0) {
            const addRes = spawnSync('git', ['add', '--', ...touchedFiles], {
              cwd: options.hostCwd,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            if (addRes.status !== 0) {
              rollbackHostRepo(options.hostCwd);
              const errMsg = (addRes.stderr || addRes.stdout || '').trim() || 'git add failed';
              return { ok: false, isGit: true, error: errMsg };
            }
          }
        }
      } else {
        // Direct commit mode in same cwd without patch file (e.g. Test F7)
        spawnSync('git', ['add', '-A'], {
          cwd: options.hostCwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    }

    // Check if anything is staged for commit
    const stagedCheck = spawnSync('git', ['diff', '--cached', '--quiet'], {
      cwd: options.hostCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Exit code 0 means index has no staged changes (nothing to commit)
    if (stagedCheck.status === 0) {
      const revRes = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: options.hostCwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const commitSha = revRes.stdout.trim() || undefined;
      return {
        ok: true,
        isGit: true,
        commitSha,
      };
    }

    // Compute patchSha if not provided
    let patchSha = options.patchSha;
    if (!patchSha && options.patchPath) {
      const resolvedPatchPath = path.isAbsolute(options.patchPath)
        ? options.patchPath
        : path.resolve(options.hostCwd, options.patchPath);
      if (fs.existsSync(resolvedPatchPath)) {
        patchSha = computePatchSha(resolvedPatchPath);
      }
    }

    const verifyCommand = options.verifyCommand || 'npm test';
    const timestamp = new Date().toISOString();
    const subject = `feat(swarm): verify & merge ${options.taskId} by ${options.workerId} [Exit 0]`;

    const bodyLines = [
      `Task: ${options.taskId}`,
      `Worker: ${options.workerId}`,
      `Verify Command: ${verifyCommand}`,
      `Exit Code: 0`,
      `Patch SHA: ${patchSha || 'unknown'}`,
      `Artifact: ${options.patchPath}`,
      `Timestamp: ${timestamp}`,
    ];

    if (options.summary) {
      bodyLines.push('', 'Summary:', options.summary);
    }

    const body = bodyLines.join('\n');

    // Commit with fallback git user config for environments without global config
    const commitRes = spawnSync(
      'git',
      [
        '-c',
        'user.name=Pi-Swarm',
        '-c',
        'user.email=swarm@pi.local',
        'commit',
        '-m',
        subject,
        '-m',
        body,
      ],
      {
        cwd: options.hostCwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    if (commitRes.status !== 0) {
      rollbackHostRepo(options.hostCwd);
      const errMsg = (commitRes.stderr || commitRes.stdout || '').trim() || 'git commit failed';
      return { ok: false, isGit: true, error: errMsg };
    }

    // Extract commit SHA
    const revRes = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: options.hostCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (revRes.status !== 0) {
      rollbackHostRepo(options.hostCwd);
      const errMsg = (revRes.stderr || revRes.stdout || '').trim() || 'git rev-parse HEAD failed';
      return { ok: false, isGit: true, error: errMsg };
    }

    const commitSha = revRes.stdout.trim();
    return {
      ok: true,
      isGit: true,
      commitSha,
    };
  } catch (err: any) {
    rollbackHostRepo(options.hostCwd);
    return { ok: false, isGit: true, error: err?.message || String(err) };
  }
}

/**
 * Applies the patch and commits atomically to the host repository's current branch.
 * Wrapped in an in-memory Promise mutex queue to serialize operations and avoid .git/index.lock collisions.
 */
export async function applyAndCommitPatch(options: MergeOptions): Promise<MergeResult> {
  return mergeMutex.runExclusive(async () => {
    return applyAndCommitPatchSync(options);
  });
}
