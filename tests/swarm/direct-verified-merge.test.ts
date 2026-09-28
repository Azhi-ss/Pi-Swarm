import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestGitRepo, createNonGitDir, type TestGitRepo } from '../helpers/git-fixtures.js';
import { createState } from '../helpers/messenger-fixtures.js';
import { taskDone } from '../../swarm/handlers/task-lifecycle.js';
import { generatePatch } from '../../swarm/verifier/index.js';
import * as taskStore from '../../swarm/task-store.js';
import { clearAllWorktrees } from '../../swarm/worktree/manager.js';
import type { AgentMailMessage } from '../../lib.js';

// Interface contracts for swarm/verifier/merge.ts (from PROJECT.md / ADR 0001)
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

export interface MergeModule {
  isGitRepo: (cwd: string) => boolean;
  precheckPatch: (options: MergeOptions) => Promise<PrecheckResult>;
  applyAndCommitPatch: (options: MergeOptions) => Promise<MergeResult>;
}

/**
 * Safely loads swarm/verifier/merge.ts dynamically.
 * Fails gracefully if Milestone M1 is still in progress.
 */
async function getMergeModule(): Promise<MergeModule | null> {
  try {
    return (await import('../../swarm/verifier/merge.js')) as unknown as MergeModule;
  } catch {
    return null;
  }
}

describe('Module 6: Direct Verified Atomic Merge Protocol & Rebase-on-Conflict', () => {
  beforeEach(() => {
    clearAllWorktrees();
  });

  afterEach(() => {
    clearAllWorktrees();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Tier 1: Clean Path Atomic Merge (Issue #2)
  // =========================================================================
  describe('Tier 1: Clean Path Atomic Merge (Issue #2)', () => {
    it('F2: precheckPatch validates clean patch via git apply --check without touching host files', async () => {
      const host = createTestGitRepo({ prefix: 'clean-precheck-' });
      host.createFile(
        'src/calc.ts',
        'export const add = (a: number, b: number) => a + b;\n',
        'chore: add calc'
      );

      const sandbox = host.allocateSandbox('worker-1', 'WorkerOne');
      host.writeSandboxFile(
        sandbox,
        'src/calc.ts',
        'export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n'
      );

      const patchRelPath = generatePatch(sandbox.worktreePath, 'task-precheck-1', host.gitDir);
      expect(patchRelPath).not.toBeNull();
      const patchFullPath = path.join(host.gitDir, patchRelPath!);
      expect(fs.existsSync(patchFullPath)).toBe(true);

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      const precheck = await merge.precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-precheck-1',
        workerId: 'worker-1',
      });

      expect(precheck.ok).toBe(true);
      expect(precheck.isGit).toBe(true);
      expect(precheck.error).toBeUndefined();

      // Host file must NOT be modified during precheck
      const hostContent = fs.readFileSync(path.join(host.gitDir, 'src/calc.ts'), 'utf-8');
      expect(hostContent).not.toContain('export const sub');
      expect(host.isClean()).toBe(true);
    });

    it('F3: applyAndCommitPatch applies patch and creates atomic commit on host main', async () => {
      const host = createTestGitRepo({ prefix: 'clean-apply-commit-' });
      host.createFile('src/index.ts', 'export const version = 1;\n', 'chore: add index');

      const sandbox = host.allocateSandbox('worker-apply', 'WorkerApply');
      host.writeSandboxFile(sandbox, 'src/index.ts', 'export const version = 2;\n');

      const patchRelPath = generatePatch(sandbox.worktreePath, 'task-apply-1', host.gitDir);
      expect(patchRelPath).not.toBeNull();
      const patchFullPath = path.join(host.gitDir, patchRelPath!);

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      const result = await merge.applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-apply-1',
        workerId: 'worker-apply',
        verifyCommand: 'npm test',
      });

      expect(result.ok).toBe(true);
      expect(result.isGit).toBe(true);
      expect(result.commitSha).toBeDefined();
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Verify host was updated and is clean
      const hostContent = fs.readFileSync(path.join(host.gitDir, 'src/index.ts'), 'utf-8');
      expect(hostContent).toBe('export const version = 2;\n');
      expect(host.isClean()).toBe(true);
    });

    it('F4: formats atomic commit message with standard format and metadata', async () => {
      const host = createTestGitRepo({ prefix: 'commit-format-' });
      host.createFile('src/service.ts', 'export const service = "v1";\n', 'chore: add service');

      const sandbox = host.allocateSandbox('worker-fmt', 'WorkerFmt');
      host.writeSandboxFile(sandbox, 'src/service.ts', 'export const service = "v2";\n');

      const patchRelPath = generatePatch(sandbox.worktreePath, 'task-fmt-1', host.gitDir);
      const patchFullPath = path.join(host.gitDir, patchRelPath!);

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      await merge.applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-fmt-1',
        workerId: 'worker-fmt',
        verifyCommand: 'npm test -- --run',
        patchSha: 'abc123sha',
      });

      const latestCommit = host.getLatestCommit();
      // Subject line requirement: feat(swarm): verify & merge <taskId> by <workerId> [Exit 0]
      expect(latestCommit.message).toContain(
        'feat(swarm): verify & merge task-fmt-1 by worker-fmt [Exit 0]'
      );
      // Metadata verification
      expect(latestCommit.message).toContain('Task: task-fmt-1');
      expect(latestCommit.message).toContain('Worker: worker-fmt');
      expect(latestCommit.message).toContain('Verify Command: npm test -- --run');
      expect(latestCommit.message).toContain('Exit Code: 0');
    });

    it('F8: taskDone integration promotes task to Zone 3 (Verified Artifacts) with commitSha', async () => {
      const host = createTestGitRepo({ prefix: 'clean-e2e-taskdone-' });
      const sessionId = 'session-clean-e2e';
      const agentName = 'WorkerE2E';
      const agentId = 'worker-e2e-1';

      const sandbox = host.allocateSandbox(agentId, agentName);

      const task = taskStore.createTask(
        host.gitDir,
        sessionId,
        {
          title: 'Implement verified feature X',
          verifyCommand: 'node -e "process.exit(0)"',
        },
        'dev'
      );
      taskStore.claimTask(host.gitDir, sessionId, task.id, agentName);

      // Modify code in sandbox
      host.writeSandboxFile(sandbox, 'feature-x.ts', 'export const featureX = true;\n');

      const state = createState(agentName);
      const res = await (taskDone as any)(
        {
          id: task.id,
          summary: 'Feature X verified in sandbox and merged',
        },
        state,
        host.gitDir,
        'dev',
        sessionId
      );

      // Verify task completed & verified
      expect(res.details?.error).toBeUndefined();
      expect(res.details?.verified).toBe(true);

      const updated = taskStore.getTask(host.gitDir, sessionId, task.id)!;
      expect(updated.status).toBe('verified');
      expect(updated.verification?.exitCode).toBe(0);

      // Verify commitSha recorded in task verification (M2 requirement)
      expect(updated.verification?.commitSha).toBeDefined();
      expect(updated.verification?.commitSha).toMatch(/^[0-9a-f]{7,40}$/);

      // Host must have the file and commit
      expect(fs.existsSync(path.join(host.gitDir, 'feature-x.ts'))).toBe(true);
      expect(host.isClean()).toBe(true);

      // Verify Blackboard Zone 3 contains the task and commit reference
      const bbPath = path.join(host.gitDir, 'BLACKBOARD.md');
      expect(fs.existsSync(bbPath)).toBe(true);
      const bbContent = fs.readFileSync(bbPath, 'utf-8');
      expect(bbContent).toContain('## 🏆 Zone 3: Verified Artifacts');
      expect(bbContent).toContain(task.id);
      expect(bbContent).toContain(updated.verification!.commitSha!.slice(0, 7));
    });

    it('leaves host repository 100% clean, buildable, and runnable after merge', async () => {
      const host = createTestGitRepo({ prefix: 'clean-state-check-' });
      const sandbox = host.allocateSandbox('worker-clean-chk', 'WorkerCleanChk');

      host.writeSandboxFile(sandbox, 'clean-check.ts', 'export const isClean = true;\n');

      const patchRelPath = generatePatch(sandbox.worktreePath, 'task-clean-chk', host.gitDir);
      const patchFullPath = path.join(host.gitDir, patchRelPath!);

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      await merge.applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-clean-chk',
        workerId: 'worker-clean-chk',
        verifyCommand: 'npm test',
      });

      // Host working tree must have zero uncommitted files
      expect(host.isClean()).toBe(true);
    });
  });

  // =========================================================================
  // Tier 2: Collision & Rebase-on-Conflict Protocol (Issue #4)
  // =========================================================================
  describe('Tier 2: Collision & Rebase-on-Conflict (Issue #4)', () => {
    it('F9: precheckPatch intercepts collision on overlapping modifications without corrupting host', async () => {
      const host = createTestGitRepo({ prefix: 'collision-precheck-' });
      const conflict = host.createConflictScenario({
        relPath: 'src/settings.ts',
        baseContent: 'export const PORT = 3000;\nexport const HOST = "localhost";\n',
        hostContent: 'export const PORT = 8080;\nexport const HOST = "localhost";\n',
        sandboxContent: 'export const PORT = 9000;\nexport const HOST = "localhost";\n',
        agentId: 'worker-conflict-1',
        agentName: 'WorkerConflict1',
      });

      const patchRelPath = generatePatch(
        conflict.sandbox.worktreePath,
        'task-conflict-1',
        host.gitDir
      );
      expect(patchRelPath).not.toBeNull();
      const patchFullPath = path.join(host.gitDir, patchRelPath!);

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      const precheck = await merge.precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: conflict.sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-conflict-1',
        workerId: 'worker-conflict-1',
      });

      // Conflict must be detected!
      expect(precheck.ok).toBe(false);
      expect(precheck.isGit).toBe(true);
      expect(precheck.error).toBeDefined();

      // Host file must remain 100% clean with hostContent — NO conflict markers injected!
      const hostContent = fs.readFileSync(conflict.hostFile, 'utf-8');
      expect(hostContent).toBe('export const PORT = 8080;\nexport const HOST = "localhost";\n');
      expect(hostContent).not.toContain('<<<<<<<');
      expect(hostContent).not.toContain('=======');
      expect(hostContent).not.toContain('>>>>>>>');
      expect(host.isClean()).toBe(true);
    });

    it('F10: taskDone generates Steer collision bounce message informing worker to rebase on main', async () => {
      const host = createTestGitRepo({ prefix: 'collision-steer-bounce-' });
      const sessionId = 'session-steer-bounce';
      const agentName = 'WorkerBounce';
      const agentId = 'worker-bounce-1';

      const conflict = host.createConflictScenario({
        relPath: 'src/api.ts',
        baseContent: 'export const API_URL = "http://base";\n',
        hostContent: 'export const API_URL = "http://host-updated";\n',
        sandboxContent: 'export const API_URL = "http://worker-updated";\n',
        agentId,
        agentName,
      });

      const task = taskStore.createTask(
        host.gitDir,
        sessionId,
        {
          title: 'Update API URL',
          verifyCommand: 'node -e "process.exit(0)"',
        },
        'dev'
      );
      taskStore.claimTask(host.gitDir, sessionId, task.id, agentName);

      const deliveredMessages: AgentMailMessage[] = [];
      const deliverMessage = (msg: AgentMailMessage) => {
        deliveredMessages.push(msg);
      };

      const state = createState(agentName);
      const res = await (taskDone as any)(
        {
          id: task.id,
          summary: 'Updated API endpoint',
        },
        state,
        host.gitDir,
        'dev',
        sessionId,
        deliverMessage
      );

      // Verify task completion was rejected due to merge conflict (M2 requirement)
      expect(res.details?.error).toBe('merge_conflict');

      // Task must remain in_progress for self-healing
      const currentTask = taskStore.getTask(host.gitDir, sessionId, task.id)!;
      expect(currentTask.status).toBe('in_progress');
      expect(currentTask.verification_attempts).toBe(1);

      // Host must remain untouched
      expect(fs.readFileSync(conflict.hostFile, 'utf-8')).toBe(
        'export const API_URL = "http://host-updated";\n'
      );
      expect(host.isClean()).toBe(true);

      // Steer bounce message delivered to worker
      expect(deliveredMessages.length).toBeGreaterThan(0);
      const steer = deliveredMessages.find((m) => m.to === agentName);
      expect(steer).toBeDefined();
      // Requirement exact text: "Main branch evolved with conflicts. Rebase your sandbox onto latest HEAD and re-verify!"
      expect(steer!.text).toContain(
        'Main branch evolved with conflicts. Rebase your sandbox onto latest HEAD and re-verify!'
      );
    });

    it('F11: worker successfully rebases in sandbox, resolves conflict, and merges on retry', async () => {
      const host = createTestGitRepo({ prefix: 'rebase-recovery-' });
      const sessionId = 'session-rebase-recovery';
      const agentName = 'WorkerRebase';
      const agentId = 'worker-rebase-1';

      const conflict = host.createConflictScenario({
        relPath: 'src/routes.ts',
        baseContent: 'export const routes = ["/home"];\n',
        hostContent: 'export const routes = ["/home", "/about"];\n',
        sandboxContent: 'export const routes = ["/home", "/contact"];\n',
        agentId,
        agentName,
      });

      const task = taskStore.createTask(
        host.gitDir,
        sessionId,
        {
          title: 'Add contact route',
          verifyCommand: 'node -e "process.exit(0)"',
        },
        'dev'
      );
      taskStore.claimTask(host.gitDir, sessionId, task.id, agentName);

      const state = createState(agentName);

      // Attempt 1: Fails with collision (M2 requirement)
      const res1 = await (taskDone as any)(
        { id: task.id, summary: 'Added contact route' },
        state,
        host.gitDir,
        'dev',
        sessionId
      );
      expect(res1.details?.error).toBe('merge_conflict');

      // Worker performs rebase / pulls latest main in sandbox and integrates both routes cleanly
      // Rebase simulation inside sandbox: advance sandbox HEAD to incorporate latest main
      host.runGit('checkout -f --detach main', conflict.sandbox.worktreePath);
      host.writeSandboxFile(
        conflict.sandbox,
        'src/routes.ts',
        'export const routes = ["/home", "/about", "/contact"];\n'
      );

      // Attempt 2: Re-submits taskDone after conflict resolution
      const res2 = await (taskDone as any)(
        { id: task.id, summary: 'Resolved conflict and merged contact route' },
        state,
        host.gitDir,
        'dev',
        sessionId
      );

      expect(res2.details?.error).toBeUndefined();
      expect(res2.details?.verified).toBe(true);

      // Host must have both routes cleanly merged
      const finalHostContent = fs.readFileSync(conflict.hostFile, 'utf-8');
      expect(finalHostContent).toBe('export const routes = ["/home", "/about", "/contact"];\n');
      expect(host.isClean()).toBe(true);

      const updated = taskStore.getTask(host.gitDir, sessionId, task.id)!;
      expect(updated.status).toBe('verified');
      expect(updated.verification?.commitSha).toBeDefined();
    });

    it('F12: Fast Pruning: 3 consecutive merge failures archives task to Graveyard and broadcasts task.dead_end', async () => {
      const host = createTestGitRepo({ prefix: 'collision-pruning-' });
      const sessionId = 'session-collision-pruning';
      const agentName = 'WorkerStubborn';
      const agentId = 'worker-stubborn-1';

      host.createConflictScenario({
        relPath: 'src/core.ts',
        baseContent: 'export const CORE = 1;\n',
        hostContent: 'export const CORE = 2;\n',
        sandboxContent: 'export const CORE = 3;\n',
        agentId,
        agentName,
      });

      const task = taskStore.createTask(
        host.gitDir,
        sessionId,
        {
          title: 'Stubborn conflict task',
          verifyCommand: 'node -e "process.exit(0)"',
        },
        'dev'
      );
      taskStore.claimTask(host.gitDir, sessionId, task.id, agentName);

      const state = createState(agentName);

      // Attempt 1
      const res1 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 1' },
        state,
        host.gitDir,
        'dev',
        sessionId
      );
      expect(res1.details?.error).toBe('merge_conflict');
      expect(res1.details?.attempt).toBe(1);

      // Attempt 2
      const res2 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 2' },
        state,
        host.gitDir,
        'dev',
        sessionId
      );
      expect(res2.details?.error).toBe('merge_conflict');
      expect(res2.details?.attempt).toBe(2);

      // Attempt 3: Triggers Fast Pruning (M2 requirement)
      const res3 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 3' },
        state,
        host.gitDir,
        'dev',
        sessionId
      );

      expect(res3.details?.pruned).toBe(true);
      expect(res3.details?.attempt).toBe(3);

      // Task must be dead_end
      const prunedTask = taskStore.getTask(host.gitDir, sessionId, task.id)!;
      expect(prunedTask.status).toBe('dead_end');
      expect(prunedTask.claimed_by).toBeUndefined();

      // Blackboard Zone 4 must contain task
      const bbPath = path.join(host.gitDir, 'BLACKBOARD.md');
      const bbContent = fs.readFileSync(bbPath, 'utf-8');
      expect(bbContent).toContain('## 🪦 Zone 4: Graveyard & Dead Ends');
      expect(bbContent).toContain(task.id);
    });
  });

  // =========================================================================
  // Tier 3: Cross-Feature & Edge Cases
  // =========================================================================
  describe('Tier 3: Cross-Feature & Edge Cases', () => {
    it('F1: untracked files in sandbox (git add -N .) produce valid unified diffs that apply cleanly', async () => {
      const host = createTestGitRepo({ prefix: 'untracked-patch-' });
      const sandbox = host.allocateSandbox('worker-untracked', 'WorkerUntracked');

      // Create a brand new file in sandbox
      host.writeSandboxFile(
        sandbox,
        'src/components/Button.ts',
        'export const Button = () => "<button>Click</button>";\n'
      );

      // Generate patch
      const patchRel = generatePatch(sandbox.worktreePath, 'task-untracked-1', host.gitDir);
      expect(patchRel).not.toBeNull();
      const patchFullPath = path.join(host.gitDir, patchRel!);

      const patchContent = fs.readFileSync(patchFullPath, 'utf-8');
      // Must be a valid unified diff with new file mode (NOT a comment like "# Modified / untracked files:")
      expect(patchContent).toContain('diff --git');
      expect(patchContent).toContain('new file mode');
      expect(patchContent).toContain('+export const Button');

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      // Host precheck must succeed
      const precheck = await merge.precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-untracked-1',
        workerId: 'worker-untracked',
      });
      expect(precheck.ok).toBe(true);

      // Apply and commit
      const mergeRes = await merge.applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-untracked-1',
        workerId: 'worker-untracked',
      });
      expect(mergeRes.ok).toBe(true);
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'components', 'Button.ts'))).toBe(true);
      expect(host.isClean()).toBe(true);
    });

    it('F5: in-memory merge mutex serializes concurrent applyAndCommitPatch calls without .git/index.lock collisions', async () => {
      const host = createTestGitRepo({ prefix: 'merge-mutex-' });
      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      const workerCount = 4;
      const sandboxes = Array.from({ length: workerCount }, (_, i) =>
        host.allocateSandbox(`worker-mutex-${i}`, `WorkerMutex${i}`)
      );

      const patchPaths: string[] = [];
      for (let i = 0; i < workerCount; i++) {
        host.writeSandboxFile(sandboxes[i], `module-${i}.ts`, `export const module${i} = ${i};\n`);
        const p = generatePatch(sandboxes[i].worktreePath, `task-mutex-${i}`, host.gitDir);
        expect(p).not.toBeNull();
        patchPaths.push(path.join(host.gitDir, p!));
      }

      // Fire all applyAndCommitPatch calls concurrently in parallel
      const results = await Promise.all(
        patchPaths.map((patchPath, i) =>
          merge.applyAndCommitPatch({
            hostCwd: host.gitDir,
            targetCwd: sandboxes[i].worktreePath,
            patchPath,
            taskId: `task-mutex-${i}`,
            workerId: `worker-mutex-${i}`,
            verifyCommand: 'npm test',
          })
        )
      );

      // Every single commit must have succeeded without .git/index.lock failure
      for (const res of results) {
        expect(res.ok).toBe(true);
        expect(res.commitSha).toBeDefined();
      }

      // All files exist on host
      for (let i = 0; i < workerCount; i++) {
        expect(fs.existsSync(path.join(host.gitDir, `module-${i}.ts`))).toBe(true);
      }
      expect(host.isClean()).toBe(true);
    });

    it('F6: non-git directory fallback gracefully degrades without crashing', async () => {
      const nonGit = createNonGitDir('non-git-fallback-');
      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      // isGitRepo check
      expect(merge.isGitRepo(nonGit.dir)).toBe(false);

      // precheck on non-git directory returns ok: true, isGit: false
      const precheck = await merge.precheckPatch({
        hostCwd: nonGit.dir,
        targetCwd: nonGit.dir,
        patchPath: path.join(nonGit.dir, 'dummy.patch'),
        taskId: 'task-nongit',
        workerId: 'worker-nongit',
      });
      expect(precheck.ok).toBe(true);
      expect(precheck.isGit).toBe(false);

      // applyAndCommit on non-git directory returns ok: true, isGit: false
      const commitRes = await merge.applyAndCommitPatch({
        hostCwd: nonGit.dir,
        targetCwd: nonGit.dir,
        patchPath: path.join(nonGit.dir, 'dummy.patch'),
        taskId: 'task-nongit',
        workerId: 'worker-nongit',
      });
      expect(commitRes.ok).toBe(true);
      expect(commitRes.isGit).toBe(false);
    });

    it('F7: same-cwd direct commit commits staged files directly when targetCwd === hostCwd', async () => {
      const host = createTestGitRepo({ prefix: 'same-cwd-' });
      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      // Modify file directly in hostCwd
      fs.writeFileSync(path.join(host.gitDir, 'direct.ts'), 'export const direct = 1;\n', 'utf-8');

      const res = await merge.applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: host.gitDir, // Same cwd!
        patchPath: '',
        taskId: 'task-direct',
        workerId: 'worker-direct',
      });

      expect(res.ok).toBe(true);
      expect(res.commitSha).toBeDefined();
      expect(host.isClean()).toBe(true);
      expect(fs.readFileSync(path.join(host.gitDir, 'direct.ts'), 'utf-8')).toBe(
        'export const direct = 1;\n'
      );
    });

    it('handles author fallback when git user.name / user.email are not configured globally', async () => {
      const host = createTestGitRepo({ prefix: 'author-fallback-' });
      // Unset local git user config to simulate unconfigured git environment
      host.runGit('config --unset user.name');
      host.runGit('config --unset user.email');

      const sandbox = host.allocateSandbox('worker-fallback-auth', 'WorkerAuth');
      host.writeSandboxFile(sandbox, 'auth.ts', 'export const auth = true;\n');

      const patchRel = generatePatch(sandbox.worktreePath, 'task-auth-fallback', host.gitDir);
      const patchFullPath = path.join(host.gitDir, patchRel!);

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      // applyAndCommitPatch must supply -c user.name and -c user.email fallback
      const res = await merge.applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-auth-fallback',
        workerId: 'worker-fallback-auth',
      });

      expect(res.ok).toBe(true);
      expect(res.commitSha).toBeDefined();
      expect(host.isClean()).toBe(true);
    });

    it('rejects corrupted or malformed patch files cleanly without crashing or corrupting host', async () => {
      const host = createTestGitRepo({ prefix: 'corrupted-patch-' });
      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      const badPatch = path.join(host.gitDir, '.pi', 'messenger', 'artifacts', 'corrupted.patch');
      fs.mkdirSync(path.dirname(badPatch), { recursive: true });
      fs.writeFileSync(
        badPatch,
        'THIS IS NOT A VALID GIT PATCH HUNK\n@@ -1,3 +1,3 @@\ncorrupted',
        'utf-8'
      );

      const precheck = await merge.precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: host.gitDir,
        patchPath: badPatch,
        taskId: 'task-corrupt',
        workerId: 'worker-corrupt',
      });

      expect(precheck.ok).toBe(false);
      expect(precheck.error).toBeDefined();
      expect(host.isClean()).toBe(true);
    });

    it('handles empty patch (Exit 0 with zero diff) gracefully without failing on empty commit', async () => {
      const host = createTestGitRepo({ prefix: 'empty-patch-' });
      const sandbox = host.allocateSandbox('worker-noop', 'WorkerNoop');

      // Zero changes made in sandbox
      const patchRel = generatePatch(sandbox.worktreePath, 'task-noop', host.gitDir);
      // generatePatch returns null on zero diff
      expect(patchRel).toBeNull();

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      const emptyPatchPath = path.join(host.gitDir, '.pi', 'messenger', 'artifacts', 'empty.patch');
      fs.mkdirSync(path.dirname(emptyPatchPath), { recursive: true });
      fs.writeFileSync(emptyPatchPath, '', 'utf-8');

      const res = await merge.applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: emptyPatchPath,
        taskId: 'task-noop',
        workerId: 'worker-noop',
      });

      // When working tree is already clean, it should succeed gracefully
      expect(res.ok).toBe(true);
      expect(host.isClean()).toBe(true);
    });
  });

  // =========================================================================
  // Tier 4: Real-World Swarm Application Scenarios (TEST_INFRA.md)
  // =========================================================================
  describe('Tier 4: Real-World Swarm Application Scenarios', () => {
    it('Scenario 1: Dual Worker Non-Conflicting Concurrent Merge', async () => {
      const host = createTestGitRepo({ prefix: 'scenario-dual-clean-' });
      const sessionId = 'session-dual-clean';

      const sA = host.allocateSandbox('worker-alpha', 'AgentAlpha');
      const sB = host.allocateSandbox('worker-beta', 'AgentBeta');

      const taskA = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Implement Auth' },
        'dev'
      );
      const taskB = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Implement Billing' },
        'dev'
      );

      taskStore.claimTask(host.gitDir, sessionId, taskA.id, 'AgentAlpha');
      taskStore.claimTask(host.gitDir, sessionId, taskB.id, 'AgentBeta');

      host.writeSandboxFile(sA, 'src/auth.ts', 'export const auth = true;\n');
      host.writeSandboxFile(sB, 'src/billing.ts', 'export const billing = true;\n');

      // Both submit taskDone
      const resA = await (taskDone as any)(
        { id: taskA.id, summary: 'Auth complete' },
        createState('AgentAlpha'),
        host.gitDir,
        'dev',
        sessionId
      );
      const resB = await (taskDone as any)(
        { id: taskB.id, summary: 'Billing complete' },
        createState('AgentBeta'),
        host.gitDir,
        'dev',
        sessionId
      );

      expect(resA.details?.verified).toBe(true);
      expect(resB.details?.verified).toBe(true);

      // Both files exist on host (M2 requirement)
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'auth.ts'))).toBe(true);
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'billing.ts'))).toBe(true);
      expect(host.isClean()).toBe(true);

      // Both tasks are verified with distinct commit SHAs
      const updatedA = taskStore.getTask(host.gitDir, sessionId, taskA.id)!;
      const updatedB = taskStore.getTask(host.gitDir, sessionId, taskB.id)!;
      expect(updatedA.status).toBe('verified');
      expect(updatedB.status).toBe('verified');
      expect(updatedA.verification?.commitSha).toBeDefined();
      expect(updatedB.verification?.commitSha).toBeDefined();
      expect(updatedA.verification?.commitSha).not.toBe(updatedB.verification?.commitSha);
    });

    it('Scenario 2: Dual Worker Conflicting Merge with Rebase Recovery', async () => {
      const host = createTestGitRepo({ prefix: 'scenario-rebase-recov-' });
      const sessionId = 'session-rebase-recov';
      host.createFile('src/config.json', '{\n  "version": "1.0.0"\n}\n', 'chore: initial config');

      const sA = host.allocateSandbox('worker-1', 'Agent1');
      const sB = host.allocateSandbox('worker-2', 'Agent2');

      const taskA = taskStore.createTask(host.gitDir, sessionId, { title: 'Bump major' }, 'dev');
      const taskB = taskStore.createTask(host.gitDir, sessionId, { title: 'Bump minor' }, 'dev');

      taskStore.claimTask(host.gitDir, sessionId, taskA.id, 'Agent1');
      taskStore.claimTask(host.gitDir, sessionId, taskB.id, 'Agent2');

      host.writeSandboxFile(sA, 'src/config.json', '{\n  "version": "2.0.0"\n}\n');
      host.writeSandboxFile(sB, 'src/config.json', '{\n  "version": "1.1.0"\n}\n');

      // Worker A completes first
      const resA = await (taskDone as any)(
        { id: taskA.id, summary: 'Bumped to 2.0.0' },
        createState('Agent1'),
        host.gitDir,
        'dev',
        sessionId
      );
      expect(resA.details?.verified).toBe(true);

      // Worker B submits and encounters collision (M2 requirement)
      const resB1 = await (taskDone as any)(
        { id: taskB.id, summary: 'Bumped to 1.1.0' },
        createState('Agent2'),
        host.gitDir,
        'dev',
        sessionId
      );
      expect(resB1.details?.error).toBe('merge_conflict');

      // Worker B rebases against latest main and sets combined version
      host.runGit('checkout -f --detach main', sB.worktreePath);
      host.writeSandboxFile(sB, 'src/config.json', '{\n  "version": "2.1.0"\n}\n');

      // Worker B resubmits
      const resB2 = await (taskDone as any)(
        { id: taskB.id, summary: 'Resolved conflict to 2.1.0' },
        createState('Agent2'),
        host.gitDir,
        'dev',
        sessionId
      );
      expect(resB2.details?.verified).toBe(true);

      // Final host state matches Worker B's integrated resolution
      const finalConfig = fs.readFileSync(path.join(host.gitDir, 'src/config.json'), 'utf-8');
      expect(finalConfig).toBe('{\n  "version": "2.1.0"\n}\n');
      expect(host.isClean()).toBe(true);
    });

    it('Scenario 3: Tri-Worker Collision Escalation to Fast Pruning', async () => {
      const host = createTestGitRepo({ prefix: 'scenario-tri-prune-' });
      const sessionId = 'session-tri-prune';
      host.createFile('schema.sql', 'CREATE TABLE users (id INT);\n', 'chore: add schema');

      const sLeader = host.allocateSandbox('leader', 'LeaderAgent');
      const sStubborn = host.allocateSandbox('stubborn', 'StubbornAgent');

      const taskLeader = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Leader Migration' },
        'dev'
      );
      const taskStubborn = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Conflicting Migration' },
        'dev'
      );

      taskStore.claimTask(host.gitDir, sessionId, taskLeader.id, 'LeaderAgent');
      taskStore.claimTask(host.gitDir, sessionId, taskStubborn.id, 'StubbornAgent');

      host.writeSandboxFile(sLeader, 'schema.sql', 'CREATE TABLE users (id INT, email TEXT);\n');
      host.writeSandboxFile(sStubborn, 'schema.sql', 'CREATE TABLE users (uuid UUID);\n');

      // Leader merges
      await (taskDone as any)(
        { id: taskLeader.id, summary: 'Added email column' },
        createState('LeaderAgent'),
        host.gitDir,
        'dev',
        sessionId
      );

      // Stubborn agent attempts 3 times without resolving (M2 requirement)
      for (let attempt = 1; attempt <= 3; attempt++) {
        await (taskDone as any)(
          { id: taskStubborn.id, summary: `Attempt ${attempt}` },
          createState('StubbornAgent'),
          host.gitDir,
          'dev',
          sessionId
        );
      }

      const pruned = taskStore.getTask(host.gitDir, sessionId, taskStubborn.id)!;
      expect(pruned.status).toBe('dead_end');
      expect(pruned.claimed_by).toBeUndefined();

      const bbContent = fs.readFileSync(path.join(host.gitDir, 'BLACKBOARD.md'), 'utf-8');
      expect(bbContent).toContain('## 🪦 Zone 4: Graveyard & Dead Ends');
      expect(bbContent).toContain(taskStubborn.id);
    });

    it('Scenario 4: Untracked Multi-File Patch Generation & Direct Apply', async () => {
      const host = createTestGitRepo({ prefix: 'scenario-multi-file-' });
      const sandbox = host.allocateSandbox('worker-multi', 'WorkerMulti');

      // Create multiple new files across directories
      host.writeSandboxFile(
        sandbox,
        'src/utils/format.ts',
        'export const format = (s: string) => s.trim();\n'
      );
      host.writeSandboxFile(
        sandbox,
        'src/utils/validate.ts',
        'export const validate = (s: string) => s.length > 0;\n'
      );

      const patchRel = generatePatch(sandbox.worktreePath, 'task-multi-file', host.gitDir);
      expect(patchRel).not.toBeNull();
      const patchFullPath = path.join(host.gitDir, patchRel!);

      const merge = await getMergeModule();
      expect(merge, 'swarm/verifier/merge.ts must be implemented in Milestone M1').not.toBeNull();
      if (!merge) return;

      const precheck = await merge.precheckPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-multi-file',
        workerId: 'worker-multi',
      });
      expect(precheck.ok).toBe(true);

      const commitRes = await merge.applyAndCommitPatch({
        hostCwd: host.gitDir,
        targetCwd: sandbox.worktreePath,
        patchPath: patchFullPath,
        taskId: 'task-multi-file',
        workerId: 'worker-multi',
      });
      expect(commitRes.ok).toBe(true);

      // Verify both files exist on host
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'utils', 'format.ts'))).toBe(true);
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'utils', 'validate.ts'))).toBe(true);
      expect(host.isClean()).toBe(true);
    });

    it('Scenario 5: Non-Git Test Mode Backward Compatibility', async () => {
      const nonGit = createNonGitDir('scenario-nongit-compat-');
      const sessionId = 'session-nongit';

      const task = taskStore.createTask(
        nonGit.dir,
        sessionId,
        { title: 'Legacy non-git task' },
        'dev'
      );
      taskStore.claimTask(nonGit.dir, sessionId, task.id, 'LegacyAgent');

      const state = createState('LegacyAgent');
      const res = await (taskDone as any)(
        { id: task.id, summary: 'Completed in non-git directory' },
        state,
        nonGit.dir,
        'dev',
        sessionId
      );

      expect(res.details?.error).toBeUndefined();
      const updated = taskStore.getTask(nonGit.dir, sessionId, task.id)!;
      expect(updated.status === 'done' || updated.status === 'verified').toBe(true);
    });
  });
});
