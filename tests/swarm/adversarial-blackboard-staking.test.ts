import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as taskStore from '../../swarm/task-store/index.js';
import { taskStake } from '../../swarm/handlers/task-lifecycle.js';
import type { SwarmTask } from '../../swarm/types.js';
import type { MessengerState } from '../../state.js';

function createTempCwd(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-adv-bb-'));
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'channels'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'tasks'), { recursive: true });
  return tmp;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockState(agentName: string): MessengerState {
  return {
    agentName,
    activeChannel: 'dev',
    currentChannel: 'dev',
    channels: ['dev'],
    unreadCounts: {},
    knownAgents: [agentName],
    taskFilter: 'all',
  } as unknown as MessengerState;
}

describe('Adversarial Test Suite: Module 3 Four-Zone Blackboard & Soft Staking with TTL Leases', () => {
  let cwd: string;
  const sessionId = 'adversarial-bb-session';

  beforeEach(() => {
    cwd = createTempCwd();
  });

  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // 1. Opportunistic Preemption Under Real & Simulated Clock Expiration
  // =========================================================================
  describe('1. Opportunistic Preemption Semantics', () => {
    it('allows Agent B to preempt Agent A after real 1-second TTL expires', async () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Preemption candidate' }, 'dev');

      // 1. Agent A stakes with TTL 1s
      const stakedA = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-A', {
        ttl: 1,
        reason: 'Investigating approach A',
      });
      expect(stakedA).not.toBeNull();
      expect(stakedA!.claimed_by).toBe('Agent-A');
      expect(stakedA!.status).toBe('staked');
      expect(stakedA!.lease_ttl).toBe(1);

      // 2. Immediate preemption attempt by Agent B is strictly rejected
      const earlyPreempt = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-B', {
        ttl: 300,
        reason: 'Eager preempt attempt',
      });
      expect(earlyPreempt).toBeNull();

      // Verify Agent A is still owner
      const currentTask = taskStore.getTask(cwd, sessionId, task.id);
      expect(currentTask!.claimed_by).toBe('Agent-A');

      // 3. Wait for TTL to lapse (1.15s)
      await sleep(1150);

      // Verify isLeaseExpired reports true
      const expiredTask = taskStore.getTask(cwd, sessionId, task.id)!;
      expect(taskStore.isLeaseExpired(expiredTask)).toBe(true);

      // 4. Agent B opportunistically preempts without error
      const preemptSuccess = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-B', {
        ttl: 300,
        reason: 'Opportunistic preemption of expired lease',
      });

      expect(preemptSuccess).not.toBeNull();
      expect(preemptSuccess!.claimed_by).toBe('Agent-B');
      expect(preemptSuccess!.status).toBe('staked');
      expect(preemptSuccess!.lease_ttl).toBe(300);
      expect(preemptSuccess!.claim_reason).toBe('Opportunistic preemption of expired lease');
      expect(taskStore.isLeaseExpired(preemptSuccess!)).toBe(false);

      // 5. Verify JSONL event sequence integrity
      const tasksJsonl = path.join(cwd, '.pi', 'messenger', 'tasks', `${sessionId}.jsonl`);
      const lines = fs.readFileSync(tasksJsonl, 'utf-8').trim().split('\n');
      const eventTypes = lines.map((l) => JSON.parse(l).type);
      expect(eventTypes).toEqual(['created', 'staked', 'released', 'staked']);

      const events = lines.map((l) => JSON.parse(l));
      expect(events[1].agent).toBe('Agent-A');
      expect(events[2].type).toBe('released');
      expect(events[2].agent).toBe('Agent-A');
      expect(events[3].agent).toBe('Agent-B');
    }, 10000);

    it('supports chained sequential preemptions across 3 agents without corruption', async () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Chain preemption task' }, 'dev');

      // Agent 1 stakes with TTL 1s
      taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-1', { ttl: 1 });
      await sleep(1250);

      // Agent 2 preempts with TTL 1s
      const p2 = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-2', { ttl: 1 });
      expect(p2).not.toBeNull();
      expect(p2!.claimed_by).toBe('Agent-2');
      await sleep(1250);

      // Agent 3 preempts with TTL 300s
      const p3 = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-3', { ttl: 300 });
      expect(p3).not.toBeNull();
      expect(p3!.claimed_by).toBe('Agent-3');
      expect(p3!.attempt_count).toBe(3);

      // Displaced agents cannot complete the task
      expect(taskStore.completeTask(cwd, sessionId, task.id, 'Agent-1', 'Done')).toBeNull();
      expect(taskStore.completeTask(cwd, sessionId, task.id, 'Agent-2', 'Done')).toBeNull();

      // Current rightful claimant can complete the task
      const completed = taskStore.completeTask(cwd, sessionId, task.id, 'Agent-3', 'Success');
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('done');
      expect(completed!.completed_by).toBe('Agent-3');
    }, 10000);

    it('allows legacy claimTask to opportunistically preempt an expired lease', async () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Legacy preemption' }, 'dev');

      taskStore.stakeTask(cwd, sessionId, task.id, 'Modern-Agent', { ttl: 1 });
      await sleep(1150);

      // Legacy agent uses claimTask
      const claimed = taskStore.claimTask(cwd, sessionId, task.id, 'Legacy-Agent');
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe('in_progress');
      expect(claimed!.claimed_by).toBe('Legacy-Agent');
    }, 10000);

    it('enforces preemption semantics through taskStake handler', async () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Handler preemption' }, 'dev');
      const stateA = createMockState('Worker-Alpha');
      const stateB = createMockState('Worker-Beta');

      // 1. Worker-Alpha stakes via handler with TTL 1s
      const resA = taskStake({ id: task.id, ttl: 1 }, stateA, cwd, 'dev', sessionId);
      expect(resA.details?.mode).toBe('task.stake');
      expect(resA.details?.task?.claimed_by).toBe('Worker-Alpha');

      // 2. Worker-Beta tries before expiry -> rejected with already_claimed
      const resB_early = taskStake({ id: task.id, ttl: 300 }, stateB, cwd, 'dev', sessionId);
      expect(resB_early.details?.error).toBe('already_claimed');

      // 3. Wait 1.15s
      await sleep(1150);

      // 4. Worker-Beta preempts via handler -> succeeds
      const resB_late = taskStake({ id: task.id, ttl: 300 }, stateB, cwd, 'dev', sessionId);
      expect(resB_late.details?.mode).toBe('task.stake');
      expect(resB_late.details?.task?.claimed_by).toBe('Worker-Beta');
    }, 10000);
  });

  // =========================================================================
  // 2. Unexpired Lease Contention & Access Control Invariants
  // =========================================================================
  describe('2. Unexpired Lease Contention & Access Control Invariants', () => {
    it('strictly rejects any unauthorized mutation on active lease', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Protected task' }, 'dev');
      taskStore.stakeTask(cwd, sessionId, task.id, 'Legit-Owner', { ttl: 300 });

      // Staking attempt by impostor
      expect(taskStore.stakeTask(cwd, sessionId, task.id, 'Impostor-Agent')).toBeNull();

      // Legacy claim by impostor
      expect(taskStore.claimTask(cwd, sessionId, task.id, 'Impostor-Agent')).toBeNull();

      // Complete attempt by impostor
      expect(
        taskStore.completeTask(cwd, sessionId, task.id, 'Impostor-Agent', 'hijack')
      ).toBeNull();

      // Verify attempt by impostor
      expect(
        taskStore.verifyTask(cwd, sessionId, task.id, 'Impostor-Agent', {
          summary: 'hijack verify',
          command: 'npm test',
          exitCode: 0,
        })
      ).toBeNull();

      // Unclaim attempt by impostor
      expect(taskStore.unclaimTask(cwd, sessionId, task.id, 'Impostor-Agent')).toBeNull();

      // Lease renewal attempt by impostor
      expect(taskStore.renewTaskLease(cwd, sessionId, task.id, 'Impostor-Agent', 600)).toBeNull();

      // Task remains strictly untouched
      const verifiedOwner = taskStore.getTask(cwd, sessionId, task.id)!;
      expect(verifiedOwner.claimed_by).toBe('Legit-Owner');
      expect(verifiedOwner.status).toBe('staked');
      expect(verifiedOwner.lease_ttl).toBe(300);
    });

    it('withstands a barrage of concurrent rogue operations against an active lease', async () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'High security task' }, 'dev');
      taskStore.stakeTask(cwd, sessionId, task.id, 'Owner-Prime', { ttl: 300 });

      const rogueAgents = Array.from({ length: 20 }, (_, i) => `Rogue-${i + 1}`);

      // Fire 100 mixed rogue operations concurrently
      const operations = Array.from({ length: 100 }, (_, i) => {
        const agent = rogueAgents[i % rogueAgents.length];
        const opType = i % 5;
        return Promise.resolve().then(() => {
          switch (opType) {
            case 0:
              return taskStore.stakeTask(cwd, sessionId, task.id, agent);
            case 1:
              return taskStore.claimTask(cwd, sessionId, task.id, agent);
            case 2:
              return taskStore.completeTask(cwd, sessionId, task.id, agent, 'pwned');
            case 3:
              return taskStore.verifyTask(cwd, sessionId, task.id, agent, {
                summary: 'pwned',
                command: 'test',
                exitCode: 0,
              });
            case 4:
              return taskStore.unclaimTask(cwd, sessionId, task.id, agent);
          }
        });
      });

      const results = await Promise.all(operations);
      // All 100 rogue operations must be strictly null
      expect(results.every((r) => r === null)).toBe(true);

      // Assert event log has no rogue mutations (only 'created' and initial 'staked')
      const tasksJsonl = path.join(cwd, '.pi', 'messenger', 'tasks', `${sessionId}.jsonl`);
      const lines = fs.readFileSync(tasksJsonl, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);

      const current = taskStore.getTask(cwd, sessionId, task.id)!;
      expect(current.claimed_by).toBe('Owner-Prime');
      expect(current.status).toBe('staked');
    });

    it('progress heartbeat extends lease expiration and prevents premature preemption', () => {
      // Lease arithmetic uses wall time; a frozen clock keeps it independent of machine load.
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      try {
        const task = taskStore.createTask(cwd, sessionId, { title: 'Heartbeat task' }, 'dev');
        taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-HB', { ttl: 2 }); // 2-second lease

        // At 800ms, agent posts progress
        vi.setSystemTime(start + 800);
        taskStore.appendTaskProgress(cwd, sessionId, task.id, 'Agent-HB', 'Processing chunk 1/3');

        // Verify lease expiration was bumped forward
        const refreshedTask = taskStore.getTask(cwd, sessionId, task.id)!;
        const initialStakeTime = Date.parse(refreshedTask.claimed_at!);
        const currentExpiry = Date.parse(refreshedTask.lease_expires_at!);
        // Expiration is now 2s from progress timestamp, which is > initialStakeTime + 2000
        expect(currentExpiry).toBeGreaterThan(initialStakeTime + 2000);

        // At 2100ms from start (which would have expired the initial 2s lease):
        vi.setSystemTime(start + 2100);
        // Agent-B attempts to preempt -> must be rejected because progress kept it alive!
        const preemptFail = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-Preempt');
        expect(preemptFail).toBeNull();

        // Now wait until the refreshed lease expires (progress was at 800ms + 2000ms = 2800ms)
        vi.setSystemTime(start + 3200);
        const preemptSuccess = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-Preempt');
        expect(preemptSuccess).not.toBeNull();
        expect(preemptSuccess!.claimed_by).toBe('Agent-Preempt');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // 3. Multi-Agent Concurrent Staking Race Conditions
  // =========================================================================
  describe('3. Multi-Agent Concurrent Staking Race Conditions', () => {
    it('guarantees exactly ONE winner when 40 agents race to stake the same task', async () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Contended bounty' }, 'dev');

      const agents = Array.from({ length: 40 }, (_, i) => `Competitor-${i + 1}`);

      // All 40 agents fire stakeTask simultaneously
      const results = await Promise.all(
        agents.map((agentName) =>
          Promise.resolve().then(() =>
            taskStore.stakeTask(cwd, sessionId, task.id, agentName, { ttl: 300 })
          )
        )
      );

      const successful = results.filter((r): r is SwarmTask => r !== null);
      const failed = results.filter((r) => r === null);

      expect(successful.length).toBe(1);
      expect(failed.length).toBe(39);

      const winner = successful[0];
      expect(agents).toContain(winner.claimed_by);
      expect(winner.status).toBe('staked');

      // Verify file and replay consistency
      const replayed = taskStore.getTask(cwd, sessionId, task.id)!;
      expect(replayed.claimed_by).toBe(winner.claimed_by);
      expect(replayed.status).toBe('staked');

      // Verify JSONL file integrity: each line must be valid JSON
      const tasksJsonl = path.join(cwd, '.pi', 'messenger', 'tasks', `${sessionId}.jsonl`);
      const raw = fs.readFileSync(tasksJsonl, 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(2); // 1 created, 1 staked
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('maintains strict consistency under multi-agent multi-task contention (20 agents x 5 tasks)', async () => {
      // Create 5 open tasks
      const tasks = Array.from({ length: 5 }, (_, i) =>
        taskStore.createTask(cwd, sessionId, { title: `Contended Task ${i + 1}` }, 'dev')
      );

      const agents = Array.from({ length: 20 }, (_, i) => `SwarmAgent-${i + 1}`);

      // Each agent tries to stake 3 random tasks in parallel batches
      const stakeAttempts: Promise<SwarmTask | null>[] = [];
      for (const agent of agents) {
        const randomTask = tasks[Math.floor(Math.random() * tasks.length)];
        stakeAttempts.push(
          Promise.resolve().then(() =>
            taskStore.stakeTask(cwd, sessionId, randomTask.id, agent, { ttl: 300 })
          )
        );
      }

      await Promise.all(stakeAttempts);

      // Verify every task has at most 1 claimant
      const allTasks = taskStore.getTasks(cwd, sessionId);
      const claimedAgents = new Set<string>();

      for (const t of allTasks) {
        if (t.status === 'staked') {
          expect(t.claimed_by).toBeDefined();
          // No agent should have double-claimed or state be duplicated
          claimedAgents.add(t.claimed_by!);
        }
      }

      // Check total staked tasks
      const stakedCount = allTasks.filter((t) => t.status === 'staked').length;
      expect(stakedCount).toBeLessThanOrEqual(5);

      // Replay all tasks from disk to verify event sourcing replay equivalence
      const replayedAll = taskStore.replayTasks(cwd, sessionId);
      expect(replayedAll.length).toBe(5);
      for (const replayed of replayedAll) {
        const memoryTask = allTasks.find((t) => t.id === replayed.id)!;
        expect(replayed.claimed_by).toBe(memoryTask.claimed_by);
        expect(replayed.status).toBe(memoryTask.status);
      }
    });
  });

  // =========================================================================
  // 4. Boundary & Malformed TTL Invariants
  // =========================================================================
  describe('4. Malformed and Boundary TTL Handling', () => {
    it('handles zero TTL (0s): sets lease as immediately expired and allow immediate preemption', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Zero TTL task' }, 'dev');

      const staked = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-Zero', { ttl: 0 });
      expect(staked).not.toBeNull();
      expect(staked!.lease_ttl).toBe(0);
      expect(staked!.lease_expires_at).toBeDefined();

      // Zero TTL expires immediately (or >= 0 ms)
      expect(taskStore.isLeaseExpired(staked!)).toBe(true);

      // Peer agent can preempt immediately without delay
      const preempted = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-Preempt', { ttl: 300 });
      expect(preempted).not.toBeNull();
      expect(preempted!.claimed_by).toBe('Agent-Preempt');
    });

    it('handles negative TTL (-100s): sets expiration in past and allows immediate preemption', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Negative TTL task' }, 'dev');

      const staked = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-Neg', { ttl: -100 });
      expect(staked).not.toBeNull();
      expect(staked!.lease_ttl).toBe(-100);

      const expiresMs = Date.parse(staked!.lease_expires_at!);
      expect(expiresMs).toBeLessThan(Date.now());
      expect(taskStore.isLeaseExpired(staked!)).toBe(true);

      const preempted = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-QuickFix', {
        ttl: 300,
      });
      expect(preempted).not.toBeNull();
      expect(preempted!.claimed_by).toBe('Agent-QuickFix');
    });

    it('handles very large TTL (100,000,000s / 3.17 years) cleanly without overflow', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Long lease task' }, 'dev');

      const largeTtl = 100_000_000;
      const staked = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-Centennial', {
        ttl: largeTtl,
      });
      expect(staked).not.toBeNull();
      expect(staked!.lease_ttl).toBe(largeTtl);
      expect(taskStore.isLeaseExpired(staked!)).toBe(false);

      const year = new Date(staked!.lease_expires_at!).getFullYear();
      expect(year).toBeGreaterThanOrEqual(new Date().getFullYear() + 3);

      // Projection handles long lease gracefully
      const bb = taskStore.generateBlackboard(cwd, sessionId);
      expect(bb).toContain('Agent-Centennial');
      expect(bb).not.toContain('NaN');
    });

    it('handles floating point TTLs (e.g. 1.5s) correctly', async () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Float TTL task' }, 'dev');

      const staked = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-Float', { ttl: 1.5 });
      expect(staked).not.toBeNull();
      expect(staked!.lease_ttl).toBe(1.5);

      await sleep(1700);
      expect(taskStore.isLeaseExpired(taskStore.getTask(cwd, sessionId, task.id)!)).toBe(true);

      const preempted = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-Next');
      expect(preempted).not.toBeNull();
      expect(preempted!.claimed_by).toBe('Agent-Next');
    }, 10000);

    it('handles NaN and non-finite TTLs by safely falling back to default TTL (300s)', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'NaN TTL task' }, 'dev');

      // NaN in JSON serializes to null, nullish coalescing defaults to 300
      const staked = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-NaN', { ttl: NaN });
      expect(staked).not.toBeNull();
      expect(staked!.lease_ttl).toBe(300);
      expect(taskStore.isLeaseExpired(staked!)).toBe(false);
      expect(staked!.lease_expires_at).toBeDefined();
    });
  });

  // =========================================================================
  // 5. High-Throughput Blackboard Projection Rendering & Stress
  // =========================================================================
  describe('5. High-Throughput Blackboard Projection Rendering', () => {
    it('consistently renders BLACKBOARD.md under heavy multi-zone population and concurrent calls', async () => {
      // Register 10 active peers in mesh registry
      const regDir = path.join(cwd, '.pi', 'messenger', 'registry');
      for (let i = 1; i <= 10; i++) {
        fs.writeFileSync(
          path.join(regDir, `Peer-${i}.json`),
          JSON.stringify({
            name: `Peer-${i}`,
            pid: process.pid,
            registeredAt: new Date().toISOString(),
          })
        );
      }

      // Populate 20 Goal tasks
      for (let i = 1; i <= 20; i++) {
        taskStore.createTask(
          cwd,
          sessionId,
          {
            title: `Goal Spec #${i}`,
            content: `Detailed specification for task ${i}`,
            verifyCommand: i % 2 === 0 ? `npm test tests/unit/sub-${i}.test.ts` : undefined,
          },
          'dev'
        );
      }

      // Populate 20 Staked tasks
      for (let i = 1; i <= 20; i++) {
        const t = taskStore.createTask(
          cwd,
          sessionId,
          { title: `In-Flight Exploration #${i}` },
          'dev'
        );
        taskStore.stakeTask(cwd, sessionId, t.id, `Peer-${(i % 10) + 1}`, {
          ttl: 300 + i * 10,
          reason: `Investigating strategy ${i}`,
        });
        if (i % 3 === 0) {
          taskStore.appendTaskProgress(
            cwd,
            sessionId,
            t.id,
            `Peer-${(i % 10) + 1}`,
            `Progress checkpoint ${i}`
          );
        }
      }

      // Populate 20 Verified tasks (Golden Artifacts)
      for (let i = 1; i <= 20; i++) {
        const t = taskStore.createTask(cwd, sessionId, { title: `Golden Solution #${i}` }, 'dev');
        taskStore.stakeTask(cwd, sessionId, t.id, `Peer-${(i % 10) + 1}`);
        taskStore.verifyTask(cwd, sessionId, t.id, `Peer-${(i % 10) + 1}`, {
          summary: `Fully verified solution for component ${i}`,
          command: 'npx vitest run tests/core.test.ts',
          exitCode: 0,
          patch: `.pi/messenger/artifacts/${t.id}.patch`,
        });
      }

      // Populate 20 Graveyard tasks (Fast Pruned Dead Ends)
      for (let i = 1; i <= 20; i++) {
        const t = taskStore.createTask(cwd, sessionId, { title: `Failed Hypothesis #${i}` }, 'dev');
        taskStore.stakeTask(cwd, sessionId, t.id, `Peer-${(i % 10) + 1}`);
        taskStore.deadEndTask(cwd, sessionId, t.id, `Peer-${(i % 10) + 1}`, {
          agent: `Peer-${(i % 10) + 1}`,
          reason: `Memory leak or race condition detected in approach #${i}`,
          attempts: 3,
          lastCommand: 'npm test tests/stress.test.ts',
          lastOutput: `Error: Heap limit exceeded at iteration ${i}\n    at Worker.run (worker.ts:42)`,
        });
      }

      // Execute 50 rapid concurrent calls to writeBlackboard & generateBlackboard
      const renderPromises: Promise<string>[] = [];
      for (let i = 0; i < 50; i++) {
        renderPromises.push(
          Promise.resolve().then(() => {
            if (i % 2 === 0) {
              return taskStore.writeBlackboard(cwd, sessionId);
            } else {
              return taskStore.generateBlackboard(cwd, sessionId);
            }
          })
        );
      }

      const renderedResults = await Promise.all(renderPromises);
      expect(renderedResults.length).toBe(50);

      // Verify the generated file on disk
      const bbPath = path.join(cwd, 'BLACKBOARD.md');
      expect(fs.existsSync(bbPath)).toBe(true);

      const fileContent = fs.readFileSync(bbPath, 'utf-8');
      expect(fileContent.length).toBeGreaterThan(1000);

      // Assert all 4 zones and peers are rendered cleanly
      expect(fileContent).toContain('# 🐝 Pi-Swarm Global Blackboard');
      expect(fileContent).toContain('## 👥 Active Peers (Mesh Registry)');
      expect(fileContent).toContain('## 🎯 Zone 1: Goal & Open Backlog');
      expect(fileContent).toContain('## ⚡ Zone 2: Soft Staking (Leased Explorations)');
      expect(fileContent).toContain('## 🏆 Zone 3: Verified Artifacts (Immutable Golden Facts)');
      expect(fileContent).toContain('## 🪦 Zone 4: Graveyard & Dead Ends (Fast Pruned Paths)');

      // Progress metrics check
      expect(fileContent).toContain('Total: 80');
      expect(fileContent).toContain('Goals: 20');
      expect(fileContent).toContain('Staked: 20');
      expect(fileContent).toContain('Verified: 20');
      expect(fileContent).toContain('Dead Ends: 20');

      // Verify no corrupted formatting or crash artifacts
      expect(fileContent).not.toContain('undefined');
      expect(fileContent).not.toContain('NaN');
      expect(fileContent).not.toContain('[object Object]');
    });
  });

  // =========================================================================
  // 6. Cross-Zone State Transition Invariants
  // =========================================================================
  describe('6. Cross-Zone State Transition Invariants', () => {
    it('strictly forbids staking on Dead-End (Graveyard) tasks', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Dead end task' }, 'dev');
      taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-1');
      taskStore.deadEndTask(cwd, sessionId, task.id, 'Agent-1', {
        agent: 'Agent-1',
        reason: 'Fatal deadlock',
        attempts: 3,
        lastCommand: 'npm test',
        lastOutput: 'Deadlock',
      });

      const deTask = taskStore.getTask(cwd, sessionId, task.id)!;
      expect(deTask.status).toBe('dead_end');

      // Agent-2 attempts to stake pruned task -> must return null
      const stakeAttempt = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-2');
      expect(stakeAttempt).toBeNull();

      // Agent-2 attempts legacy claim -> must return null
      const claimAttempt = taskStore.claimTask(cwd, sessionId, task.id, 'Agent-2');
      expect(claimAttempt).toBeNull();
    });

    it('strictly forbids staking on Verified tasks', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Verified task' }, 'dev');
      taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-1');
      taskStore.verifyTask(cwd, sessionId, task.id, 'Agent-1', {
        summary: 'Completed and verified',
        command: 'npm test',
        exitCode: 0,
        patch: '.pi/messenger/artifacts/task-1.patch',
      });

      const vTask = taskStore.getTask(cwd, sessionId, task.id)!;
      expect(vTask.status).toBe('verified');

      // Staking on verified tasks must return null
      expect(taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-2')).toBeNull();
      expect(taskStore.claimTask(cwd, sessionId, task.id, 'Agent-2')).toBeNull();
    });

    it('allows task to be restaked after an explicit reset', () => {
      const task = taskStore.createTask(cwd, sessionId, { title: 'Reset task' }, 'dev');
      taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-A', { ttl: 300 });

      // Reset task back to todo
      const resetResults = taskStore.resetTask(cwd, sessionId, task.id);
      expect(resetResults.length).toBe(1);
      expect(resetResults[0].status).toBe('todo');
      expect(resetResults[0].claimed_by).toBeUndefined();
      expect(resetResults[0].lease_expires_at).toBeUndefined();

      // Agent-B can now stake it cleanly
      const restaked = taskStore.stakeTask(cwd, sessionId, task.id, 'Agent-B', { ttl: 300 });
      expect(restaked).not.toBeNull();
      expect(restaked!.status).toBe('staked');
      expect(restaked!.claimed_by).toBe('Agent-B');
    });
  });
});
