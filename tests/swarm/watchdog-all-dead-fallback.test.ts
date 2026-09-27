import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as taskStore from '../../swarm/task-store/index.js';
import { appendTaskEvent } from '../../swarm/task-store/events.js';
import {
  checkAllDead,
  triggerAllDeadFallback,
  resetFallbackLatch,
  isFallbackLatched,
} from '../../swarm/watchdog/fallback.js';
import { generateAttributionBrief } from '../../swarm/watchdog/brief.js';
import { WatchdogService } from '../../swarm/watchdog/service.js';
import { processManager } from '../../swarm/process-manager.js';

function createTempDir(prefix: string = 'all-dead-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pi', 'messenger', 'channels'), { recursive: true });
  return dir;
}

describe('Module 5 R3: All-Dead Fallback Protocol & Attribution Brief', () => {
  let cwd: string;
  const sessionId = 'session-all-dead';

  beforeEach(() => {
    processManager.clear();
    resetFallbackLatch();
    cwd = createTempDir();
  });

  afterEach(() => {
    processManager.clear();
    resetFallbackLatch();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it('detects all-dead state when all hypotheses fail and running workers count is 0', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Impossible task', content: 'Always fails' },
      'dev'
    );

    // Simulate 3 consecutive verification failures transitioning task to dead_end
    appendTaskEvent(cwd, sessionId, {
      taskId: task.id,
      type: 'dead_end',
      timestamp: new Date().toISOString(),
      agent: 'worker-1',
      payload: {
        reason: 'Failed 3 times consecutively on npm test',
        attempts: 3,
        errorLog: 'AssertionError: expected true to be false',
      },
    });

    // Check all-dead across session: 1 task exists, it is dead_end, 0 workers running
    const status = checkAllDead(cwd, sessionId);
    expect(status.isAllDead).toBe(true);
    expect(status.deadEndTasks).toHaveLength(1);
    expect(status.deadEndTasks[0].id).toBe(task.id);
    expect(status.runningWorkerCount).toBe(0);

    // Check targetTaskId
    const statusTarget = checkAllDead(cwd, sessionId, task.id);
    expect(statusTarget.isAllDead).toBe(true);
  });

  it('does NOT trigger all-dead if workers are still actively running or open todo tasks exist', () => {
    const task1 = taskStore.createTask(cwd, sessionId, { title: 'Dead task' }, 'dev');
    appendTaskEvent(cwd, sessionId, {
      taskId: task1.id,
      type: 'dead_end',
      timestamp: new Date().toISOString(),
      agent: 'worker-1',
      payload: { reason: 'Failed', attempts: 3 },
    });

    // Another task is still open in todo
    taskStore.createTask(cwd, sessionId, { title: 'Alternative task' }, 'dev');

    // Across session should be false because todo tasks remain
    const statusWithTodo = checkAllDead(cwd, sessionId);
    expect(statusWithTodo.isAllDead).toBe(false);

    // If workers are currently running in processManager
    processManager.register({
      id: 'active-w',
      name: '[Swarm] worker-active-w',
      agentName: 'active-agent',
      pid: 12345,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    });

    const statusWithRunning = checkAllDead(cwd, sessionId, task1.id);
    expect(statusWithRunning.isAllDead).toBe(false);
  });

  it('generates structured Attribution Brief (<1500 tokens) with proposals, challenges, and error traces', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Complex algorithm', content: 'Implement TSP algorithm' },
      'dev'
    );

    // Add proposal
    taskStore.proposeTask(
      cwd,
      sessionId,
      task.id,
      'expert-1',
      'Use dynamic programming with bitmask'
    );

    // Add challenge
    taskStore.challengeTask(
      cwd,
      sessionId,
      task.id,
      'critic-1',
      'Bitmask DP exceeds 100MB memory on N>20'
    );

    // Simulate verification failure and dead-end
    appendTaskEvent(cwd, sessionId, {
      taskId: task.id,
      type: 'verification_failed',
      timestamp: new Date().toISOString(),
      agent: 'worker-1',
      payload: {
        agent: 'worker-1',
        command: 'npm test tests/tsp.test.ts',
        exitCode: 1,
        output: 'JavaScript heap out of memory at Object.solveTSP',
        attempts: 3,
      },
    });

    appendTaskEvent(cwd, sessionId, {
      taskId: task.id,
      type: 'dead_end',
      timestamp: new Date().toISOString(),
      agent: 'worker-1',
      payload: {
        reason: 'OOM error on all attempts',
        attempts: 3,
      },
    });

    const brief = generateAttributionBrief(cwd, sessionId, task.id);

    expect(brief).toContain('# 🪦 Swarm All-Dead Attribution Brief (避坑死因归因简报)');
    expect(brief).toContain('Complex algorithm');
    expect(brief).toContain('Use dynamic programming with bitmask');
    expect(brief).toContain('Bitmask DP exceeds 100MB memory on N>20');
    expect(brief).toContain('JavaScript heap out of memory');
    expect(brief).toContain('Actionable Next Steps for Main Coding Agent');

    // Strict size constraint (<1500 tokens ~= <6000 chars)
    expect(brief.length).toBeLessThan(6000);
  });

  it('triggers Steer wakeup protocol and dispatches attribution brief to main agent', () => {
    const task = taskStore.createTask(cwd, sessionId, { title: 'Fatal task' }, 'dev');
    appendTaskEvent(cwd, sessionId, {
      taskId: task.id,
      type: 'dead_end',
      timestamp: new Date().toISOString(),
      agent: 'worker-1',
      payload: { reason: 'Fatal syntax error', attempts: 3 },
    });

    const status = checkAllDead(cwd, sessionId);
    expect(status.isAllDead).toBe(true);

    const steerSender = vi.fn();
    const triggered = triggerAllDeadFallback(cwd, sessionId, status, steerSender);

    expect(triggered).toBe(true);
    expect(steerSender).toHaveBeenCalledTimes(1);

    const payload = steerSender.mock.calls[0][0];
    expect(payload.customType).toBe('all_dead_fallback');
    expect(payload.display).toBe(true);
    expect(payload.content).toContain('Swarm All-Dead Attribution Brief');
    expect(payload.details.event).toBe('all_dead');
    expect(payload.details.taskId).toBe(task.id);
  });

  it('enforces idempotency latch: does NOT re-trigger Steer repeatedly for same incident', () => {
    const task = taskStore.createTask(cwd, sessionId, { title: 'Latched task' }, 'dev');
    appendTaskEvent(cwd, sessionId, {
      taskId: task.id,
      type: 'dead_end',
      timestamp: new Date().toISOString(),
      agent: 'worker-1',
      payload: { reason: 'Failure', attempts: 3 },
    });

    const status = checkAllDead(cwd, sessionId);
    const steerSender = vi.fn();

    // First trigger
    expect(triggerAllDeadFallback(cwd, sessionId, status, steerSender)).toBe(true);
    expect(steerSender).toHaveBeenCalledTimes(1);
    expect(isFallbackLatched(sessionId, task.id)).toBe(true);

    // Second trigger attempt should be blocked by latch
    const secondStatus = checkAllDead(cwd, sessionId);
    expect(secondStatus.fallbackTriggered).toBe(true);
    expect(triggerAllDeadFallback(cwd, sessionId, secondStatus, steerSender)).toBe(false);
    expect(steerSender).toHaveBeenCalledTimes(1); // Still 1

    // Resetting latch allows re-trigger
    resetFallbackLatch(sessionId, task.id);
    expect(isFallbackLatched(sessionId, task.id)).toBe(false);

    expect(triggerAllDeadFallback(cwd, sessionId, checkAllDead(cwd, sessionId), steerSender)).toBe(
      true
    );
    expect(steerSender).toHaveBeenCalledTimes(2);
  });

  it('WatchdogService tick() automatically executes lease reclamation and all-dead fallback', () => {
    const task = taskStore.createTask(cwd, sessionId, { title: 'Service test task' }, 'dev');
    appendTaskEvent(cwd, sessionId, {
      taskId: task.id,
      type: 'dead_end',
      timestamp: new Date().toISOString(),
      agent: 'worker-1',
      payload: { reason: 'Fatal error', attempts: 3 },
    });

    const steerSender = vi.fn();
    const service = new WatchdogService(cwd, sessionId, { pollIntervalMs: 5000 }, steerSender);

    const tickResult = service.tick();
    expect(tickResult.allDead.isAllDead).toBe(true);
    expect(steerSender).toHaveBeenCalledTimes(1);

    // Second tick does not re-trigger steer due to latch
    service.tick();
    expect(steerSender).toHaveBeenCalledTimes(1);
  });
});
