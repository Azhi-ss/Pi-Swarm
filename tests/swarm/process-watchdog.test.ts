import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  processManager,
  forceKillProcessGroup,
  adoptWorkerIfSupported,
  type ManagedWorkerProcess,
} from '../../swarm/process-manager.js';
import { createWorktree, pruneWorktrees } from '../../swarm/worktree/manager.js';

function createTempDir(prefix: string = 'proc-watchdog-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir: string): void {
  cp.spawnSync('git init -b main', { cwd: dir, shell: true });
  cp.spawnSync('git config user.name "Test User"', { cwd: dir, shell: true });
  cp.spawnSync('git config user.email "test@example.com"', { cwd: dir, shell: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n', 'utf-8');
  cp.spawnSync('git add .', { cwd: dir, shell: true });
  cp.spawnSync('git commit -m "init"', { cwd: dir, shell: true });
}

describe('Module 5 R1: Physical Process Supervision via ps / ProcessManager', () => {
  let cwd: string;

  beforeEach(() => {
    processManager.clear();
    cwd = createTempDir();
  });

  afterEach(() => {
    processManager.clear();
    try {
      pruneWorktrees(cwd);
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it('registers a managed worker with standard naming format [Swarm] worker-<id>', () => {
    const worker: ManagedWorkerProcess = {
      id: 'abc12345',
      name: '[Swarm] worker-abc12345',
      agentName: 'swift-falcon',
      pid: 12345,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    };

    processManager.register(worker);

    const retrieved = processManager.get('abc12345');
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe('[Swarm] worker-abc12345');
    expect(retrieved?.agentName).toBe('swift-falcon');
    expect(retrieved?.status).toBe('running');
    expect(retrieved?.timeoutMs).toBe(600_000);

    // Lookup by agent name
    expect(processManager.get('swift-falcon')?.id).toBe('abc12345');
    // Lookup by formatted process name
    expect(processManager.get('[Swarm] worker-abc12345')?.id).toBe('abc12345');

    const runningList = processManager.list();
    expect(runningList).toHaveLength(1);
    expect(runningList[0].id).toBe('abc12345');
  });

  it('captures stdout and stderr in rolling ring buffer with getLogs', () => {
    const worker: ManagedWorkerProcess = {
      id: 'log-worker-1',
      name: '[Swarm] worker-log-worker-1',
      agentName: 'log-bot',
      pid: 12345,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    };

    processManager.register(worker);
    processManager.appendLog('log-worker-1', 'stdout', 'Starting worker...\n');
    processManager.appendLog('log-worker-1', 'stdout', 'Running tests...\nAll passed.');
    processManager.appendLog('log-worker-1', 'stderr', 'Warning: deprecated API\n');

    const logs = processManager.getLogs('log-worker-1');
    expect(logs.stdout).toContain('Starting worker...');
    expect(logs.stdout).toContain('All passed.');
    expect(logs.stderr).toContain('Warning: deprecated API');
  });

  it('triggers hard timeout when worker duration exceeds limit and marks timeout status', async () => {
    const onTimeout = vi.fn();
    const mockProc = {
      pid: 999999,
      kill: vi.fn(),
      once: vi.fn(),
    } as any;

    const worker: ManagedWorkerProcess = {
      id: 'timeout-worker',
      name: '[Swarm] worker-timeout-worker',
      agentName: 'slow-turtle',
      pid: 999999,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 60, // 60ms fast timeout for test
    };

    processManager.register(worker, mockProc, onTimeout);

    await new Promise((r) => setTimeout(r, 120));

    const updated = processManager.get('timeout-worker');
    expect(updated?.status).toBe('timeout');
    expect(updated?.error).toContain('timed out after 60ms');
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // The logs should reflect the timeout kill
    const logs = processManager.getLogs('timeout-worker');
    expect(logs.stderr).toContain('exceeded hard timeout');
  });

  it('kills process group and coordinates worktree sandbox cleanup', () => {
    initGitRepo(cwd);
    const worktree = createWorktree(cwd, 'wt-worker-1', 'test-agent');
    expect(fs.existsSync(worktree.worktreePath)).toBe(true);

    const child = cp.spawn('sleep', ['30'], { detached: true });

    const worker: ManagedWorkerProcess = {
      id: 'wt-worker-1',
      name: '[Swarm] worker-wt-worker-1',
      agentName: 'sandbox-worker',
      pid: child.pid!,
      cwd,
      worktreePath: worktree.worktreePath,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    };

    processManager.register(worker, child);

    // Verify it is listed
    expect(processManager.list().some((w) => w.id === 'wt-worker-1')).toBe(true);

    // Call kill
    const stopped = processManager.kill('wt-worker-1', 'SIGKILL');
    expect(stopped).toBe(true);

    const updated = processManager.get('wt-worker-1');
    expect(updated?.status).toBe('stopped');
    expect(processManager.list()).toHaveLength(0); // Not in running list
    expect(processManager.list(true)).toHaveLength(1); // In all list

    // Sandbox worktree should have been removed
    expect(fs.existsSync(worktree.worktreePath)).toBe(false);
  });

  it('batch terminates all running workers via killAll', () => {
    const worker1: ManagedWorkerProcess = {
      id: 'batch-1',
      name: '[Swarm] worker-batch-1',
      agentName: 'batch-agent-1',
      pid: 11111,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    };
    const worker2: ManagedWorkerProcess = {
      id: 'batch-2',
      name: '[Swarm] worker-batch-2',
      agentName: 'batch-agent-2',
      pid: 22222,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    };

    processManager.register(worker1);
    processManager.register(worker2);

    expect(processManager.list()).toHaveLength(2);

    processManager.killAll('SIGKILL');

    expect(processManager.list()).toHaveLength(0);
    expect(processManager.get('batch-1')?.status).toBe('stopped');
    expect(processManager.get('batch-2')?.status).toBe('stopped');
  });

  it('forceKillProcessGroup handles positive and negative PIDs gracefully', () => {
    // Should not throw on non-existent PID
    expect(() => forceKillProcessGroup(99999999, 'SIGKILL')).not.toThrow();
    expect(() => forceKillProcessGroup(0, 'SIGKILL')).not.toThrow();
    expect(() => forceKillProcessGroup(-1, 'SIGKILL')).not.toThrow();
  });

  it('supports adoptWorkerIfSupported when pi.events listener is registered', () => {
    const emittedEvents: Array<{ event: string; payload: any }> = [];
    const mockPi = {
      events: {
        listenerCount: (event: string) => (event === 'processes:command:adopt' ? 1 : 0),
        emit: (event: string, payload: any) => {
          emittedEvents.push({ event, payload });
          return true;
        },
      },
    };

    const worker: ManagedWorkerProcess = {
      id: 'adopt-worker',
      name: '[Swarm] worker-adopt-worker',
      agentName: 'adopt-agent',
      pid: 12345,
      cwd: '/test/cwd',
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    };
    const mockProc = { pid: 12345 } as any;

    const adopted = adoptWorkerIfSupported(mockPi, worker, mockProc);
    expect(adopted).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].event).toBe('processes:command:adopt');
    expect(emittedEvents[0].payload.name).toBe('[Swarm] worker-adopt-worker');
    expect(emittedEvents[0].payload.cwd).toBe('/test/cwd');

    // Without listener count, returns false gracefully
    const mockPiNoListeners = {
      events: {
        listenerCount: () => 0,
        emit: vi.fn(),
      },
    };
    expect(adoptWorkerIfSupported(mockPiNoListeners, worker, mockProc)).toBe(false);
  });
});
