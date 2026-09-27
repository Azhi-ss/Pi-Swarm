import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { taskDone } from '../../swarm/handlers/task-lifecycle.js';
import * as taskStore from '../../swarm/task-store/index.js';
import type { MessengerState, AgentMailMessage } from '../../lib.js';

function createTempCwd(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-steer-test-'));
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'registry'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.pi', 'messenger', 'channels'), { recursive: true });
  return tmp;
}

function mockState(agentName: string = 'Agent-Alpha'): MessengerState {
  return {
    registered: true,
    agentName,
    currentChannel: 'dev',
    sessionChannel: 'dev',
    joinedChannels: ['dev'],
    model: 'test-model',
  } as MessengerState;
}

describe('Module 4: Steer Self-Healing Loop', () => {
  let cwd: string;
  const sessionId = 'test-session-steer';

  beforeEach(() => {
    cwd = createTempCwd();
  });

  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {}
  });

  it('delivers high-priority steer message to offending agent on verification failure', () => {
    const task = taskStore.createTask(cwd, sessionId, { title: 'Self-healing algorithm' }, 'dev');
    taskStore.claimTask(cwd, sessionId, task.id, 'Agent-Alpha');

    const state = mockState('Agent-Alpha');
    const deliverMessageMock = vi.fn();

    const res = taskDone(
      {
        id: task.id,
        summary: 'Attempting completion',
        verify:
          'node -e "console.error(\'FAIL: index out of bounds\\n  at Array.slice()\'); process.exit(2)"',
      },
      state,
      cwd,
      'dev',
      sessionId,
      deliverMessageMock
    );

    // Verify rejection
    expect((res as any).details?.error).toBe('verification_failed');
    expect((res as any).details?.exitCode).toBe(2);

    // Verify steer message was dispatched
    expect(deliverMessageMock).toHaveBeenCalledTimes(1);
    const delivered = deliverMessageMock.mock.calls[0][0] as AgentMailMessage;
    expect(delivered.from).toBe('verifier');
    expect(delivered.to).toBe('Agent-Alpha');
    expect(delivered.text).toContain('🚨 [Verification Failed]');
    expect(delivered.text).toContain('Exit Code: 2');
    expect(delivered.text).toContain('FAIL: index out of bounds');
    expect(delivered.text).toContain('at Array.slice()');
  });

  it('executes closed-loop self-healing: failure -> steer feedback -> patch fix -> verification pass', () => {
    // 1. Create a script in cwd with a known bug
    const scriptPath = path.join(cwd, 'calc.js');
    fs.writeFileSync(
      scriptPath,
      'module.exports = { add: (a, b) => a - b }; // BUG: subtraction\n',
      'utf-8'
    );

    const testCommand =
      "node -e \"const { add } = require('./calc.js'); if (add(2, 3) !== 5) throw new Error('Expected 5 got ' + add(2, 3));\"";

    const task = taskStore.createTask(
      cwd,
      sessionId,
      { title: 'Implement calculator', verifyCommand: testCommand },
      'dev'
    );
    taskStore.claimTask(cwd, sessionId, task.id, 'Agent-Beta');
    const state = mockState('Agent-Beta');

    const deliverMessageMock = vi.fn();

    // 2. First attempt: buggy code fails
    const failRes = taskDone(
      { id: task.id, summary: 'Completed calc' },
      state,
      cwd,
      'dev',
      sessionId,
      deliverMessageMock
    );

    expect((failRes as any).details?.error).toBe('verification_failed');
    expect(taskStore.getTask(cwd, sessionId, task.id)?.status).toBe('in_progress');
    expect(deliverMessageMock).toHaveBeenCalledTimes(1);
    expect(deliverMessageMock.mock.calls[0][0].text).toContain('Expected 5 got -1');

    // 3. Agent self-heals by fixing the code in cwd
    fs.writeFileSync(scriptPath, 'module.exports = { add: (a, b) => a + b }; // FIXED\n', 'utf-8');

    // 4. Second attempt: verification succeeds
    const passRes = taskDone(
      { id: task.id, summary: 'Fixed bug, tests pass' },
      state,
      cwd,
      'dev',
      sessionId,
      deliverMessageMock
    );

    expect((passRes as any).details?.error).toBeUndefined();
    expect((passRes as any).details?.verified).toBe(true);
    expect(taskStore.getTask(cwd, sessionId, task.id)?.status).toBe('verified');
  });
});
