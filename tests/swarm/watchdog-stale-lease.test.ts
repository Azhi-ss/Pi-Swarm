import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as taskStore from '../../swarm/task-store/index.js';
import { inspectAndReclaimStaleLeases } from '../../swarm/watchdog/lease.js';
import { processManager } from '../../swarm/process-manager.js';
import { _resetCleanupThrottle } from '../../swarm/task-store/queries.js';

function createTempDir(prefix: string = 'stale-lease-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pi', 'messenger', 'channels'), { recursive: true });
  return dir;
}

describe('Module 5 R2: Stale Lease Reclamation & Blackboard Sync', () => {
  let cwd: string;
  const sessionId = 'session-stale-lease';

  beforeEach(() => {
    processManager.clear();
    cwd = createTempDir();
    _resetCleanupThrottle();
  });

  afterEach(() => {
    processManager.clear();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it('reclaims expired lease when now exceeds lease_expires_at and resets status to todo', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Task to expire', content: 'Will expire' },
      'dev'
    );

    const staked = taskStore.stakeTask(cwd, sessionId, task.id, 'worker-alpha', {
      ttl: 300, // 300s TTL
    });
    expect(staked).toBeDefined();
    expect(staked?.status).toBe('staked');
    expect(staked?.claimed_by).toBe('worker-alpha');

    // Register active agent in registry with living pid
    const regPath = path.join(cwd, '.pi', 'messenger', 'registry', 'worker-alpha.json');
    fs.writeFileSync(regPath, JSON.stringify({ name: 'worker-alpha', pid: process.pid }));

    taskStore.writeBlackboard(cwd, sessionId);
    const bbPath = path.join(cwd, 'BLACKBOARD.md');
    const bbBefore = fs.readFileSync(bbPath, 'utf-8');
    expect(bbBefore).toContain('worker-alpha');
    expect(bbBefore).toContain('## ⚡ Zone 2: Soft Staking');

    // Advance time past 300s TTL (e.g. now + 350s)
    const futureTime = Date.now() + 350_000;
    const result = inspectAndReclaimStaleLeases(cwd, sessionId, futureTime);

    expect(result.reclaimedCount).toBe(1);
    expect(result.reclaimedTasks).toContain(task.id);

    // Verify task state in store is reset to todo and unclaimed
    const updated = taskStore.getTask(cwd, sessionId, task.id);
    expect(updated?.status).toBe('todo');
    expect(updated?.claimed_by).toBeUndefined();
    expect(updated?.claim_reason).toBeUndefined();
    expect(updated?.lease_expires_at).toBeUndefined();

    // Verify BLACKBOARD.md was automatically updated
    const bbAfter = fs.readFileSync(bbPath, 'utf-8');
    expect(bbAfter).toContain('## 🎯 Zone 1: Goal & Open Backlog');
    expect(bbAfter).toContain(task.id);
  });

  it('reclaims early when claimant process is dead, even before 300s TTL expires', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Crash test task', content: 'Worker crashes' },
      'dev'
    );

    taskStore.stakeTask(cwd, sessionId, task.id, 'crashed-worker', {
      ttl: 300,
    });

    // Record dead PID in messenger registry (PID 99999999 is dead)
    const deadPid = 99999999;
    const regPath = path.join(cwd, '.pi', 'messenger', 'registry', 'crashed-worker.json');
    fs.writeFileSync(regPath, JSON.stringify({ name: 'crashed-worker', pid: deadPid }));

    // Do NOT advance time - lease is fresh (only 1 second after)
    const currentTime = Date.now() + 1000;
    const result = inspectAndReclaimStaleLeases(cwd, sessionId, currentTime);

    expect(result.reclaimedCount).toBe(1);
    expect(result.reclaimedTasks).toContain(task.id);

    const updated = taskStore.getTask(cwd, sessionId, task.id);
    expect(updated?.status).toBe('todo');
    expect(updated?.claimed_by).toBeUndefined();
  });

  it('reclaims early when worker status in ProcessManager is stopped or failed', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'ProcessManager dead test', content: 'Fails in PM' },
      'dev'
    );

    taskStore.stakeTask(cwd, sessionId, task.id, 'pm-worker', {
      ttl: 300,
    });

    // Register in processManager as stopped
    processManager.register({
      id: 'pm-w1',
      name: '[Swarm] worker-pm-w1',
      agentName: 'pm-worker',
      pid: 888888,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'stopped',
      timeoutMs: 600_000,
    });

    const result = inspectAndReclaimStaleLeases(cwd, sessionId, Date.now());
    expect(result.reclaimedCount).toBe(1);
    expect(result.reclaimedTasks).toContain(task.id);

    const updated = taskStore.getTask(cwd, sessionId, task.id);
    expect(updated?.status).toBe('todo');
    expect(updated?.claimed_by).toBeUndefined();
  });

  it('reclaims a dead local claimant even when another project has a live peer of the same name', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Owned by this run', content: 'Foreign liveness must not count' },
      'dev'
    );
    taskStore.stakeTask(cwd, sessionId, task.id, 'shared-name', { ttl: 300 });
    const other = createTempDir('stale-lease-other-');
    processManager.register({
      id: 'foreign-live',
      name: '[Swarm] worker-foreign-live',
      agentName: 'shared-name',
      pid: process.pid,
      cwd: other,
      runId: 'other-run',
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    });
    processManager.register({
      id: 'local-dead',
      name: '[Swarm] worker-local-dead',
      agentName: 'shared-name',
      pid: 99999999,
      cwd,
      runId: sessionId,
      startedAt: new Date().toISOString(),
      status: 'stopped',
      timeoutMs: 600_000,
    });

    const result = inspectAndReclaimStaleLeases(cwd, sessionId, Date.now());
    expect(result.reclaimedCount).toBe(1);
    expect(taskStore.getTask(cwd, sessionId, task.id)?.status).toBe('todo');
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('preserves active tasks claimed by living workers with unexpired leases', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Healthy task', content: 'Should stay staked' },
      'dev'
    );

    taskStore.stakeTask(cwd, sessionId, task.id, 'healthy-worker', {
      ttl: 300,
    });

    processManager.register({
      id: 'h-w1',
      name: '[Swarm] worker-h-w1',
      agentName: 'healthy-worker',
      pid: process.pid,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    });

    const result = inspectAndReclaimStaleLeases(cwd, sessionId, Date.now() + 5000);
    expect(result.reclaimedCount).toBe(0);

    const current = taskStore.getTask(cwd, sessionId, task.id);
    expect(current?.status).toBe('staked');
    expect(current?.claimed_by).toBe('healthy-worker');
  });

  it('allows another worker to immediately stake a reclaimed task without locking issues', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Preemption handoff task', content: 'Reclaim and re-stake' },
      'dev'
    );

    taskStore.stakeTask(cwd, sessionId, task.id, 'failing-agent', { ttl: 300 });

    // Mark as failed in processManager
    processManager.register({
      id: 'fail-1',
      name: '[Swarm] worker-fail-1',
      agentName: 'failing-agent',
      pid: 777777,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'failed',
      timeoutMs: 600_000,
    });

    // Reclaim
    const result = inspectAndReclaimStaleLeases(cwd, sessionId, Date.now());
    expect(result.reclaimedCount).toBe(1);

    // Another worker stakes the newly freed task
    const reStaked = taskStore.stakeTask(cwd, sessionId, task.id, 'hero-agent', {
      ttl: 300,
      reason: 'Taking over from failed agent',
    });

    expect(reStaked).toBeDefined();
    expect(reStaked?.status).toBe('staked');
    expect(reStaked?.claimed_by).toBe('hero-agent');
    expect(reStaked?.claim_reason).toBe('Taking over from failed agent');
  });

  it('cleanupStaleTaskClaims in queries.ts automatically calls writeBlackboard', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Query cleanup test', content: 'Auto bb sync' },
      'dev'
    );

    taskStore.stakeTask(cwd, sessionId, task.id, 'dead-claimant', { ttl: 300 });
    // Write dead PID in registry to trigger cleanup
    const regPath = path.join(cwd, '.pi', 'messenger', 'registry', 'dead-claimant.json');
    fs.writeFileSync(regPath, JSON.stringify({ name: 'dead-claimant', pid: 99999999 }));

    taskStore.writeBlackboard(cwd, sessionId);
    const bbBefore = fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf-8');
    expect(bbBefore).toContain('dead-claimant');

    _resetCleanupThrottle();

    // Trigger getTasks: cleanupStaleTaskClaims detects dead PID and cleans up
    const tasks = taskStore.getTasks(cwd, sessionId);
    expect(tasks).toBeDefined();

    // Verify task is cleaned up
    const reloaded = taskStore.getTask(cwd, sessionId, task.id);
    expect(reloaded?.status).toBe('todo');

    // Verify blackboard was automatically updated
    const bbAfter = fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf-8');
    expect(bbAfter).toContain('## 🎯 Zone 1: Goal & Open Backlog');
  });
});
