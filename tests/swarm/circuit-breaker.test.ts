import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as taskStore from '../../swarm/task-store/index.js';
import { appendTaskEvent } from '../../swarm/task-store/events.js';
import { CircuitBreakerManager, circuitBreaker } from '../../swarm/circuit-breaker/index.js';
import { processManager } from '../../swarm/process-manager.js';
import { taskCreate } from '../../swarm/handlers/task-create.js';
import { taskClaim, taskStake } from '../../swarm/handlers/task-lifecycle.js';
import { taskPropose, taskChallenge } from '../../swarm/handlers/task-ops.js';
import { executeSpawn } from '../../swarm/handlers/spawn.js';
import type { MessengerState } from '../../lib.js';

function createTempDir(prefix: string = 'circuit-breaker-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pi', 'messenger', 'channels'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pi', 'messenger', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.pi', 'messenger', 'artifacts'), { recursive: true });
  return dir;
}

describe('Module 5 R4: Global Step Budget Circuit Breaker', () => {
  let cwd: string;
  const sessionId = 'session-circuit-breaker';
  const mockState: MessengerState = {
    agentName: 'worker-unit',
    registered: true,
  };

  beforeEach(() => {
    circuitBreaker.reset();
    circuitBreaker.setBudget(50);
    circuitBreaker.setEnabled(true);
    processManager.clear();
    cwd = createTempDir();
  });

  afterEach(() => {
    circuitBreaker.reset();
    circuitBreaker.setBudget(50);
    circuitBreaker.setEnabled(true);
    processManager.clear();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it('tracks step consumption and reports remaining budget correctly', () => {
    const cb = new CircuitBreakerManager({ maxSteps: 10 });
    const initial = cb.getStatus();
    expect(initial.consumedSteps).toBe(0);
    expect(initial.maxSteps).toBe(10);
    expect(initial.remainingSteps).toBe(10);
    expect(initial.isTripped).toBe(false);

    // Record 4 steps
    for (let i = 0; i < 4; i++) {
      const res = cb.recordStep('agent-1', 'bash');
      expect(res.tripped).toBe(false);
    }

    const updated = cb.getStatus();
    expect(updated.consumedSteps).toBe(4);
    expect(updated.remainingSteps).toBe(6);
    expect(updated.isTripped).toBe(false);
  });

  it('trips circuit breaker red-line when consumed steps reach maxSteps (50)', () => {
    const cb = new CircuitBreakerManager({ maxSteps: 5 });

    for (let i = 0; i < 4; i++) {
      const r = cb.recordStep('worker-1', 'read');
      expect(r.tripped).toBe(false);
      expect(r.consumed).toBe(i + 1);
    }

    // 5th step trips the circuit breaker
    const tripRes = cb.recordStep('worker-1', 'write');
    expect(tripRes.tripped).toBe(true);
    expect(tripRes.consumed).toBe(5);

    const status = cb.getStatus();
    expect(status.isTripped).toBe(true);
    expect(status.remainingSteps).toBe(0);
    expect(status.trippedAt).toBeDefined();
    expect(status.trippedReason).toContain('Global step budget exceeded (5/5 steps)');

    // Further steps remain tripped
    const afterRes = cb.recordStep('worker-1', 'bash');
    expect(afterRes.tripped).toBe(true);
    expect(afterRes.consumed).toBe(5);
  });

  it('does not increment or trip when circuit breaker is disabled', () => {
    const cb = new CircuitBreakerManager({ maxSteps: 5, enabled: false });

    for (let i = 0; i < 10; i++) {
      const r = cb.recordStep('worker-1', 'tool');
      expect(r.tripped).toBe(false);
      expect(r.consumed).toBe(0);
    }

    expect(cb.isTripped()).toBe(false);
    expect(cb.getStatus().consumedSteps).toBe(0);
  });

  it('triggerAbort broadcasts swarm.abort, batch-terminates workers, and updates blackboard', async () => {
    // Register a dummy worker process in processManager
    processManager.register({
      id: 'worker-victim',
      name: '[Swarm] worker-victim',
      agentName: 'worker-victim',
      pid: 999999, // non-existent dummy pid
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      timeoutMs: 600_000,
    });

    expect(processManager.get('worker-victim')?.status).toBe('running');

    // Create a task to populate blackboard
    taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Task Before Abort', content: 'Testing abort' },
      'dev'
    );
    taskStore.writeBlackboard(cwd, sessionId);

    // Trigger abort
    await circuitBreaker.triggerAbort(cwd, sessionId, 'Adversarial emergency shutdown');

    expect(circuitBreaker.isTripped()).toBe(true);
    const status = circuitBreaker.getStatus();
    expect(status.trippedReason).toBe('Adversarial emergency shutdown');

    // Worker in processManager was terminated
    expect(processManager.get('worker-victim')?.status).toBe('stopped');

    // Check feed channels for swarm.abort event
    const allChannelPath = path.join(cwd, '.pi', 'messenger', 'channels', 'all.jsonl');
    expect(fs.existsSync(allChannelPath)).toBe(true);
    const feedContent = fs.readFileSync(allChannelPath, 'utf-8');
    expect(feedContent).toContain('swarm.abort');
    expect(feedContent).toContain('Adversarial emergency shutdown');

    // Check task event log for swarm.abort event
    const eventsPath = path.join(cwd, '.pi', 'messenger', 'tasks', `${sessionId}.jsonl`);
    expect(fs.existsSync(eventsPath)).toBe(true);
    const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
    expect(eventsContent).toContain('swarm.abort');

    // Check BLACKBOARD.md header contains tripped banner
    const bbPath = path.join(cwd, 'BLACKBOARD.md');
    expect(fs.existsSync(bbPath)).toBe(true);
    const bbContent = fs.readFileSync(bbPath, 'utf-8');
    expect(bbContent).toContain('🛑 **CIRCUIT BREAKER TRIPPED**');
    expect(bbContent).toContain('Blackboard LOCKED');
  });

  it('enforces blackboard mutation lock across task commands when circuit breaker is tripped', () => {
    // Normal state: task creation succeeds
    const t1 = taskStore.createTask(cwd, sessionId, { title: 'Task 1', content: 'Allowed' }, 'dev');
    expect(t1.id).toBeDefined();

    // Trip the circuit breaker
    circuitBreaker.setBudget(1);
    circuitBreaker.recordStep('worker-1', 'bash');
    expect(circuitBreaker.isTripped()).toBe(true);

    // 1. createTask throws error
    expect(() => {
      taskStore.createTask(cwd, sessionId, { title: 'Task 2', content: 'Forbidden' }, 'dev');
    }).toThrow(/Circuit breaker is tripped: swarm mutations locked/);

    // 2. claimTask returns null
    const claimed = taskStore.claimTask(cwd, sessionId, t1.id, 'worker-2');
    expect(claimed).toBeNull();

    // 3. stakeTask returns null
    const staked = taskStore.stakeTask(cwd, sessionId, t1.id, 'worker-2', { ttl: 300 });
    expect(staked).toBeNull();

    // 4. proposeTask returns null
    const proposed = taskStore.proposeTask(cwd, sessionId, t1.id, 'worker-2', 'New proposal');
    expect(proposed).toBeNull();

    // 5. challengeTask returns null
    const challenged = taskStore.challengeTask(
      cwd,
      sessionId,
      t1.id,
      'worker-2',
      'prop-1',
      'New challenge'
    );
    expect(challenged).toBeNull();
  });

  it('enforces mutation lock on action handlers (task.create, claim, stake, propose, challenge, spawn)', () => {
    // Setup a task before tripping
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Pre-existing Task', content: 'Ready for ops' },
      'dev'
    );

    // Trip circuit breaker
    circuitBreaker.setBudget(1);
    circuitBreaker.recordStep('worker-1', 'tool');
    expect(circuitBreaker.isTripped()).toBe(true);

    // 1. taskCreate handler returns circuit_broken
    const createRes = taskCreate({ title: 'New Locked Task' }, mockState, cwd, 'dev', sessionId);
    expect(createRes.details.error).toBe('circuit_broken');

    // 2. taskClaim handler returns circuit_broken
    const claimRes = taskClaim({ id: task.id }, mockState, cwd, 'dev', sessionId);
    expect(claimRes.details.error).toBe('circuit_broken');

    // 3. taskStake handler returns circuit_broken
    const stakeRes = taskStake({ id: task.id }, mockState, cwd, 'dev', sessionId);
    expect(stakeRes.details.error).toBe('circuit_broken');

    // 4. taskPropose handler returns circuit_broken
    const proposeRes = taskPropose(
      { id: task.id, content: 'Alternative idea' },
      mockState,
      cwd,
      'dev',
      sessionId
    );
    expect(proposeRes.details.error).toBe('circuit_broken');

    // 5. taskChallenge handler returns circuit_broken
    const challengeRes = taskChallenge(
      { id: task.id, proposalId: 'p-1', content: 'Counterexample' },
      mockState,
      cwd,
      'dev',
      sessionId
    );
    expect(challengeRes.details.error).toBe('circuit_broken');

    // 6. spawnCreate handler returns circuit_broken
    const spawnRes = executeSpawn(
      null,
      { role: 'worker', prompt: 'Do work' },
      mockState,
      cwd,
      sessionId
    );
    expect(spawnRes.details.error).toBe('circuit_broken');
  });

  it('strictly preserves Zone 3 verified facts and .patch artifacts after circuit breaker abort', async () => {
    // 1. Create and complete a task with verified status
    const verifiedTask = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Critical Golden Fact', content: 'Core algorithm implemented' },
      'dev'
    );

    // Emulate verification success event
    const patchFilename = `${verifiedTask.id}.patch`;
    const patchPath = path.join(cwd, '.pi', 'messenger', 'artifacts', patchFilename);
    const patchContent = '--- a/src/core.ts\n+++ b/src/core.ts\n@@ -1,1 +1,2 @@\n+// Golden code';
    fs.writeFileSync(patchPath, patchContent, 'utf-8');

    appendTaskEvent(cwd, sessionId, {
      taskId: verifiedTask.id,
      type: 'verified',
      timestamp: new Date().toISOString(),
      agent: 'worker-lead',
      payload: {
        command: 'npm test',
        exitCode: 0,
        output: 'All 42 tests passed.',
        patch: patchFilename,
        summary: 'Fully verified mathematical model',
      },
    });

    // Verify task is now verified in store
    const preTasks = taskStore.getAllTasks(cwd, sessionId);
    const preVerified = preTasks.find((t) => t.id === verifiedTask.id);
    expect(preVerified?.status).toBe('verified');
    expect(preVerified?.verification?.patch).toBe(patchFilename);

    // 2. Trigger circuit breaker abort
    await circuitBreaker.triggerAbort(cwd, sessionId, 'Tool limit exceeded');
    expect(circuitBreaker.isTripped()).toBe(true);

    // 3. Confirm task state and .patch file are untouched
    const postTasks = taskStore.getAllTasks(cwd, sessionId);
    const postVerified = postTasks.find((t) => t.id === verifiedTask.id);
    expect(postVerified?.status).toBe('verified');
    expect(postVerified?.verification?.exitCode).toBe(0);
    expect(postVerified?.verification?.patch).toBe(patchFilename);

    // Patch file must still exist and match content
    expect(fs.existsSync(patchPath)).toBe(true);
    expect(fs.readFileSync(patchPath, 'utf-8')).toBe(patchContent);

    // 4. Blackboard Zone 3 still cleanly renders the golden fact
    const bbContent = fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf-8');
    expect(bbContent).toContain('## 🏆 Zone 3: Verified Artifacts (Immutable Golden Facts)');
    expect(bbContent).toContain('Critical Golden Fact');
    expect(bbContent).toContain(`Artifact: \`${patchFilename}\``);
    expect(bbContent).toContain('Fully verified mathematical model');
  });

  it('renders step budget and healthy status in blackboard header when not tripped', () => {
    circuitBreaker.setBudget(50);
    circuitBreaker.recordStep('worker-1', 'bash');
    circuitBreaker.recordStep('worker-2', 'read');

    const bb = taskStore.generateBlackboard(cwd, sessionId);
    expect(bb).toContain('Step Budget: 2/50 steps consumed (48 remaining) | Status: HEALTHY');
    expect(bb).not.toContain('CIRCUIT BREAKER TRIPPED');
  });

  it('resets budget and unlocks mutations on circuitBreaker.reset()', () => {
    circuitBreaker.setBudget(2);
    circuitBreaker.recordStep('worker-1', 'bash');
    circuitBreaker.recordStep('worker-1', 'bash');
    expect(circuitBreaker.isTripped()).toBe(true);

    // Mutations locked
    expect(() => {
      taskStore.createTask(cwd, sessionId, { title: 'T', content: 'C' }, 'dev');
    }).toThrow();

    // Reset
    circuitBreaker.reset();
    circuitBreaker.setBudget(50);

    expect(circuitBreaker.isTripped()).toBe(false);
    expect(circuitBreaker.getStatus().consumedSteps).toBe(0);

    // Mutations unlocked
    const t = taskStore.createTask(cwd, sessionId, { title: 'T', content: 'C' }, 'dev');
    expect(t.id).toBeDefined();
  });
});
