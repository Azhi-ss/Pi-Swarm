import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestGitRepo, type TestGitRepo } from '../helpers/git-fixtures.js';
import { generatePatch } from '../../swarm/verifier/index.js';
import { clearAllWorktrees } from '../../swarm/worktree/manager.js';
import {
  precheckPatch,
  applyAndCommitPatch,
  applyAndCommitPatchSync,
  extractFilesFromPatch,
} from '../../swarm/verifier/merge.js';

describe('Adversarial Deep Challenge: Issue #2 Clean Path & Atomic Rollback', () => {
  beforeEach(() => {
    clearAllWorktrees();
  });

  afterEach(() => {
    clearAllWorktrees();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Commit Failure & Atomic Rollback
  // =========================================================================
  describe('1. Commit Failure & Atomic Rollback', () => {
    it('ensures host is 100% clean with zero staged or untracked files when pre-commit hook fails', async () => {
      const host = createTestGitRepo({ prefix: 'deep-rollback-hook-' });

      // Host has existing files and a commit
      fs.mkdirSync(path.join(host.gitDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(host.gitDir, 'src', 'existing.ts'),
        'export const existing = 1;\n'
      );
      fs.writeFileSync(path.join(host.gitDir, 'src', 'to-delete.ts'), 'export const del = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: host.gitDir });
      spawnSync('git', ['commit', '-m', 'add base files'], { cwd: host.gitDir });

      const sandbox = host.allocateSandbox('worker-deep-rb', 'WorkerDeepRb');

      // Worker modifies existing, deletes to-delete, and creates nested directory with new files
      host.writeSandboxFile(sandbox, 'src/existing.ts', 'export const existing = 2; // mod\n');
      fs.unlinkSync(path.join(sandbox.worktreePath, 'src', 'to-delete.ts'));
      host.writeSandboxFile(sandbox, 'src/deep/nested/feature.ts', 'export const nested = true;\n');
      host.writeSandboxFile(sandbox, 'assets/icons/app.png', 'PNGDATA');

      const patchRel = generatePatch(sandbox.worktreePath, 'task-deep-rb', host.gitDir);
      expect(patchRel).not.toBeNull();
      const patchAbs = path.join(host.gitDir, patchRel!);

      // Install failing pre-commit hook
      const hooksDir = path.join(host.gitDir, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'pre-commit');
      fs.writeFileSync(hookPath, '#!/bin/sh\necho "FORCED PRE-COMMIT HOOK FAILURE" >&2\nexit 1\n', {
        mode: 0o755,
      });

      const result = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-deep-rb',
        workerId: 'worker-deep-rb',
      });

      // Commit must fail
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/PRE-COMMIT HOOK FAILURE/i);

      // Clean up hook
      fs.unlinkSync(hookPath);

      // VERIFY 100% CLEANLINESS
      const statusRes = spawnSync('git', ['status', '--porcelain'], {
        cwd: host.gitDir,
        encoding: 'utf-8',
      });
      expect(statusRes.stdout.trim()).toBe('');
      expect(host.isClean()).toBe(true);

      // Verify tracked files restored
      expect(fs.readFileSync(path.join(host.gitDir, 'src', 'existing.ts'), 'utf-8')).toBe(
        'export const existing = 1;\n'
      );
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'to-delete.ts'))).toBe(true);

      // Verify untracked nested directories and files completely removed
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'deep'))).toBe(false);
      expect(fs.existsSync(path.join(host.gitDir, 'assets'))).toBe(false);
    });

    it('rolls back cleanly if git apply fails due to corrupted/unapplicable patch', async () => {
      const host = createTestGitRepo({ prefix: 'deep-rollback-apply-fail-' });
      const sandbox = host.allocateSandbox('worker-apply-fail', 'WorkerApplyFail');

      // Create a corrupted patch
      const corruptPatch = path.join(host.gitDir, 'corrupt.patch');
      fs.writeFileSync(
        corruptPatch,
        'diff --git a/bad.ts b/bad.ts\n--- a/bad.ts\n+++ b/bad.ts\n@@ -1,1 +1,1 @@\n-missing\n+added\n',
        'utf-8'
      );

      const result = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: corruptPatch,
        taskId: 'task-corrupt',
        workerId: 'worker-apply-fail',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();

      // Host must remain 100% clean
      expect(host.isClean()).toBe(true);
      const diffRes = spawnSync('git', ['diff', 'HEAD'], { cwd: host.gitDir, encoding: 'utf-8' });
      expect(diffRes.stdout.trim()).toBe('');
    });

    it('rolls back cleanly if git commit fails due to prepare-commit-msg hook rejecting commit', async () => {
      const host = createTestGitRepo({ prefix: 'deep-rollback-prepare-msg-' });
      const sandbox = host.allocateSandbox('worker-msg-fail', 'WorkerMsgFail');
      host.writeSandboxFile(sandbox, 'src/fail.ts', 'export const fail = true;\n');

      const patchRel = generatePatch(sandbox.worktreePath, 'task-msg-fail', host.gitDir);
      const patchAbs = path.join(host.gitDir, patchRel!);

      // Install prepare-commit-msg hook that fails
      const hooksDir = path.join(host.gitDir, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'prepare-commit-msg');
      fs.writeFileSync(hookPath, '#!/bin/sh\necho "COMMIT MSG REJECTED BY HOOK" >&2\nexit 2\n', {
        mode: 0o755,
      });

      const result = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-msg-fail',
        workerId: 'worker-msg-fail',
      });

      fs.unlinkSync(hookPath);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('COMMIT MSG REJECTED BY HOOK');

      // Host should be clean
      expect(host.isClean()).toBe(true);
      const statusRes = spawnSync('git', ['status', '--porcelain'], {
        cwd: host.gitDir,
        encoding: 'utf-8',
      });
      expect(statusRes.stdout.trim()).toBe('');
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'fail.ts'))).toBe(false);
    });
  });

  // =========================================================================
  // 2. Selective Staging & Preservation of Human WIP
  // =========================================================================
  describe('2. Selective Staging & Preservation of Human WIP', () => {
    it('preserves host uncommitted untracked files and unstaged modified files during external sandbox merge', async () => {
      const host = createTestGitRepo({ prefix: 'deep-selective-external-' });

      // Host has pre-existing tracked file
      fs.mkdirSync(path.join(host.gitDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(host.gitDir, 'src', 'host-base.ts'), 'export const base = 100;\n');
      spawnSync('git', ['add', '.'], { cwd: host.gitDir });
      spawnSync('git', ['commit', '-m', 'add host-base'], { cwd: host.gitDir });

      // Human/main agent creates WIP in host:
      // 1. Untracked file
      fs.writeFileSync(path.join(host.gitDir, 'human-untracked.ts'), '// Human untracked WIP\n');
      // 2. Unstaged modification to tracked file
      fs.writeFileSync(
        path.join(host.gitDir, 'src', 'host-base.ts'),
        'export const base = 999; // Human modified\n'
      );

      expect(host.isClean()).toBe(false);

      // Worker works in dedicated sandbox
      const sandbox = host.allocateSandbox('worker-sel', 'WorkerSel');
      host.writeSandboxFile(sandbox, 'src/worker-module.ts', 'export const workerMod = true;\n');

      const patchRel = generatePatch(sandbox.worktreePath, 'task-sel', host.gitDir);
      const patchAbs = path.join(host.gitDir, patchRel!);

      // Merge patch
      const mergeRes = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-sel',
        workerId: 'worker-sel',
      });

      expect(mergeRes.ok).toBe(true);
      expect(mergeRes.commitSha).toBeDefined();

      // Check the latest commit: It MUST contain ONLY worker-module.ts
      const showRes = spawnSync('git', ['show', '--stat', 'HEAD'], {
        cwd: host.gitDir,
        encoding: 'utf-8',
      });
      expect(showRes.stdout).toContain('src/worker-module.ts');
      expect(showRes.stdout).not.toContain('human-untracked.ts');
      expect(showRes.stdout).not.toContain('host-base.ts');

      // Verify human WIP was NOT destroyed and remains in working tree!
      expect(fs.existsSync(path.join(host.gitDir, 'human-untracked.ts'))).toBe(true);
      expect(fs.readFileSync(path.join(host.gitDir, 'human-untracked.ts'), 'utf-8')).toBe(
        '// Human untracked WIP\n'
      );
      expect(fs.readFileSync(path.join(host.gitDir, 'src', 'host-base.ts'), 'utf-8')).toBe(
        'export const base = 999; // Human modified\n'
      );

      // Working tree status should show only human WIP
      const statusRes = spawnSync('git', ['status', '--porcelain'], {
        cwd: host.gitDir,
        encoding: 'utf-8',
      });
      expect(statusRes.stdout).toMatch(/ M\s+src\/host-base\.ts/);
      expect(statusRes.stdout).toMatch(/\?\?\s+human-untracked\.ts/);
      expect(statusRes.stdout).not.toContain('src/worker-module.ts');
    });

    it('preserves host uncommitted WIP in same-cwd mode using extractFilesFromPatch', async () => {
      const host = createTestGitRepo({ prefix: 'deep-selective-samecwd-' });

      // Host has pre-existing tracked file
      fs.mkdirSync(path.join(host.gitDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(host.gitDir, 'src', 'app.ts'), 'export const app = 1;\n');
      spawnSync('git', ['add', '.'], { cwd: host.gitDir });
      spawnSync('git', ['commit', '-m', 'init app'], { cwd: host.gitDir });

      // Human WIP on host
      fs.writeFileSync(path.join(host.gitDir, 'human-notes.txt'), 'notes\n');
      fs.writeFileSync(path.join(host.gitDir, 'src', 'app.ts'), 'export const app = 2;\n');

      // Create a patch touching ONLY src/new-service.ts
      const patchContent = [
        'diff --git a/src/new-service.ts b/src/new-service.ts',
        'new file mode 100644',
        'index 0000000..abcdef1',
        '--- /dev/null',
        '+++ b/src/new-service.ts',
        '@@ -0,0 +1,1 @@',
        '+export const service = true;',
        '',
      ].join('\n');

      const patchPath = path.join(host.gitDir, 'service.patch');
      fs.writeFileSync(patchPath, patchContent, 'utf-8');

      // Write the file into the working tree (since in sameCwd mode, the patch represents changes already or to be staged)
      fs.writeFileSync(
        path.join(host.gitDir, 'src', 'new-service.ts'),
        'export const service = true;\n'
      );

      // Verify extractFilesFromPatch extracts exactly src/new-service.ts
      const extracted = extractFilesFromPatch(patchPath, host.gitDir);
      expect(extracted).toEqual(['src/new-service.ts']);

      // Apply in sameCwd mode
      const result = applyAndCommitPatchSync({
        hostCwd: host.gitDir,
        targetCwd: host.gitDir,
        patchPath: patchPath,
        taskId: 'task-samecwd',
        workerId: 'worker-samecwd',
      });

      expect(result.ok).toBe(true);

      // Verify commit includes ONLY src/new-service.ts
      const showRes = spawnSync('git', ['show', '--stat', 'HEAD'], {
        cwd: host.gitDir,
        encoding: 'utf-8',
      });
      expect(showRes.stdout).toContain('src/new-service.ts');
      expect(showRes.stdout).not.toContain('human-notes.txt');
      expect(showRes.stdout).not.toContain('src/app.ts');

      // Human WIP remains intact
      expect(fs.readFileSync(path.join(host.gitDir, 'human-notes.txt'), 'utf-8')).toBe('notes\n');
      expect(fs.readFileSync(path.join(host.gitDir, 'src', 'app.ts'), 'utf-8')).toBe(
        'export const app = 2;\n'
      );
    });

    it('extractFilesFromPatch accurately handles multi-file patches, deleted files, and paths with spaces', () => {
      const host = createTestGitRepo({ prefix: 'deep-extract-files-' });

      const patchContent = [
        'diff --git a/src/normal.ts b/src/normal.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/normal.ts',
        '@@ -0,0 +1 @@',
        '+export const x = 1;',
        'diff --git a/docs/file with spaces.md b/docs/file with spaces.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/docs/file with spaces.md',
        '@@ -0,0 +1 @@',
        '+# Space file',
        'diff --git a/src/old.ts b/src/old.ts',
        'deleted file mode 100644',
        '--- a/src/old.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-export const old = 1;',
        '',
      ].join('\n');

      const patchPath = path.join(host.gitDir, 'multi.patch');
      fs.writeFileSync(patchPath, patchContent, 'utf-8');

      const extracted = extractFilesFromPatch(patchPath, host.gitDir);
      expect(extracted).toContain('src/normal.ts');
      expect(extracted).toContain('docs/file with spaces.md');
      expect(extracted).toContain('src/old.ts');
    });
  });

  // =========================================================================
  // 3. Binary Files Support
  // =========================================================================
  describe('3. Binary Files Support', () => {
    it('applies patches with new, modified, and deleted binary files with byte-for-byte fidelity', async () => {
      const host = createTestGitRepo({ prefix: 'deep-binary-fidelity-' });

      // Create initial binary file in host
      const initialPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01,
      ]);
      const initialBin = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe]);
      fs.mkdirSync(path.join(host.gitDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(host.gitDir, 'assets', 'to-modify.png'), initialPng);
      fs.writeFileSync(path.join(host.gitDir, 'assets', 'to-delete.bin'), initialBin);

      spawnSync('git', ['add', '.'], { cwd: host.gitDir });
      spawnSync('git', ['commit', '-m', 'add initial binary assets'], { cwd: host.gitDir });

      // Worker in sandbox:
      // 1. Modifies to-modify.png
      // 2. Deletes to-delete.bin
      // 3. Creates new-asset.png with 1KB of binary data containing zeroes and 0xFF
      const sandbox = host.allocateSandbox('worker-bin-deep', 'WorkerBinDeep');

      const modifiedPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xaa, 0xbb, 0xcc,
      ]);
      fs.writeFileSync(path.join(sandbox.worktreePath, 'assets', 'to-modify.png'), modifiedPng);
      fs.unlinkSync(path.join(sandbox.worktreePath, 'assets', 'to-delete.bin'));

      const newPng = Buffer.alloc(1024);
      for (let i = 0; i < 1024; i++) {
        newPng[i] = (i * 37) % 256;
      }
      fs.writeFileSync(path.join(sandbox.worktreePath, 'assets', 'new-asset.png'), newPng);

      // Generate patch
      const patchRel = generatePatch(sandbox.worktreePath, 'task-bin-deep', host.gitDir);
      expect(patchRel).not.toBeNull();
      const patchAbs = path.join(host.gitDir, patchRel!);

      // Precheck patch
      const precheck = await precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-bin-deep',
        workerId: 'worker-bin-deep',
      });
      expect(precheck.ok).toBe(true);

      // Apply & commit
      const mergeRes = await applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchAbs,
        taskId: 'task-bin-deep',
        workerId: 'worker-bin-deep',
      });

      expect(mergeRes.ok).toBe(true);
      expect(mergeRes.commitSha).toBeDefined();

      // Verify byte-for-byte exact equality on host!
      const hostModified = fs.readFileSync(path.join(host.gitDir, 'assets', 'to-modify.png'));
      expect(Buffer.compare(hostModified, modifiedPng)).toBe(0);

      expect(fs.existsSync(path.join(host.gitDir, 'assets', 'to-delete.bin'))).toBe(false);

      const hostNew = fs.readFileSync(path.join(host.gitDir, 'assets', 'new-asset.png'));
      expect(Buffer.compare(hostNew, newPng)).toBe(0);

      expect(host.isClean()).toBe(true);
    });
  });
});
