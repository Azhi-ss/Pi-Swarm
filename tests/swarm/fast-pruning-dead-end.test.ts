import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { taskDone } from '../../swarm/handlers/task-lifecycle.js';
import * as taskStore from '../../swarm/task-store/index.js';
import { readFeedEvents, formatFeedLine } from '../../feed/index.js';
import type { MessengerState } from '../../lib.js';

function createTempCwd(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-prune-test-'));
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'channels'), { recursive: true });
  return tmp;
}

function mockState(agentName: string = 'Explorer-Gamma'): MessengerState {
  return {
    registered: true,
    agentName,
    currentChannel: 'dev',
    sessionChannel: 'dev',
    joinedChannels: ['dev'],
    model: 'test-model',
  } as MessengerState;
}

describe('Module 4: Fast Pruning, Dead Ends & Global Broadcast', () => {
  let cwd: string;
  const sessionId = 'test-session-prune';

  beforeEach(() => {
    cwd = createTempCwd();
  });

  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it('triggers Fast Pruning after 3 consecutive verification failures and transitions to dead_end', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Impossible algorithm constraint' },
      'dev'
    );
    taskStore.claimTask(cwd, sessionId, task.id, 'Explorer-Gamma');
    const state = mockState('Explorer-Gamma');

    const failingVerify =
      'node -e "console.error(\'Fatal: P !== NP assumption violated\'); process.exit(1)"';

    // Attempt 1: Fails
    const res1 = taskDone(
      { id: task.id, summary: 'Attempt 1', verify: failingVerify },
      state,
      cwd,
      'dev',
      sessionId
    );
    expect((res1 as any).details?.error).toBe('verification_failed');
    expect((res1 as any).details?.attempt).toBe(1);
    expect(taskStore.getTask(cwd, sessionId, task.id)?.status).toBe('in_progress');

    // Attempt 2: Fails
    const res2 = taskDone(
      { id: task.id, summary: 'Attempt 2', verify: failingVerify },
      state,
      cwd,
      'dev',
      sessionId
    );
    expect((res2 as any).details?.error).toBe('verification_failed');
    expect((res2 as any).details?.attempt).toBe(2);
    expect(taskStore.getTask(cwd, sessionId, task.id)?.status).toBe('in_progress');

    // Attempt 3: Fails -> Fast Pruning triggers!
    const res3 = taskDone(
      { id: task.id, summary: 'Attempt 3', verify: failingVerify },
      state,
      cwd,
      'dev',
      sessionId
    );
    expect((res3 as any).details?.error).toBe('verification_failed');
    expect((res3 as any).details?.pruned).toBe(true);
    expect((res3 as any).content[0]?.text).toContain('🪦 Task');
    expect((res3 as any).content[0]?.text).toContain(
      'pruned to Dead End after 3 verification failures'
    );

    // Verify task state in TaskStore
    const prunedTask = taskStore.getTask(cwd, sessionId, task.id)!;
    expect(prunedTask.status).toBe('dead_end');
    expect(prunedTask.claimed_by).toBeUndefined();
    expect(prunedTask.lease_expires_at).toBeUndefined();
    expect(prunedTask.dead_end_reason).toContain('Verification failed 3 times');
    expect(prunedTask.dead_ends?.length).toBe(1);
    expect(prunedTask.dead_ends![0].errorLog).toContain('P !== NP');
  });

  it('broadcasts task.dead_end to channels feed and formats with 🪦 dead_end', () => {
    const task = taskStore.createTask(cwd, sessionId, { title: 'Flawed heuristic' }, 'dev');
    taskStore.claimTask(cwd, sessionId, task.id, 'Explorer-Delta');
    const state = mockState('Explorer-Delta');

    const failingVerify = 'node -e "process.exit(1)"';

    // 3 failures
    taskDone({ id: task.id, summary: '1', verify: failingVerify }, state, cwd, 'dev', sessionId);
    taskDone({ id: task.id, summary: '2', verify: failingVerify }, state, cwd, 'dev', sessionId);
    taskDone({ id: task.id, summary: '3', verify: failingVerify }, state, cwd, 'dev', sessionId);

    // Check channel feed events
    const events = readFeedEvents(cwd, 20, 'dev');
    const deadEndEvent = events.find((e) => e.type === 'task.dead_end');
    expect(deadEndEvent).toBeDefined();
    expect(deadEndEvent!.target).toBe(task.id);
    expect(deadEndEvent!.preview).toContain('Pruned after 3 failed verifications');

    // Check feed line formatting
    const formatted = formatFeedLine(deadEndEvent!);
    expect(formatted).toContain('🪦 dead_end');
    expect(formatted).toContain(task.id);
  });

  it('updates BLACKBOARD.md Graveyard zone upon fast pruning', () => {
    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Deadlock under high concurrency' },
      'dev'
    );
    taskStore.claimTask(cwd, sessionId, task.id, 'Explorer-Omega');
    const state = mockState('Explorer-Omega');

    const failingVerify =
      'node -e "console.error(\'Resource deadlock detected\'); process.exit(1)"';

    taskDone({ id: task.id, summary: '1', verify: failingVerify }, state, cwd, 'dev', sessionId);
    taskDone({ id: task.id, summary: '2', verify: failingVerify }, state, cwd, 'dev', sessionId);
    taskDone({ id: task.id, summary: '3', verify: failingVerify }, state, cwd, 'dev', sessionId);

    const bbPath = path.join(cwd, 'BLACKBOARD.md');
    expect(fs.existsSync(bbPath)).toBe(true);

    const bbContent = fs.readFileSync(bbPath, 'utf-8');
    expect(bbContent).toContain('## 🪦 Zone 4: Graveyard & Dead Ends');
    expect(bbContent).toContain(task.id);
    expect(bbContent).toContain('Deadlock under high concurrency');
    expect(bbContent).toContain('Resource deadlock detected');
  });
});
