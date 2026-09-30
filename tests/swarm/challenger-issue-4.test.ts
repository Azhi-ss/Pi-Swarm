import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestGitRepo } from '../helpers/git-fixtures.js';
import { createState } from '../helpers/messenger-fixtures.js';
import { taskDone } from '../../swarm/handlers/task-lifecycle.js';
import * as taskStore from '../../swarm/task-store.js';
import { clearAllWorktrees } from '../../swarm/worktree/manager.js';
import { readFeedEvents } from '../../feed/index.js';
import type { AgentMailMessage } from '../../lib.js';

describe('Adversarial Challenge: Issue #4 Rebase-on-Conflict & Fast Pruning Protocol', () => {
  beforeEach(() => {
    clearAllWorktrees();
  });

  afterEach(() => {
    clearAllWorktrees();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Challenge 1: Multi-stage Collision & Rebase Recovery Lifecycle
  // =========================================================================
  describe('Challenge 1: Multi-Stage Collision Scenario', () => {
    it('simulates Worker 1 committing, Worker 2 colliding, receiving Steer bounce, rebasing in sandbox, and committing cleanly', async () => {
      const host = createTestGitRepo({ prefix: 'adv-collision-lifecycle-' });
      const sessionId = 'session-adv-collision';
      const channelId = 'channel-dev';

      // Base file on host
      host.createFile(
        'src/config.ts',
        'export const config = {\n  env: "production",\n  version: 1,\n};\n',
        'chore: initial config'
      );

      // Allocate sandboxes for Worker 1 and Worker 2
      const s1 = host.allocateSandbox('worker-1', 'WorkerAlpha');
      const s2 = host.allocateSandbox('worker-2', 'WorkerBeta');

      // Create tasks
      const task1 = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Worker 1 adds timeout' },
        channelId
      );
      const task2 = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Worker 2 adds retries' },
        channelId
      );

      taskStore.claimTask(host.gitDir, sessionId, task1.id, 'WorkerAlpha');
      taskStore.claimTask(host.gitDir, sessionId, task2.id, 'WorkerBeta');

      // Worker 1 modifies src/config.ts
      host.writeSandboxFile(
        s1,
        'src/config.ts',
        'export const config = {\n  env: "production",\n  version: 1,\n  timeout: 5000,\n};\n'
      );

      // Worker 2 modifies src/config.ts concurrently (conflicting with Worker 1)
      host.writeSandboxFile(
        s2,
        'src/config.ts',
        'export const config = {\n  env: "production",\n  version: 1,\n  retries: 3,\n};\n'
      );

      // Stage 1: Worker 1 finishes and calls taskDone
      const res1 = await (taskDone as any)(
        { id: task1.id, summary: 'Added timeout setting' },
        createState('WorkerAlpha'),
        host.gitDir,
        channelId,
        sessionId
      );

      expect(res1.details?.error).toBeUndefined();
      expect(res1.details?.verified).toBe(true);

      const hostAfterW1 = fs.readFileSync(path.join(host.gitDir, 'src/config.ts'), 'utf-8');
      expect(hostAfterW1).toContain('timeout: 5000');
      expect(host.isClean()).toBe(true);
      const hostCommitAfterW1 = host.getLatestCommit();
      expect(hostCommitAfterW1.message).toContain('feat(swarm): verify & merge');

      // Stage 2: Worker 2 submits taskDone -> must collide!
      const deliveredMessages: AgentMailMessage[] = [];
      const deliverMessage = (msg: AgentMailMessage) => {
        deliveredMessages.push(msg);
      };

      const res2Attempt1 = await (taskDone as any)(
        { id: task2.id, summary: 'Added retries setting' },
        createState('WorkerBeta'),
        host.gitDir,
        channelId,
        sessionId,
        deliverMessage
      );

      // Interception verification
      expect(res2Attempt1.details?.error).toBe('merge_conflict');
      expect(res2Attempt1.details?.attempt).toBe(1);
      expect(res2Attempt1.details?.maxAttempts).toBe(3);

      // Task must remain in_progress
      const task2State1 = taskStore.getTask(host.gitDir, sessionId, task2.id)!;
      expect(task2State1.status).toBe('in_progress');
      expect(task2State1.claimed_by).toBe('WorkerBeta');

      // Host must remain completely untouched by Worker 2's collision
      expect(host.isClean()).toBe(true);
      const hostAfterCollision = fs.readFileSync(path.join(host.gitDir, 'src/config.ts'), 'utf-8');
      expect(hostAfterCollision).toBe(hostAfterW1);
      expect(host.getLatestCommit().sha).toBe(hostCommitAfterW1.sha);

      // Steer bounce message verification
      expect(deliveredMessages.length).toBeGreaterThan(0);
      const steer = deliveredMessages.find((m) => m.to === 'WorkerBeta');
      expect(steer).toBeDefined();
      expect(steer!.text).toContain(
        'Main branch evolved with conflicts. Rebase your sandbox onto latest HEAD and re-verify!'
      );
      expect(steer!.text).toContain(`Run: ${sessionId}`);
      expect((steer as any).triggerTurn).toBe(true);
      expect(steer!.from).toBe('verifier');

      // Stage 3: Worker 2 resolves conflict in sandbox by integrating Worker 1's changes
      // Rebase simulation inside sandbox: advance sandbox HEAD to incorporate latest main
      host.runGit('checkout -f --detach main', s2.worktreePath);
      host.writeSandboxFile(
        s2,
        'src/config.ts',
        'export const config = {\n  env: "production",\n  version: 1,\n  timeout: 5000,\n  retries: 3,\n};\n'
      );

      // Stage 4: Worker 2 re-submits taskDone
      const res2Attempt2 = await (taskDone as any)(
        { id: task2.id, summary: 'Rebased and integrated timeout + retries' },
        createState('WorkerBeta'),
        host.gitDir,
        channelId,
        sessionId,
        deliverMessage
      );

      expect(res2Attempt2.details?.error).toBeUndefined();
      expect(res2Attempt2.details?.verified).toBe(true);

      // Host must now contain both changes cleanly merged
      const finalHostConfig = fs.readFileSync(path.join(host.gitDir, 'src/config.ts'), 'utf-8');
      expect(finalHostConfig).toContain('timeout: 5000');
      expect(finalHostConfig).toContain('retries: 3');
      expect(host.isClean()).toBe(true);

      // Both tasks are verified in taskStore
      const finalTask2 = taskStore.getTask(host.gitDir, sessionId, task2.id)!;
      expect(finalTask2.status).toBe('verified');
      expect(finalTask2.verification?.commitSha).toBeDefined();
      expect(finalTask2.verification?.commitSha).not.toBe(hostCommitAfterW1.sha);
    });
  });

  // =========================================================================
  // Challenge 2: 3-Attempt Fast Pruning & Broadcast Verification
  // =========================================================================
  describe('Challenge 2: 3-Attempt Fast Pruning & Broadcast Escalation', () => {
    it('verifies that exactly 3 failed collision attempts triggers Fast Pruning to Graveyard and broadcasts task.dead_end', async () => {
      const host = createTestGitRepo({ prefix: 'adv-pruning-escalation-' });
      const sessionId = 'session-adv-pruning';
      const channelId = 'channel-swarm';

      host.createConflictScenario({
        relPath: 'src/lock.ts',
        baseContent: 'export const LOCK = "none";\n',
        hostContent: 'export const LOCK = "host-lock";\n',
        sandboxContent: 'export const LOCK = "worker-lock";\n',
        agentId: 'worker-stubborn',
        agentName: 'StubbornAgent',
      });

      const task = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Conflicting Lock Task' },
        channelId
      );
      taskStore.claimTask(host.gitDir, sessionId, task.id, 'StubbornAgent');

      const state = createState('StubbornAgent');

      // Attempt 1: Rejection, status remains in_progress
      const res1 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 1' },
        state,
        host.gitDir,
        channelId,
        sessionId
      );
      expect(res1.details?.error).toBe('merge_conflict');
      expect(res1.details?.attempt).toBe(1);
      expect(res1.details?.pruned).toBeUndefined();

      let currentTask = taskStore.getTask(host.gitDir, sessionId, task.id)!;
      expect(currentTask.status).toBe('in_progress');
      expect(currentTask.claimed_by).toBe('StubbornAgent');

      // Feed should NOT have task.dead_end yet
      let feedEvents = readFeedEvents(host.gitDir, undefined, channelId);
      expect(feedEvents.some((e) => e.type === 'task.dead_end' && e.target === task.id)).toBe(
        false
      );

      // Attempt 2: Rejection, status remains in_progress
      const res2 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 2' },
        state,
        host.gitDir,
        channelId,
        sessionId
      );
      expect(res2.details?.error).toBe('merge_conflict');
      expect(res2.details?.attempt).toBe(2);
      expect(res2.details?.pruned).toBeUndefined();

      currentTask = taskStore.getTask(host.gitDir, sessionId, task.id)!;
      expect(currentTask.status).toBe('in_progress');
      expect(currentTask.claimed_by).toBe('StubbornAgent');

      feedEvents = readFeedEvents(host.gitDir, undefined, channelId);
      expect(feedEvents.some((e) => e.type === 'task.dead_end' && e.target === task.id)).toBe(
        false
      );

      // Attempt 3: Exactly 3rd failure triggers Fast Pruning
      const res3 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 3' },
        state,
        host.gitDir,
        channelId,
        sessionId
      );

      expect(res3.details?.error).toBe('merge_conflict');
      expect(res3.details?.pruned).toBe(true);
      expect(res3.details?.attempt).toBe(3);
      expect(res3.details?.maxAttempts).toBe(3);

      // Task status must be dead_end and claim released
      currentTask = taskStore.getTask(host.gitDir, sessionId, task.id)!;
      expect(currentTask.status).toBe('dead_end');
      expect(currentTask.claimed_by).toBeUndefined();

      // Blackboard Zone 4 must contain task
      const bbPath = path.join(host.gitDir, 'BLACKBOARD.md');
      const bbContent = fs.readFileSync(bbPath, 'utf-8');
      expect(bbContent).toContain('## 🪦 Zone 4: Graveyard & Dead Ends');
      expect(bbContent).toContain(task.id);
      expect(bbContent).toContain('Merge collision failed 3 times');

      // Feed MUST contain task.dead_end broadcast swarm-wide
      feedEvents = readFeedEvents(host.gitDir, undefined, channelId);
      const deadEndEvent = feedEvents.find(
        (e) => e.type === 'task.dead_end' && e.target === task.id
      );
      expect(deadEndEvent).toBeDefined();
      expect(deadEndEvent!.agent).toBe('StubbornAgent');
      expect(deadEndEvent!.channel).toBe(channelId);
      expect(deadEndEvent!.preview).toContain('Pruned after 3 merge collisions');

      // Attempt 4: If worker attempts taskDone again on pruned task, it is rejected with invalid_status
      const res4 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 4 after prune' },
        state,
        host.gitDir,
        channelId,
        sessionId
      );
      expect(res4.details?.error).toBe('invalid_status');
    });
  });

  // =========================================================================
  // Challenge 3: Strict Steer Message Protocol Verification
  // =========================================================================
  describe('Challenge 3: Strict Steer Message Protocol Conformance', () => {
    it('strictly verifies Steer message properties: exact text, triggerTurn flag, recipient, sender, and channel', async () => {
      const host = createTestGitRepo({ prefix: 'adv-steer-strict-' });
      const sessionId = 'session-adv-steer';
      const channelId = 'channel-steer-test';
      const agentId = 'worker-steer-strict';
      const agentName = 'StrictSteerAgent';

      host.createConflictScenario({
        relPath: 'src/theme.ts',
        baseContent: 'export const theme = "light";\n',
        hostContent: 'export const theme = "dark";\n',
        sandboxContent: 'export const theme = "solarized";\n',
        agentId,
        agentName,
      });

      const task = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Strict Steer Task' },
        channelId
      );
      taskStore.claimTask(host.gitDir, sessionId, task.id, agentName);

      const deliveredMessages: AgentMailMessage[] = [];
      const deliverMessage = (msg: AgentMailMessage) => {
        deliveredMessages.push(msg);
      };

      const res = await (taskDone as any)(
        { id: task.id, summary: 'Theme updated' },
        createState(agentName),
        host.gitDir,
        channelId,
        sessionId,
        deliverMessage
      );

      expect(res.details?.error).toBe('merge_conflict');
      expect(deliveredMessages.length).toBe(1);

      const steer = deliveredMessages[0];
      const expectedText =
        'Main branch evolved with conflicts. Rebase your sandbox onto latest HEAD and re-verify!';
      expect(steer.text).toContain(expectedText);
      expect(steer.text).toContain(`Run: ${sessionId}`);
      expect(steer.text).toContain('Incident: conflict-');

      // 2. triggerTurn must be strictly true to force agent turn
      expect((steer as any).triggerTurn).toBe(true);

      // 3. Recipient must be the exact agent name
      expect(steer.to).toBe(agentName);

      // 4. Sender must be "verifier"
      expect(steer.from).toBe('verifier');

      // 5. Channel must match
      expect(steer.channel).toBe(channelId);
    });
  });

  // =========================================================================
  // Challenge 4: Host Zero-Pollution Guarantee
  // =========================================================================
  describe('Challenge 4: Host Zero-Pollution Under Collision', () => {
    it('ensures host tree has 0 dirty files, 0 conflict markers, and HEAD commit untouched after collision', async () => {
      const host = createTestGitRepo({ prefix: 'adv-zero-pollution-' });
      const sessionId = 'session-adv-pollution';

      const conflict = host.createConflictScenario({
        relPath: 'src/database.ts',
        baseContent: 'export const DB = "sqlite";\n',
        hostContent: 'export const DB = "postgres";\n',
        sandboxContent: 'export const DB = "mysql";\n',
        agentId: 'worker-pollution-chk',
        agentName: 'PollutionChkAgent',
      });

      const task = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'DB Config Update' },
        'dev'
      );
      taskStore.claimTask(host.gitDir, sessionId, task.id, 'PollutionChkAgent');

      const initialHostHead = host.getLatestCommit().sha;

      // Execute taskDone leading to collision
      await (taskDone as any)(
        { id: task.id, summary: 'Switch to mysql' },
        createState('PollutionChkAgent'),
        host.gitDir,
        'dev',
        sessionId
      );

      // 1. Host isClean must be true
      expect(host.isClean()).toBe(true);

      // 2. Host git status output must be completely empty
      const gitStatus = host.runGit('status --porcelain');
      expect(gitStatus.stdout.trim()).toBe('');

      // 3. No conflict marker files or reject files exist
      const hostFiles = fs.readdirSync(path.join(host.gitDir, 'src'));
      expect(hostFiles).not.toContain('database.ts.rej');
      expect(hostFiles).not.toContain('database.ts.orig');

      // 4. File content strictly matches hostContent (no <<<<<<< markers)
      const content = fs.readFileSync(conflict.hostFile, 'utf-8');
      expect(content).toBe('export const DB = "postgres";\n');
      expect(content).not.toContain('<<<<<<<');

      // 5. HEAD commit is unchanged
      expect(host.getLatestCommit().sha).toBe(initialHostHead);
    });
  });

  // =========================================================================
  // Challenge 5: Confirmed Vulnerability & Failure Modes (Defect Repositories)
  // =========================================================================
  describe('Challenge 5: Confirmed Vulnerabilities in Rebase Recovery Heuristic', () => {
    it('FAILING DEFECT REPRODUCER 1: un-rebased retry silently deletes newly added files committed by prior workers on host main', async () => {
      const host = createTestGitRepo({ prefix: 'adv-vuln-deletion-' });
      const sessionId = 'session-adv-vuln-del';
      const channelId = 'channel-vuln';

      // Base file
      host.createFile('src/shared.ts', 'export const shared = 1;\n', 'chore: base');

      const s1 = host.allocateSandbox('worker-1', 'WorkerOne');
      const s2 = host.allocateSandbox('worker-2', 'WorkerTwo');

      const task1 = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Worker 1 creates new module' },
        channelId
      );
      const task2 = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Worker 2 edits shared' },
        channelId
      );

      taskStore.claimTask(host.gitDir, sessionId, task1.id, 'WorkerOne');
      taskStore.claimTask(host.gitDir, sessionId, task2.id, 'WorkerTwo');

      // Worker 1 creates brand new file src/worker1-module.ts
      host.writeSandboxFile(s1, 'src/worker1-module.ts', 'export const worker1Module = true;\n');

      // Worker 2 edits src/shared.ts
      host.writeSandboxFile(s2, 'src/shared.ts', 'export const shared = 2;\n');

      // Worker 1 merges successfully -> host now has src/worker1-module.ts
      const resW1 = await (taskDone as any)(
        { id: task1.id, summary: 'Created worker1 module' },
        createState('WorkerOne'),
        host.gitDir,
        channelId,
        sessionId
      );
      expect(resW1.details?.verified).toBe(true);
      expect(fs.existsSync(path.join(host.gitDir, 'src', 'worker1-module.ts'))).toBe(true);

      // Meanwhile on host, someone also touched src/shared.ts, so Worker 2's patch collides
      host.createFile(
        'src/shared.ts',
        'export const shared = 999;\n',
        'chore: host touched shared'
      );

      // Worker 2 calls taskDone -> Attempt 1 collides
      const resW2Attempt1 = await (taskDone as any)(
        { id: task2.id, summary: 'Shared update' },
        createState('WorkerTwo'),
        host.gitDir,
        channelId,
        sessionId
      );
      expect(resW2Attempt1.details?.error).toBe('merge_conflict');

      // Worker 2 now edits shared again to shared = 3 WITHOUT rebasing against host main
      host.writeSandboxFile(s2, 'src/shared.ts', 'export const shared = 3;\n');

      // Worker 2 calls taskDone -> Attempt 2
      await (taskDone as any)(
        { id: task2.id, summary: 'Shared update 2 without rebasing' },
        createState('WorkerTwo'),
        host.gitDir,
        channelId,
        sessionId
      );

      // CRITICAL ASSERTION:
      // Worker 1's newly added module MUST NOT be deleted from host repository!
      // In the buggy implementation, task-lifecycle.ts runs `git diff hostHead` in Worker 2's sandbox,
      // which does not have src/worker1-module.ts, producing a diff that DELETES src/worker1-module.ts from host!
      const worker1FileExists = fs.existsSync(path.join(host.gitDir, 'src', 'worker1-module.ts'));
      expect(
        worker1FileExists,
        'CRITICAL DEFECT: Host file src/worker1-module.ts was silently deleted by Worker 2 retry via buggy git diff hostHead heuristic!'
      ).toBe(true);
    });

    it('FAILING DEFECT REPRODUCER 2: test verification failure followed by merge collision causes attempt 2 to bypass collision check and clobber host', async () => {
      const host = createTestGitRepo({ prefix: 'adv-vuln-bypass-' });
      const sessionId = 'session-adv-vuln-bypass';
      const channelId = 'channel-vuln-bypass';

      // Setup conflict: Base has X = 1, Host has X = 2, Sandbox has X = 3
      host.createConflictScenario({
        relPath: 'src/calc.ts',
        baseContent: 'export const X = 1;\n',
        hostContent: 'export const X = 2;\n',
        sandboxContent: 'export const X = 3;\n',
        agentId: 'worker-mixed',
        agentName: 'MixedAgent',
      });

      const task = taskStore.createTask(
        host.gitDir,
        sessionId,
        { title: 'Mixed Failure Task' },
        channelId
      );
      taskStore.claimTask(host.gitDir, sessionId, task.id, 'MixedAgent');

      const state = createState('MixedAgent');

      // Attempt 1: Test failure (exit code 1 via verify override)
      const res1 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 1', verify: 'node -e "process.exit(1)"' },
        state,
        host.gitDir,
        channelId,
        sessionId
      );
      expect(res1.details?.error).toBe('verification_failed');
      expect(res1.details?.attempt).toBe(1);

      // Attempt 2: Worker fixes test (now exit 0), but code still conflicts with host (host has X = 2, worker has X = 3)
      const res2 = await (taskDone as any)(
        { id: task.id, summary: 'Attempt 2', verify: 'node -e "process.exit(0)"' },
        state,
        host.gitDir,
        channelId,
        sessionId
      );

      // CRITICAL ASSERTION:
      // Attempt 2 MUST be intercepted as a merge_conflict!
      // In the buggy implementation, lastPatchSha was empty because attempt 1 was verification_failed,
      // so currentPatchSha !== lastPatchSha evaluated to true and git diff hostHead was applied,
      // silently clobbering host and marking attempt 2 as verified!
      expect(
        res2.details?.error,
        'CRITICAL DEFECT: Attempt 2 should have been intercepted as merge_conflict, but was falsely verified and clobbered host!'
      ).toBe('merge_conflict');
    });
  });
});
