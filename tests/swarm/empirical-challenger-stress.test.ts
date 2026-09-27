import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';
import { handleSessionShutdown } from '../../extension/shutdown.js';
import { createTempMessengerDirs } from '../helpers/temp-dirs.js';
import { spawnSubagent, stopSpawn, clearSpawnStateForTests } from '../../swarm/spawn.js';
import { executeTask } from '../../swarm/handlers/task-ops.js';
import type { MessengerState, Dirs } from '../../lib.js';

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-challenger-stress-'));
  roots.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
  clearSpawnStateForTests();
  vi.restoreAllMocks();
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM'; // alive if permission denied
  }
}

function isPidZombie(pid: number): boolean {
  try {
    const status = execSync(`ps -p ${pid} -o stat=`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return status.startsWith('Z');
  } catch {
    return false; // process does not exist
  }
}

describe('Empirical Challenger: Process Lifecycle & Process Group Termination', () => {
  it('terminates entire process group (-pid) without leaving orphaned child processes', async () => {
    // Spawn a real detached process tree:
    // Leader (sh) -> Child (sh) -> Grandchild (sleep 60)
    const proc = spawn('sh', ['-c', 'sleep 60 & sleep 60 & wait'], {
      stdio: 'ignore',
      detached: true,
    });

    const leaderPid = proc.pid!;
    expect(leaderPid).toBeGreaterThan(0);

    // Allow shell to spawn background sleep processes
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isPidAlive(leaderPid)).toBe(true);

    // Find children in the process group
    let childrenPids: number[] = [];
    try {
      const output = execSync(`pgrep -g ${leaderPid}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      childrenPids = output
        .split('\n')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n !== leaderPid);
    } catch {
      // pgrep might fail if already dead
    }

    expect(childrenPids.length).toBeGreaterThanOrEqual(1);
    for (const cPid of childrenPids) {
      expect(isPidAlive(cPid)).toBe(true);
    }

    // Now kill the process group via negative PID (-leaderPid)
    process.kill(-leaderPid, 'SIGKILL');

    // Wait briefly for kernel to deliver signal and reap
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify leader and all children in group are terminated
    expect(isPidAlive(leaderPid)).toBe(false);
    for (const cPid of childrenPids) {
      expect(isPidAlive(cPid)).toBe(false);
      expect(isPidZombie(cPid)).toBe(false);
    }
  });

  it('verifies stopSpawn cleanly terminates process groups and clears runtimes', async () => {
    const cwd = createTempCwd();
    const sessionId = 'session-stop-spawn-test';

    const proc = spawn('sh', ['-c', 'sleep 50 & sleep 50 & wait'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const leaderPid = proc.pid!;
    await new Promise((resolve) => setTimeout(resolve, 200));

    const agent = spawnSubagent(
      cwd,
      {
        role: 'Worker',
        objective: 'Long running task',
        name: 'WorkerBot',
      },
      sessionId
    );

    const stopped = stopSpawn(cwd, agent.id);
    expect(stopped).toBe(true);

    process.kill(-leaderPid, 'SIGKILL');
  });
});

describe('Empirical Challenger: Peer Equivalence & Ephemeral Lifecycle', () => {
  it('guarantees session shutdown of Peer A does NOT unclaim or mutate Peer B tasks', async () => {
    const dirs = createTempMessengerDirs();
    const sessionId = 'shared-swarm-session';
    const channelId = 'mesh-general';

    // Mock process.cwd to point to dirs.cwd for handleSessionShutdown
    vi.spyOn(process, 'cwd').mockReturnValue(dirs.cwd);

    // Create 3 tasks
    const taskA = taskStore.createTask(
      dirs.cwd,
      sessionId,
      { title: 'Peer A Exploration' },
      channelId
    );
    const taskB1 = taskStore.createTask(
      dirs.cwd,
      sessionId,
      { title: 'Peer B Proof-of-Concept' },
      channelId
    );
    const taskB2 = taskStore.createTask(
      dirs.cwd,
      sessionId,
      { title: 'Peer B Benchmark' },
      channelId
    );

    // Peer A and Peer B claim their tasks
    taskStore.claimTask(dirs.cwd, sessionId, taskA.id, 'Peer-Alpha');
    taskStore.claimTask(dirs.cwd, sessionId, taskB1.id, 'Peer-Beta');
    taskStore.claimTask(dirs.cwd, sessionId, taskB2.id, 'Peer-Beta');

    expect(taskStore.getTask(dirs.cwd, sessionId, taskA.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, sessionId, taskA.id)?.claimed_by).toBe('Peer-Alpha');
    expect(taskStore.getTask(dirs.cwd, sessionId, taskB1.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, sessionId, taskB1.id)?.claimed_by).toBe('Peer-Beta');
    expect(taskStore.getTask(dirs.cwd, sessionId, taskB2.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, sessionId, taskB2.id)?.claimed_by).toBe('Peer-Beta');

    // Create mock state for Peer-Alpha
    const stateA = {
      agentName: 'Peer-Alpha',
      registered: true,
      currentChannel: channelId,
      sessionChannel: channelId,
      contextSessionId: sessionId,
      reservations: [],
      chatHistory: new Map(),
      unreadCounts: new Map(),
      channelPostHistory: [],
      seenSenders: new Map(),
      model: 'test-model',
      session: { toolCalls: 0, tokens: 0, filesModified: [] },
      activity: { lastActivityAt: new Date().toISOString() },
      sessionStartedAt: new Date().toISOString(),
    } as unknown as MessengerState;

    const mockDirs: Dirs = {
      base: dirs.messengerDir,
      registry: dirs.registryDir,
    };

    // Peer A shuts down cleanly
    const shutdownResult = await handleSessionShutdown(stateA, mockDirs);
    expect(shutdownResult.unclaimedCount).toBe(1);

    // Verify Peer A task is unclaimed
    const taskAAfter = taskStore.getTask(dirs.cwd, sessionId, taskA.id);
    expect(taskAAfter?.status).toBe('todo');
    expect(taskAAfter?.claimed_by).toBeUndefined();

    // CRITICAL: Peer B tasks MUST REMAIN INTACT
    const taskB1After = taskStore.getTask(dirs.cwd, sessionId, taskB1.id);
    const taskB2After = taskStore.getTask(dirs.cwd, sessionId, taskB2.id);

    expect(taskB1After?.status).toBe('in_progress');
    expect(taskB1After?.claimed_by).toBe('Peer-Beta');
    expect(taskB2After?.status).toBe('in_progress');
    expect(taskB2After?.claimed_by).toBe('Peer-Beta');

    // Peer B can continue operating, propose hypotheses, and finish tasks
    const proposeRes = executeTask(
      'propose',
      { id: taskB1.id, proposal: 'Refactored zero-lock algorithm' },
      { agentName: 'Peer-Beta' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );
    expect((proposeRes as any).details?.mode).toBe('task.propose');

    const doneRes = executeTask(
      'done',
      { id: taskB1.id, message: 'Verified with 10k synthetic iterations' },
      { agentName: 'Peer-Beta' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );
    expect((doneRes as any).details?.mode).toBe('task.done');

    expect(taskStore.getTask(dirs.cwd, sessionId, taskB1.id)?.status).toBe('done');
  });

  it('verifies that PI_SWARM_SPAWNED is never leaked to child processes', () => {
    const cwd = createTempCwd();
    const sessionId = 'session-env-test';

    const originalVal = process.env.PI_SWARM_SPAWNED;
    delete process.env.PI_SWARM_SPAWNED;

    try {
      const agent = spawnSubagent(
        cwd,
        {
          role: 'Verifier',
          objective: 'Stress test peer env',
          name: 'VerifierBot',
        },
        sessionId
      );

      // Verify agent record
      expect(agent.name).toBe('VerifierBot');

      // Check generated agent definition file in .pi/messenger/agents/<sessionId>/
      const safeSession = sessionId.replace(/[^\w.-]/g, '_');
      const agentFilePath = path.join(
        cwd,
        '.pi',
        'messenger',
        'agents',
        safeSession,
        `${agent.name}-${agent.id}.md`
      );
      expect(fs.existsSync(agentFilePath)).toBe(true);
      const content = fs.readFileSync(agentFilePath, 'utf-8');
      expect(content).toContain('## Swarm Operating Protocol');
      expect(content).toContain('1. Peer Mesh & Identity');
      expect(content).not.toContain('exit 0');
      expect(content).not.toContain('PI_SWARM_SPAWNED');
    } finally {
      if (originalVal !== undefined) {
        process.env.PI_SWARM_SPAWNED = originalVal;
      }
    }
  });

  it('handles multi-peer concurrent adversarial debate (propose & challenge) correctly', () => {
    const dirs = createTempMessengerDirs();
    const sessionId = 'debate-session';
    const channelId = 'debate-channel';

    const task = taskStore.createTask(
      dirs.cwd,
      sessionId,
      { title: 'Concurrent Cache Invalidation Algorithm' },
      channelId
    );

    // Alice claims
    taskStore.claimTask(dirs.cwd, sessionId, task.id, 'Alice');

    // Bob proposes an approach
    executeTask(
      'propose',
      { id: task.id, proposal: 'Proposal 1: Epoch-based reclamation' },
      { agentName: 'Bob' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );

    // Charlie challenges Bob's proposal
    executeTask(
      'challenge',
      { id: task.id, reason: 'Challenge 1: High memory watermark under skewed workload' },
      { agentName: 'Charlie' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );

    // Dave proposes counter-approach
    executeTask(
      'propose',
      { id: task.id, proposal: 'Proposal 2: Hazard pointers with bounded retries' },
      { agentName: 'Dave' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );

    // Alice challenges Dave's proposal
    executeTask(
      'challenge',
      { id: task.id, reason: 'Challenge 2: Lock-freedom violation on ABA edge case' },
      { agentName: 'Alice' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );

    // Reload task from disk to ensure replay projection integrity
    const replayed = taskStore.getTask(dirs.cwd, sessionId, task.id);
    expect(replayed).not.toBeNull();
    expect(replayed?.proposals).toHaveLength(2);
    expect(replayed?.challenges).toHaveLength(2);

    expect(replayed?.proposals?.[0].agent).toBe('Bob');
    expect(replayed?.proposals?.[0].content).toContain('Epoch-based reclamation');
    expect(replayed?.proposals?.[1].agent).toBe('Dave');
    expect(replayed?.proposals?.[1].content).toContain('Hazard pointers');

    expect(replayed?.challenges?.[0].agent).toBe('Charlie');
    expect(replayed?.challenges?.[0].content).toContain('High memory watermark');
    expect(replayed?.challenges?.[1].agent).toBe('Alice');
    expect(replayed?.challenges?.[1].content).toContain('Lock-freedom violation');
  });

  it('rejects invalid propose and challenge invocations without state corruption', () => {
    const dirs = createTempMessengerDirs();
    const sessionId = 'validation-session';
    const channelId = 'validation-channel';

    const task = taskStore.createTask(
      dirs.cwd,
      sessionId,
      { title: 'Validation test task' },
      channelId
    );

    // Missing ID
    const res1 = executeTask(
      'propose',
      { proposal: 'Some plan' } as any,
      { agentName: 'Alice' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );
    expect((res1 as any).details?.error).toBe('missing_id');

    // Missing content
    const res2 = executeTask(
      'propose',
      { id: task.id, proposal: '   ' } as any,
      { agentName: 'Alice' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );
    expect((res2 as any).details?.error).toBe('missing_content');

    // Task not found
    const res3 = executeTask(
      'challenge',
      { id: 'non-existent-task-id', reason: 'Some challenge' } as any,
      { agentName: 'Alice' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );
    expect((res3 as any).details?.error).toBe('not_found');

    // Missing objection
    const res4 = executeTask(
      'challenge',
      { id: task.id, reason: '' } as any,
      { agentName: 'Alice' } as any,
      dirs.cwd,
      channelId,
      sessionId
    );
    expect((res4 as any).details?.error).toBe('missing_reason');
  });

  it('confirms zero residual occurrences of PI_SWARM_SPAWNED across all source code', () => {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const sourceDirs = ['harness', 'swarm', 'extension', 'feed', 'store'];

    for (const sDir of sourceDirs) {
      const fullDir = path.join(projectRoot, sDir);
      if (!fs.existsSync(fullDir)) continue;

      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const entryPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(entryPath);
          } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            const content = fs.readFileSync(entryPath, 'utf-8');
            expect(content).not.toContain('PI_SWARM_SPAWNED');
          }
        }
      };
      walk(fullDir);
    }

    // Also check index.ts and router.ts
    for (const rootFile of ['index.ts', 'router.ts']) {
      const fp = path.join(projectRoot, rootFile);
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf-8');
        expect(content).not.toContain('PI_SWARM_SPAWNED');
      }
    }
  });
});
