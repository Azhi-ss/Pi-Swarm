import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as taskStore from '../../swarm/task-store/index.js';
import type { SwarmTask } from '../../swarm/types.js';

function createTempCwd(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-bb-test-'));
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'channels'), { recursive: true });
  return tmp;
}

describe('Module 3: Four-Zone Blackboard State Machine & Projection', () => {
  let cwd: string;
  const sessionId = 'test-session-bb';

  beforeEach(() => {
    cwd = createTempCwd();
  });

  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it('Zone 1 (Goal): creates tasks with spec, verifyCommand, and dependencies', () => {
    const task1 = taskStore.createTask(
      cwd,
      sessionId,
      {
        title: 'Core architecture refactor',
        content: 'Refactor store for four zones',
        verifyCommand: 'npm test tests/swarm/task-event-sourcing.test.ts',
      },
      'dev'
    );

    const task2 = taskStore.createTask(
      cwd,
      sessionId,
      {
        title: 'Connect verifier gate',
        dependsOn: [task1.id],
      },
      'dev'
    );

    expect(task1.status).toBe('todo');
    expect(task1.verify_command).toBe('npm test tests/swarm/task-event-sourcing.test.ts');
    expect(task2.status).toBe('todo');
    expect(task2.depends_on).toEqual([task1.id]);

    const goalTasks = taskStore.getGoalTasks(cwd, sessionId);
    expect(goalTasks.map((t) => t.id)).toEqual([task1.id, task2.id]);

    const readyTasks = taskStore.getReadyTasks(cwd, sessionId);
    expect(readyTasks.map((t) => t.id)).toEqual([task1.id]); // task2 is blocked by task1
  });

  it('Zone 2 (Soft Staking): stakes task with TTL lease, renews lease, and auto-expires', () => {
    const task = taskStore.createTask(cwd, sessionId, { title: 'Explore caching strategy' }, 'dev');

    // 1. Soft stake task
    const staked = taskStore.stakeTask(cwd, sessionId, task.id, 'Researcher-1', {
      ttl: 300,
      reason: 'Hypothesis A: Redis caching',
    });

    expect(staked).not.toBeNull();
    expect(staked!.status).toBe('staked');
    expect(staked!.claimed_by).toBe('Researcher-1');
    expect(staked!.claim_reason).toBe('Hypothesis A: Redis caching');
    expect(staked!.lease_ttl).toBe(300);
    expect(staked!.lease_expires_at).toBeDefined();

    const stakedTasks = taskStore.getStakedTasks(cwd, sessionId);
    expect(stakedTasks.length).toBe(1);
    expect(stakedTasks[0].id).toBe(task.id);

    // 2. Lease is not expired initially
    expect(taskStore.isLeaseExpired(staked!)).toBe(false);

    // 3. Renew lease
    const renewed = taskStore.renewTaskLease(cwd, sessionId, task.id, 'Researcher-1', 600);
    expect(renewed!.lease_ttl).toBe(600);

    // 4. Progress also renews lease
    taskStore.appendTaskProgress(
      cwd,
      sessionId,
      task.id,
      'Researcher-1',
      'Benchmarked Redis vs Memcached'
    );
    const withProgress = taskStore.getTask(cwd, sessionId, task.id);
    expect(withProgress!.progress_log?.length).toBe(1);
  });

  it('Zone 2 Preemption: expired lease permits opportunistic preemption by peer agent', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Distributed locking investigation' },
      'dev'
    );

    // Agent A stakes task with 1-second TTL
    taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-A', { ttl: 1 });

    // Agent B tries to stake immediately -> rejected (active lease)
    const preemptFail = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-B');
    expect(preemptFail).toBeNull();

    // Fast-forward time past 1 second
    const expiredTask = taskStore.getTask(cwd, sessionId, task.id)!;
    const futureTime = Date.now() + 2000;
    expect(taskStore.isLeaseExpired(expiredTask, futureTime)).toBe(true);

    // In queries / cleanup, expired lease gets auto-unclaimed
    // Simulate expired lease preemption directly in stakeTask
    // Manually record an expired stake event
    const expiredTimestamp = new Date(Date.now() - 5000).toISOString();
    taskStore.appendTaskEvent(cwd, sessionId, {
      taskId: task.id,
      type: 'staked',
      timestamp: expiredTimestamp,
      agent: 'Agent-A',
      payload: { ttl: 1 },
    });

    const refreshed = taskStore.getTask(cwd, sessionId, task.id)!;
    expect(taskStore.isLeaseExpired(refreshed)).toBe(true);

    // Agent B can now opportunistically preempt!
    const preemptSuccess = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-B', {
      ttl: 300,
      reason: 'Preempted expired lease',
    });
    expect(preemptSuccess).not.toBeNull();
    expect(preemptSuccess!.claimed_by).toBe('Agent-B');
    expect(preemptSuccess!.status).toBe('staked');
  });

  it('Zone 3 (Verified Artifacts): exit 0 promotes to verified and unblocks downstream tasks', () => {
    const task1 = taskStore.createTask(cwd, sessionId, { title: 'Core parser' }, 'dev');
    const task2 = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Downstream consumer', dependsOn: [task1.id] },
      'dev'
    );

    taskStore.stakeTask(cwd, sessionId, task1.id, 'Worker-1');

    // Verify task 1
    const verified = taskStore.verifyTask(cwd, sessionId, task1.id, 'Worker-1', {
      summary: 'Implemented parser with 100% AST coverage',
      command: 'npm test',
      exitCode: 0,
      patch: '.pi/messenger/artifacts/task-1.patch',
    });

    expect(verified).not.toBeNull();
    expect(verified!.status).toBe('verified');
    expect(verified!.verification?.exitCode).toBe(0);
    expect(verified!.verification?.patch).toBe('.pi/messenger/artifacts/task-1.patch');

    // Downstream task2 should now be ready!
    const readyTasks = taskStore.getReadyTasks(cwd, sessionId);
    expect(readyTasks.some((t) => t.id === task2.id)).toBe(true);

    const verifiedList = taskStore.getVerifiedTasks(cwd, sessionId);
    expect(verifiedList.some((t) => t.id === task1.id)).toBe(true);
  });

  it('Zone 4 (Graveyard): deadEndTask records negative knowledge and clears claims', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'POSIX flock implementation' },
      'dev'
    );
    taskStore.stakeTask(cwd, sessionId, task.id, 'Explorer-1');

    const deadEnd = taskStore.deadEndTask(cwd, sessionId, task.id, 'Explorer-1', {
      agent: 'Explorer-1',
      reason: 'POSIX file locks cause deadlock under Linux tmpfs',
      attempts: 3,
      lastCommand: 'npm test tests/flock.test.ts',
      lastOutput: 'Deadlock detected: thread 48102 blocked on fcntl',
    });

    expect(deadEnd).not.toBeNull();
    expect(deadEnd!.status).toBe('dead_end');
    expect(deadEnd!.claimed_by).toBeUndefined();
    expect(deadEnd!.lease_expires_at).toBeUndefined();
    expect(deadEnd!.dead_ends?.length).toBe(1);
    expect(deadEnd!.dead_ends![0].reason).toContain('deadlock under Linux tmpfs');

    const graveyard = taskStore.getGraveyardTasks(cwd, sessionId);
    expect(graveyard.some((t) => t.id === task.id)).toBe(true);
  });

  it('CQRS Projection: writeBlackboard renders BLACKBOARD.md under token budget reflecting all 4 zones', () => {
    // Populate tasks across all 4 zones
    const tGoal = taskStore.createTask(cwd, sessionId, { title: 'Backlog goal' }, 'dev');
    const tStaked = taskStore.createTask(cwd, sessionId, { title: 'In-flight work' }, 'dev');
    taskStore.stakeTask(cwd, sessionId, tStaked.id, 'Researcher-X', {
      ttl: 250,
      reason: 'Benchmarking',
    });

    const tVerified = taskStore.createTask(cwd, sessionId, { title: 'Golden achievement' }, 'dev');
    taskStore.stakeTask(cwd, sessionId, tVerified.id, 'Builder-Y');
    taskStore.verifyTask(cwd, sessionId, tVerified.id, 'Builder-Y', {
      summary: 'Verified golden achievement',
      command: 'npm test',
      exitCode: 0,
      patch: '.pi/messenger/artifacts/task-3.patch',
    });

    const tDead = taskStore.createTask(cwd, sessionId, { title: 'Refuted experiment' }, 'dev');
    taskStore.stakeTask(cwd, sessionId, tDead.id, 'Explorer-Z');
    taskStore.deadEndTask(cwd, sessionId, tDead.id, 'Explorer-Z', {
      agent: 'Explorer-Z',
      reason: 'Memory explosion on 1M items',
      attempts: 3,
      lastCommand: 'npm test tests/scale.test.ts',
      lastOutput: 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed',
    });

    // Write blackboard projection
    const md = taskStore.writeBlackboard(cwd, sessionId);
    const bbPath = path.join(cwd, 'BLACKBOARD.md');
    expect(fs.existsSync(bbPath)).toBe(true);

    const savedContent = fs.readFileSync(bbPath, 'utf-8');
    expect(savedContent).toBe(md);

    // Assert four zones are cleanly rendered
    expect(md).toContain('## 🎯 Zone 1: Goal & Open Backlog');
    expect(md).toContain('Backlog goal');

    expect(md).toContain('## ⚡ Zone 2: Soft Staking');
    expect(md).toContain('In-flight work');
    expect(md).toContain('Researcher-X');

    expect(md).toContain('## 🏆 Zone 3: Verified Artifacts');
    expect(md).toContain('Golden achievement');
    expect(md).toContain('Builder-Y');
    expect(md).toContain('.pi/messenger/artifacts/task-3.patch');

    expect(md).toContain('## 🪦 Zone 4: Graveyard & Dead Ends');
    expect(md).toContain('Refuted experiment');
    expect(md).toContain('Memory explosion on 1M items');

    // Token length check: roughly 4 chars per token, ensure < 1500 tokens (< 6000 chars)
    expect(md.length).toBeLessThan(6000);
  });

  it('Backward Compatibility: summary and counts seamlessly handle staked and verified tasks', () => {
    const t1 = taskStore.createTask(cwd, sessionId, { title: 'Task 1' }, 'dev');
    const t2 = taskStore.createTask(cwd, sessionId, { title: 'Task 2' }, 'dev');
    const t3 = taskStore.createTask(cwd, sessionId, { title: 'Task 3' }, 'dev');
    const t4 = taskStore.createTask(cwd, sessionId, { title: 'Task 4' }, 'dev');

    taskStore.claimTask(cwd, sessionId, t1.id, 'Legacy-Agent'); // in_progress
    taskStore.stakeTask(cwd, sessionId, t2.id, 'Modern-Agent'); // staked
    taskStore.claimTask(cwd, sessionId, t3.id, 'Legacy-Agent');
    taskStore.completeTask(cwd, sessionId, t3.id, 'Legacy-Agent', 'Done'); // done
    taskStore.stakeTask(cwd, sessionId, t4.id, 'Modern-Agent');
    taskStore.verifyTask(cwd, sessionId, t4.id, 'Modern-Agent', {
      summary: 'Verified',
      command: 'npm test',
      exitCode: 0,
    }); // verified

    const summary = taskStore.getSummary(cwd, sessionId);
    expect(summary.total).toBe(4);
    // Legacy in_progress + staked are both counted in in_progress
    expect(summary.in_progress).toBe(2);
    // Legacy done + verified are both counted in done
    expect(summary.done).toBe(2);
    // Specific zone counts also available
    expect(summary.staked).toBe(1);
    expect(summary.verified).toBe(1);
  });
});
