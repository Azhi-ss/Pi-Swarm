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

describe('Challenger Issue #4 Empirical Stress Matrix', () => {
  beforeEach(() => {
    clearAllWorktrees();
  });

  afterEach(() => {
    clearAllWorktrees();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Test Matrix 1: Concurrent Creation Collision (Both workers create same new file)
  // =========================================================================
  it('Matrix 1: Intercepts collision when two workers create the same new file with different content', async () => {
    const host = createTestGitRepo({ prefix: 'adv-new-file-collision-' });
    const sessionId = 'session-adv-new-file';
    const channelId = 'channel-dev';

    const s1 = host.allocateSandbox('worker-new-1', 'WorkerAlpha');
    const s2 = host.allocateSandbox('worker-new-2', 'WorkerBeta');

    const task1 = taskStore.createTask(
      host.gitDir,
      sessionId,
      { title: 'Worker 1 creates service.ts' },
      channelId
    );
    const task2 = taskStore.createTask(
      host.gitDir,
      sessionId,
      { title: 'Worker 2 creates service.ts' },
      channelId
    );

    taskStore.claimTask(host.gitDir, sessionId, task1.id, 'WorkerAlpha');
    taskStore.claimTask(host.gitDir, sessionId, task2.id, 'WorkerBeta');

    // Worker 1 creates src/service.ts
    host.writeSandboxFile(s1, 'src/service.ts', 'export const service = "alpha";\n');

    // Worker 2 creates src/service.ts with different content
    host.writeSandboxFile(s2, 'src/service.ts', 'export const service = "beta";\n');

    // Worker 1 submits -> success
    const res1 = await (taskDone as any)(
      { id: task1.id, summary: 'Created service alpha' },
      createState('WorkerAlpha'),
      host.gitDir,
      channelId,
      sessionId
    );
    expect(res1.details?.verified).toBe(true);
    expect(fs.readFileSync(path.join(host.gitDir, 'src/service.ts'), 'utf-8')).toBe(
      'export const service = "alpha";\n'
    );

    // Worker 2 submits -> MUST be intercepted as merge_conflict because service.ts already exists!
    const steerMsgs: AgentMailMessage[] = [];
    const res2 = await (taskDone as any)(
      { id: task2.id, summary: 'Created service beta' },
      createState('WorkerBeta'),
      host.gitDir,
      channelId,
      sessionId,
      (m: AgentMailMessage) => steerMsgs.push(m)
    );

    expect(res2.details?.error).toBe('merge_conflict');
    expect(res2.details?.attempt).toBe(1);

    // Host remains untouched and clean
    expect(host.isClean()).toBe(true);
    expect(fs.readFileSync(path.join(host.gitDir, 'src/service.ts'), 'utf-8')).toBe(
      'export const service = "alpha";\n'
    );

    // Steer message was sent
    expect(steerMsgs.length).toBe(1);
    expect(steerMsgs[0].text).toContain('Main branch evolved with conflicts');
  });

  // =========================================================================
  // Test Matrix 2: Worker modifies a file deleted by peer worker
  // =========================================================================
  it('Matrix 2: Intercepts collision when worker modifies a file that was deleted on host by peer worker', async () => {
    const host = createTestGitRepo({ prefix: 'adv-del-modify-collision-' });
    const sessionId = 'session-adv-del-modify';
    const channelId = 'channel-dev';

    // Base repo has deprecated.ts
    host.createFile(
      'src/deprecated.ts',
      'export const DEPRECATED = true;\n',
      'chore: add deprecated'
    );

    const s1 = host.allocateSandbox('worker-del-1', 'WorkerDeleter');
    const s2 = host.allocateSandbox('worker-del-2', 'WorkerModifier');

    const task1 = taskStore.createTask(
      host.gitDir,
      sessionId,
      { title: 'Delete deprecated' },
      channelId
    );
    const task2 = taskStore.createTask(
      host.gitDir,
      sessionId,
      { title: 'Update deprecated' },
      channelId
    );

    taskStore.claimTask(host.gitDir, sessionId, task1.id, 'WorkerDeleter');
    taskStore.claimTask(host.gitDir, sessionId, task2.id, 'WorkerModifier');

    // Worker 1 removes src/deprecated.ts
    fs.rmSync(path.join(s1.worktreePath, 'src/deprecated.ts'));

    // Worker 2 edits src/deprecated.ts
    host.writeSandboxFile(s2, 'src/deprecated.ts', 'export const DEPRECATED = false;\n');

    // Worker 1 merges deletion
    const res1 = await (taskDone as any)(
      { id: task1.id, summary: 'Deleted deprecated file' },
      createState('WorkerDeleter'),
      host.gitDir,
      channelId,
      sessionId
    );
    expect(res1.details?.verified).toBe(true);
    expect(fs.existsSync(path.join(host.gitDir, 'src/deprecated.ts'))).toBe(false);

    // Worker 2 attempts taskDone -> MUST be intercepted as merge_conflict
    const res2 = await (taskDone as any)(
      { id: task2.id, summary: 'Updated deprecated file' },
      createState('WorkerModifier'),
      host.gitDir,
      channelId,
      sessionId
    );

    expect(res2.details?.error).toBe('merge_conflict');
    expect(res2.details?.attempt).toBe(1);
    expect(host.isClean()).toBe(true);
    expect(fs.existsSync(path.join(host.gitDir, 'src/deprecated.ts'))).toBe(false);
  });

  // =========================================================================
  // Test Matrix 3: Mixed Failure Sequences (verification_failed -> merge_conflict -> merge_conflict)
  // =========================================================================
  it('Matrix 3: Mixed Failure Sequence A: verification_failed -> merge_conflict -> merge_conflict -> Graveyard pruning', async () => {
    const host = createTestGitRepo({ prefix: 'adv-mixed-seq-a-' });
    const sessionId = 'session-adv-mixed-a';
    const channelId = 'channel-dev';

    host.createConflictScenario({
      relPath: 'src/token.ts',
      baseContent: 'export const TOKEN = "base";\n',
      hostContent: 'export const TOKEN = "host-main";\n',
      sandboxContent: 'export const TOKEN = "worker-attempt";\n',
      agentId: 'worker-mixed-a',
      agentName: 'MixedWorkerA',
    });

    const task = taskStore.createTask(
      host.gitDir,
      sessionId,
      { title: 'Mixed Sequence A' },
      channelId
    );
    taskStore.claimTask(host.gitDir, sessionId, task.id, 'MixedWorkerA');
    const state = createState('MixedWorkerA');

    // Attempt 1: Test verification fails
    const res1 = await (taskDone as any)(
      { id: task.id, summary: 'Attempt 1', verify: 'node -e "process.exit(1)"' },
      state,
      host.gitDir,
      channelId,
      sessionId
    );
    expect(res1.details?.error).toBe('verification_failed');
    expect(res1.details?.attempt).toBe(1);

    let t = taskStore.getTask(host.gitDir, sessionId, task.id)!;
    expect(t.status).toBe('in_progress');

    // Attempt 2: Test passes, but merge collides
    const res2 = await (taskDone as any)(
      { id: task.id, summary: 'Attempt 2', verify: 'node -e "process.exit(0)"' },
      state,
      host.gitDir,
      channelId,
      sessionId
    );
    expect(res2.details?.error).toBe('merge_conflict');
    expect(res2.details?.attempt).toBe(2);

    t = taskStore.getTask(host.gitDir, sessionId, task.id)!;
    expect(t.status).toBe('in_progress');

    // Attempt 3: Merge collides again -> 3rd failure triggers Fast Pruning
    const res3 = await (taskDone as any)(
      { id: task.id, summary: 'Attempt 3', verify: 'node -e "process.exit(0)"' },
      state,
      host.gitDir,
      channelId,
      sessionId
    );
    expect(res3.details?.error).toBe('merge_conflict');
    expect(res3.details?.attempt).toBe(3);
    expect(res3.details?.pruned).toBe(true);

    t = taskStore.getTask(host.gitDir, sessionId, task.id)!;
    expect(t.status).toBe('dead_end');
    expect(t.claimed_by).toBeUndefined();

    // Verify feed event
    const feed = readFeedEvents(host.gitDir, undefined, channelId);
    expect(feed.some((e) => e.type === 'task.dead_end' && e.target === task.id)).toBe(true);
  });

  // =========================================================================
  // Test Matrix 4: Mixed Failure Sequence B: merge_conflict -> verification_failed -> merge_conflict
  // =========================================================================
  it('Matrix 4: Mixed Failure Sequence B: merge_conflict -> verification_failed -> merge_conflict -> Graveyard pruning', async () => {
    const host = createTestGitRepo({ prefix: 'adv-mixed-seq-b-' });
    const sessionId = 'session-adv-mixed-b';
    const channelId = 'channel-dev';

    host.createConflictScenario({
      relPath: 'src/api.ts',
      baseContent: 'export const API = 1;\n',
      hostContent: 'export const API = 2;\n',
      sandboxContent: 'export const API = 3;\n',
      agentId: 'worker-mixed-b',
      agentName: 'MixedWorkerB',
    });

    const task = taskStore.createTask(
      host.gitDir,
      sessionId,
      { title: 'Mixed Sequence B' },
      channelId
    );
    taskStore.claimTask(host.gitDir, sessionId, task.id, 'MixedWorkerB');
    const state = createState('MixedWorkerB');

    // Attempt 1: Merge collision (verify defaults to exit 0)
    const res1 = await (taskDone as any)(
      { id: task.id, summary: 'Attempt 1', verify: 'node -e "process.exit(0)"' },
      state,
      host.gitDir,
      channelId,
      sessionId
    );
    expect(res1.details?.error).toBe('merge_conflict');
    expect(res1.details?.attempt).toBe(1);

    // Attempt 2: Test fails
    const res2 = await (taskDone as any)(
      { id: task.id, summary: 'Attempt 2', verify: 'node -e "process.exit(1)"' },
      state,
      host.gitDir,
      channelId,
      sessionId
    );
    expect(res2.details?.error).toBe('verification_failed');
    expect(res2.details?.attempt).toBe(2);

    // Attempt 3: Merge collision again -> 3 strikes -> pruned!
    const res3 = await (taskDone as any)(
      { id: task.id, summary: 'Attempt 3', verify: 'node -e "process.exit(0)"' },
      state,
      host.gitDir,
      channelId,
      sessionId
    );
    expect(res3.details?.error).toBe('merge_conflict');
    expect(res3.details?.attempt).toBe(3);
    expect(res3.details?.pruned).toBe(true);

    const t = taskStore.getTask(host.gitDir, sessionId, task.id)!;
    expect(t.status).toBe('dead_end');
  });

  // =========================================================================
  // Test Matrix 5: High Contention - 4 Workers Colliding in Round-Robin
  // =========================================================================
  it('Matrix 5: High Contention - 4 concurrent workers colliding, 1 wins, 3 receive Steer bounce and host remains clean', async () => {
    const host = createTestGitRepo({ prefix: 'adv-contention-4-' });
    const sessionId = 'session-adv-contention-4';
    const channelId = 'channel-dev';

    host.createFile('src/state.ts', 'export const counter = 0;\n', 'chore: init counter');

    const workers = ['W1', 'W2', 'W3', 'W4'].map((name, i) => ({
      name,
      id: `worker-${i + 1}`,
      sandbox: host.allocateSandbox(`worker-${i + 1}`, name),
      task: taskStore.createTask(host.gitDir, sessionId, { title: `Task ${name}` }, channelId),
    }));

    for (const w of workers) {
      taskStore.claimTask(host.gitDir, sessionId, w.task.id, w.name);
      host.writeSandboxFile(
        w.sandbox,
        'src/state.ts',
        `export const counter = ${w.name === 'W1' ? 100 : 200};\n`
      );
    }

    // W1 merges first -> clean
    const resW1 = await (taskDone as any)(
      { id: workers[0].task.id, summary: 'W1 sets counter 100' },
      createState('W1'),
      host.gitDir,
      channelId,
      sessionId
    );
    expect(resW1.details?.verified).toBe(true);
    expect(fs.readFileSync(path.join(host.gitDir, 'src/state.ts'), 'utf-8')).toContain(
      'counter = 100'
    );

    // W2, W3, W4 all attempt merge -> all 3 MUST receive merge_conflict
    const otherWorkers = workers.slice(1);
    for (const w of otherWorkers) {
      const delivered: AgentMailMessage[] = [];
      const res = await (taskDone as any)(
        { id: w.task.id, summary: `${w.name} sets counter 200` },
        createState(w.name),
        host.gitDir,
        channelId,
        sessionId,
        (msg: AgentMailMessage) => delivered.push(msg)
      );

      expect(res.details?.error).toBe('merge_conflict');
      expect(res.details?.attempt).toBe(1);
      expect(delivered.length).toBe(1);
      expect(delivered[0].text).toContain('Main branch evolved with conflicts');
      expect(delivered[0].to).toBe(w.name);
    }

    // Host state remains 100% clean and reflects only W1
    expect(host.isClean()).toBe(true);
    expect(fs.readFileSync(path.join(host.gitDir, 'src/state.ts'), 'utf-8')).toBe(
      'export const counter = 100;\n'
    );
  });
});
