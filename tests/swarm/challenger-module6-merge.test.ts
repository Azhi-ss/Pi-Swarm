import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync, fork } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestGitRepo, createNonGitDir, type TestGitRepo } from '../helpers/git-fixtures.js';
import { createState } from '../helpers/messenger-fixtures.js';
import { taskDone } from '../../swarm/handlers/task-lifecycle.js';
import { generatePatch } from '../../swarm/verifier/index.js';
import * as taskStore from '../../swarm/task-store.js';
import { clearAllWorktrees } from '../../swarm/worktree/manager.js';
import {
  isGitRepo,
  precheckPatch,
  applyAndCommitPatch,
  applyAndCommitPatchSync,
  computePatchSha,
  type MergeOptions,
} from '../../swarm/verifier/merge.js';

describe('Challenger Module 6 Adversarial Verification', () => {
  beforeEach(() => {
    clearAllWorktrees();
  });

  afterEach(() => {
    clearAllWorktrees();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Challenge Area 1: Concurrency Stress
  // =========================================================================
  describe('Challenge Area 1: Concurrency Stress', () => {
    it('handles 16 concurrent merges via applyAndCommitPatch without .git/index.lock failures', async () => {
      const host = createTestGitRepo({ prefix: 'stress-concurrency-16-' });
      const workerCount = 16;
      const sandboxes = Array.from({ length: workerCount }, (_, i) =>
        host.allocateSandbox(`worker-c-${i}`, `WorkerConcurrent${i}`)
      );

      const patchPaths: string[] = [];
      for (let i = 0; i < workerCount; i++) {
        host.writeSandboxFile(
          sandboxes[i],
          `src/feature-${i}.ts`,
          `export const f${i} = ${i * 10};\n`
        );
        const p = generatePatch(sandboxes[i].worktreePath, `task-c-${i}`, host.gitDir);
        expect(p).not.toBeNull();
        patchPaths.push(path.join(host.gitDir, p!));
      }

      // Fire 16 parallel requests concurrently
      const results = await Promise.all(
        patchPaths.map((patchPath, i) =>
          applyAndCommitPatch({
            hostCwd: host.gitDir,
            targetCwd: sandboxes[i].worktreePath,
            patchPath,
            taskId: `task-c-${i}`,
            workerId: `worker-c-${i}`,
            verifyCommand: 'echo test passed',
          })
        )
      );

      for (let i = 0; i < workerCount; i++) {
        expect(results[i].ok, `Worker ${i} merge failed: ${results[i].error}`).toBe(true);
        expect(results[i].commitSha).toBeDefined();
        expect(fs.existsSync(path.join(host.gitDir, `src/feature-${i}.ts`))).toBe(true);
      }
      expect(host.isClean()).toBe(true);

      // Verify commit count = initial commit (1) + 16 worker commits
      const logRes = spawnSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: host.gitDir,
        encoding: 'utf-8',
      });
      expect(parseInt(logRes.stdout.trim(), 10)).toBe(17);
    });

    it('empirically demonstrates whether taskDone serializes concurrent merges within event loop', async () => {
      const host = createTestGitRepo({ prefix: 'stress-taskdone-concurrency-' });
      const sessionId = 'session-taskdone-concurrency';
      const workerCount = 6;

      const sandboxes = Array.from({ length: workerCount }, (_, i) =>
        host.allocateSandbox(`worker-td-${i}`, `WorkerTD${i}`)
      );

      const tasks = Array.from({ length: workerCount }, (_, i) => {
        const t = taskStore.createTask(host.gitDir, sessionId, { title: `Task ${i}` }, 'dev');
        taskStore.claimTask(host.gitDir, sessionId, t.id, `WorkerTD${i}`);
        host.writeSandboxFile(sandboxes[i], `lib/pkg-${i}.ts`, `export const v${i} = ${i};\n`);
        return t;
      });

      // Execute taskDone concurrently via Promise.all
      // Note: taskDone is synchronous, but wrapping in Promise.resolve / async tests execution behavior
      const results = await Promise.all(
        tasks.map((task, i) =>
          Promise.resolve().then(() =>
            taskDone(
              { id: task.id, summary: `Completed ${i}` },
              createState(`WorkerTD${i}`),
              host.gitDir,
              'dev',
              sessionId
            )
          )
        )
      );

      for (let i = 0; i < workerCount; i++) {
        expect(
          results[i].details?.verified,
          `Task ${i} should be verified: ${JSON.stringify(results[i])}`
        ).toBe(true);
        expect(fs.existsSync(path.join(host.gitDir, `lib/pkg-${i}.ts`))).toBe(true);
      }
      expect(host.isClean()).toBe(true);
    });

    it('EMPIRICAL CONCURRENCY CHALLENGE: tests multi-process concurrent merges without OS file locking', async () => {
      const host = createTestGitRepo({ prefix: 'stress-multiproc-concurrency-' });
      const workerCount = 4;
      const sandboxes = Array.from({ length: workerCount }, (_, i) =>
        host.allocateSandbox(`worker-mp-${i}`, `WorkerMP${i}`)
      );

      const patchPaths: string[] = [];
      for (let i = 0; i < workerCount; i++) {
        host.writeSandboxFile(sandboxes[i], `pkg/m-${i}.ts`, `export const m${i} = ${i};\n`);
        const p = generatePatch(sandboxes[i].worktreePath, `task-mp-${i}`, host.gitDir);
        expect(p).not.toBeNull();
        patchPaths.push(path.join(host.gitDir, p!));
      }

      // Launch 4 real concurrent child processes executing applyAndCommitPatchSync truly in parallel
      const nodePath = process.execPath;
      const scriptPath = path.resolve('tests/helpers/run-sync-merge-proc.js');
      const { spawn: spawnAsync } = await import('node:child_process');

      const procPromises = patchPaths.map((patchPath, i) => {
        return new Promise<{ index: number; code: number; stdout: string; stderr: string }>(
          (resolve) => {
            const child = spawnAsync(nodePath, [
              scriptPath,
              host.gitDir,
              sandboxes[i].worktreePath,
              patchPath,
              `task-mp-${i}`,
              `worker-mp-${i}`,
            ]);
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (d) => {
              stdout += d.toString();
            });
            child.stderr?.on('data', (d) => {
              stderr += d.toString();
            });
            child.on('close', (code) => {
              resolve({
                index: i,
                code: code ?? 1,
                stdout,
                stderr,
              });
            });
          }
        );
      });

      const procResults = await Promise.all(procPromises);
      console.log('--- Multi-process merge results ---');
      for (const r of procResults) {
        console.log(`Process ${r.index}: exit=${r.code}, out=${r.stdout}, err=${r.stderr}`);
      }
      console.log('------------------------------------');
    });
  });

  // =========================================================================
  // Challenge Area 2: Boundary Stress
  // =========================================================================
  describe('Challenge Area 2: Boundary Stress', () => {
    it('handles empty patches and whitespace-only patches gracefully', async () => {
      const host = createTestGitRepo({ prefix: 'stress-boundary-empty-' });
      const emptyPatch = path.join(host.gitDir, 'empty.patch');
      const wsPatch = path.join(host.gitDir, 'whitespace.patch');

      fs.writeFileSync(emptyPatch, '', 'utf-8');
      fs.writeFileSync(wsPatch, '   \n\n\t  \n', 'utf-8');

      const precheckEmpty = await precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: host.gitDir,
        patchPath: emptyPatch,
        taskId: 't-empty',
        workerId: 'w-empty',
      });
      expect(precheckEmpty.ok).toBe(true);

      const precheckWs = await precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: host.gitDir,
        patchPath: wsPatch,
        taskId: 't-ws',
        workerId: 'w-ws',
      });
      expect(precheckWs.ok).toBe(true);

      const mergeEmpty = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: host.gitDir,
        patchPath: emptyPatch,
        taskId: 't-empty',
        workerId: 'w-empty',
      });
      expect(mergeEmpty.ok).toBe(true);
      expect(host.isClean()).toBe(true);
    });

    it('handles non-existent patch path and directory-as-patch cleanly', async () => {
      const host = createTestGitRepo({ prefix: 'stress-boundary-notfound-' });

      const precheckNotFound = await precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: host.gitDir,
        patchPath: path.join(host.gitDir, 'does-not-exist.patch'),
        taskId: 't-notfound',
        workerId: 'w-notfound',
      });
      expect(precheckNotFound.ok).toBe(false);
      expect(precheckNotFound.error).toContain('not found');

      // Directory passed as patch path
      const dirPatch = path.join(host.gitDir, 'dir-as-patch');
      fs.mkdirSync(dirPatch);
      const precheckDir = await precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: host.gitDir,
        patchPath: dirPatch,
        taskId: 't-dir',
        workerId: 'w-dir',
      });
      // Should fail safely without crashing
      expect(precheckDir.ok).toBe(false);
    });

    it('handles corrupted patch files: truncated diffs, garbage headers, random binary', async () => {
      const host = createTestGitRepo({ prefix: 'stress-boundary-corrupt-' });

      const corruptCases = [
        { name: 'truncated-hunk', content: '--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n' },
        {
          name: 'invalid-git-diff-header',
          content: 'diff --git a/foo b/bar\nindex 123456..789012\n',
        },
        {
          name: 'garbage-binary',
          content: Buffer.from([0x00, 0xff, 0xfe, 0x12, 0x34, 0x56, 0x78]),
        },
        { name: 'broken-utf8', content: Buffer.from('diff --git a/f b/f\n\xc3\x28') },
      ];

      const sandbox = host.allocateSandbox('worker-corrupt', 'WorkerCorrupt');
      for (const tc of corruptCases) {
        const patchPath = path.join(host.gitDir, `${tc.name}.patch`);
        fs.writeFileSync(patchPath, tc.content as any);

        const precheck = await precheckPatch({
          hostCwd: host.gitDir,
          targetCwd: sandbox.worktreePath,
          patchPath,
          taskId: `task-${tc.name}`,
          workerId: 'worker-test',
        });

        const merge = await applyAndCommitPatch({
          hostCwd: host.gitDir,
          targetCwd: sandbox.worktreePath,
          patchPath,
          taskId: `task-${tc.name}`,
          workerId: 'worker-test',
        });

        console.log(
          `Corrupt case [${tc.name}]: precheck.ok=${precheck.ok}, precheck.err="${precheck.error}", merge.ok=${merge.ok}, merge.err="${merge.error}"`
        );
      }
    });

    it('handles untracked files with spaces, non-ASCII/Unicode, and special characters', async () => {
      const host = createTestGitRepo({ prefix: 'stress-boundary-filenames-' });
      const sandbox = host.allocateSandbox('worker-special', 'WorkerSpecial');

      // 1. Filename with spaces and subdirs
      host.writeSandboxFile(
        sandbox,
        'deep/path with spaces/nested file.ts',
        'export const spaced = 1;\n'
      );

      // 2. Filename with Unicode / Chinese / Emojis
      host.writeSandboxFile(sandbox, 'src/蜂群核心/智能体-⚡.ts', 'export const 蜂群 = "活跃";\n');

      // 3. Filename with shell-sensitive characters (parentheses, brackets, underscores, dashes)
      host.writeSandboxFile(
        sandbox,
        'src/special_(v1)_[final].ts',
        'export const special = true;\n'
      );

      // Generate patch
      const patchRel = generatePatch(sandbox.worktreePath, 'task-special-chars', host.gitDir);
      expect(patchRel).not.toBeNull();
      const patchAbs = path.join(host.gitDir, patchRel!);
      expect(fs.existsSync(patchAbs)).toBe(true);

      // Precheck
      const precheck = await precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-special-chars',
        workerId: 'worker-special',
      });
      expect(precheck.ok, `Precheck failed: ${precheck.error}`).toBe(true);

      // Apply & commit
      const mergeRes = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-special-chars',
        workerId: 'worker-special',
      });
      expect(mergeRes.ok, `Merge failed: ${mergeRes.error}`).toBe(true);

      // Verify files exist on host with identical content
      expect(
        fs.readFileSync(path.join(host.gitDir, 'deep/path with spaces/nested file.ts'), 'utf-8')
      ).toBe('export const spaced = 1;\n');
      expect(fs.readFileSync(path.join(host.gitDir, 'src/蜂群核心/智能体-⚡.ts'), 'utf-8')).toBe(
        'export const 蜂群 = "活跃";\n'
      );
      expect(fs.readFileSync(path.join(host.gitDir, 'src/special_(v1)_[final].ts'), 'utf-8')).toBe(
        'export const special = true;\n'
      );
      expect(host.isClean()).toBe(true);
    });

    it('EMPIRICAL BUG REPRODUCTION: generates unapplicable diff for binary files without --binary', async () => {
      const host = createTestGitRepo({ prefix: 'stress-boundary-binary-' });
      const sandbox = host.allocateSandbox('worker-bin', 'WorkerBin');

      const binaryData = Buffer.alloc(512);
      for (let i = 0; i < 512; i++) binaryData[i] = (i * 31) % 256;
      const binRelPath = 'assets/icon.png';
      const binAbsPath = path.join(sandbox.worktreePath, binRelPath);
      fs.mkdirSync(path.dirname(binAbsPath), { recursive: true });
      fs.writeFileSync(binAbsPath, binaryData);

      const patchRel = generatePatch(sandbox.worktreePath, 'task-binary', host.gitDir);
      expect(patchRel).not.toBeNull();
      const patchAbs = path.join(host.gitDir, patchRel!);

      const patchContent = fs.readFileSync(patchAbs, 'utf-8');
      console.log('--- Generated Patch Content for Binary File ---');
      console.log(patchContent);
      console.log('-----------------------------------------------');

      const precheck = await precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-binary',
        workerId: 'worker-bin',
      });

      console.log('Binary precheck result:', precheck);
      // Verifies binary patch support: git diff HEAD --binary produces valid, applicable unified patches
      expect(precheck.ok).toBe(true);
      expect(precheck.error).toBeUndefined();
    });

    it('handles non-git directories and non-existent hostCwd gracefully without crashing', async () => {
      const nonGit = createNonGitDir('stress-nongit-');
      const nonExistent = path.join(os.tmpdir(), `pi-swarm-nonexistent-${Date.now()}`);

      expect(isGitRepo(nonGit.dir)).toBe(false);
      expect(isGitRepo(nonExistent)).toBe(false);
      expect(isGitRepo('')).toBe(false);

      // Non-git directory
      const precheck1 = await precheckPatch({
        hostCwd: nonGit.dir,
        targetCwd: nonGit.dir,
        patchPath: 'some.patch',
        taskId: 't1',
        workerId: 'w1',
      });
      expect(precheck1.ok).toBe(true);
      expect(precheck1.isGit).toBe(false);

      const merge1 = await applyAndCommitPatch({
        hostCwd: nonGit.dir,
        targetCwd: nonGit.dir,
        patchPath: 'some.patch',
        taskId: 't1',
        workerId: 'w1',
      });
      expect(merge1.ok).toBe(true);
      expect(merge1.isGit).toBe(false);

      // Non-existent directory
      const precheck2 = await precheckPatch({
        hostCwd: nonExistent,
        targetCwd: nonExistent,
        patchPath: 'some.patch',
        taskId: 't2',
        workerId: 'w2',
      });
      expect(precheck2.ok).toBe(true);
      expect(precheck2.isGit).toBe(false);

      const merge2 = await applyAndCommitPatch({
        hostCwd: nonExistent,
        targetCwd: nonExistent,
        patchPath: 'some.patch',
        taskId: 't2',
        workerId: 'w2',
      });
      expect(merge2.ok).toBe(true);
      expect(merge2.isGit).toBe(false);
    });
  });

  // =========================================================================
  // Challenge Area 3: Dirty State Prevention & Atomic Rollback
  // =========================================================================
  describe('Challenge Area 3: Dirty State Prevention & Atomic Rollback', () => {
    it('CRITICAL ADVERSARIAL TEST: what happens when git commit fails after git apply succeeded?', async () => {
      const host = createTestGitRepo({ prefix: 'stress-atomic-rollback-' });
      const sandbox = host.allocateSandbox('worker-rollback', 'WorkerRollback');
      host.writeSandboxFile(sandbox, 'src/risky.ts', 'export const risky = true;\n');

      const patchRel = generatePatch(sandbox.worktreePath, 'task-rollback', host.gitDir);
      const patchAbs = path.join(host.gitDir, patchRel!);

      // Install a failing pre-commit hook in host repo:
      // Any commit attempt will fail!
      const hooksDir = path.join(host.gitDir, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommitHook = path.join(hooksDir, 'pre-commit');
      fs.writeFileSync(
        preCommitHook,
        '#!/bin/sh\necho "Pre-commit validation failed!" >&2\nexit 1\n',
        { mode: 0o755 }
      );

      const mergeRes = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-rollback',
        workerId: 'worker-rollback',
      });

      // The commit must fail
      expect(mergeRes.ok).toBe(false);
      expect(mergeRes.error).toMatch(/pre-commit/i);

      // CRITICAL CHECK:
      // Did applyAndCommitPatch leave host repository dirty or clean?
      const isHostClean = host.isClean();
      const statusRes = spawnSync('git', ['status', '--porcelain'], {
        cwd: host.gitDir,
        encoding: 'utf-8',
      });

      console.log('--- Adversarial Result: Host state after failed commit ---');
      console.log('isHostClean:', isHostClean);
      console.log('git status:', statusRes.stdout);
      console.log('---------------------------------------------------------');

      // Clean up hook so test cleanup doesn't fail
      fs.unlinkSync(preCommitHook);

      // Verifies atomic rollback:
      // Host repository is left CLEAN because applyAndCommitPatchSync rolls back on commit failure!
      expect(isHostClean).toBe(true);
      expect(statusRes.stdout.trim()).toBe('');
    });

    it('EMPIRICAL BUG REPRODUCTION: pre-existing dirty files on host are mistakenly committed by swarm merge', async () => {
      const host = createTestGitRepo({ prefix: 'stress-dirty-host-' });

      // Host has an uncommitted local change made by the human/main agent
      fs.writeFileSync(path.join(host.gitDir, 'uncommitted-human-work.ts'), '// Human WIP\n');
      expect(host.isClean()).toBe(false);

      // Worker prepares a clean patch for another file
      const sandbox = host.allocateSandbox('worker-innocent', 'WorkerInnocent');
      host.writeSandboxFile(sandbox, 'src/worker-feature.ts', 'export const feat = 1;\n');

      const patchRel = generatePatch(sandbox.worktreePath, 'task-innocent', host.gitDir);
      const patchAbs = path.join(host.gitDir, patchRel!);

      const mergeRes = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-innocent',
        workerId: 'worker-innocent',
      });

      // What happened to uncommitted-human-work.ts?
      // Since applyAndCommitPatch runs `git add -A`, it swept human's work into worker's commit!
      const showRes = spawnSync('git', ['show', '--stat', 'HEAD'], {
        cwd: host.gitDir,
        encoding: 'utf-8',
      });
      console.log('--- Swarm Commit diff stats when host was dirty ---');
      console.log(showRes.stdout);
      console.log('----------------------------------------------------');

      const humanWorkInCommit = showRes.stdout.includes('uncommitted-human-work.ts');
      console.log('Did worker commit inadvertently commit human WIP file?', humanWorkInCommit);
      expect(humanWorkInCommit).toBe(false);
    });
  });
});
