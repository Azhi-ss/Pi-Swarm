import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';
import { proposeTask, challengeTask } from '../../swarm/task-store/commands.js';
import { executeTask, taskPropose, taskChallenge } from '../../swarm/handlers/task-ops.js';
import { executeAction } from '../../router.js';
import { splitCliArgs, findCommandSpec } from '../../harness/commands.js';
import { readFeedEvents, formatFeedLine } from '../../feed/index.js';
import type { MessengerState, Dirs } from '../../lib.js';

const roots = new Set<string>();
const TEST_SESSION = 'test-session-propose-challenge';
const TEST_CHANNEL = 'dev';

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-propose-challenge-'));
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
});

function createMockState(agentName: string = 'Researcher-Alpha'): MessengerState {
  return {
    registered: true,
    agentName,
    currentChannel: TEST_CHANNEL,
    sessionChannel: TEST_CHANNEL,
    joinedChannels: [TEST_CHANNEL],
    model: 'test-model',
  };
}

function createMockDirs(cwd: string): Dirs {
  const base = path.join(cwd, '.pi', 'messenger');
  return {
    base,
    registry: path.join(base, 'registry'),
  };
}

describe('propose and challenge task store event sourcing', () => {
  it('records proposal event and projects proposals onto task', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Optimize IPC protocol' },
      TEST_CHANNEL
    );

    const updated = proposeTask(
      cwd,
      TEST_SESSION,
      task.id,
      'Researcher-Alpha',
      'Use shared memory ring buffer'
    );

    expect(updated).not.toBeNull();
    expect(updated?.proposals).toHaveLength(1);
    expect(updated?.proposals?.[0]).toEqual({
      id: 'prop-1',
      agent: 'Researcher-Alpha',
      content: 'Use shared memory ring buffer',
      timestamp: expect.any(String),
    });

    // Replay from raw events file
    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);
    expect(found?.proposals).toHaveLength(1);
    expect(found?.proposals?.[0]?.content).toBe('Use shared memory ring buffer');
  });

  it('records multiple proposals in chronological order', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Concurrent task' },
      TEST_CHANNEL
    );

    proposeTask(cwd, TEST_SESSION, task.id, 'Agent-1', 'Proposal 1');
    proposeTask(cwd, TEST_SESSION, task.id, 'Agent-2', 'Proposal 2');

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);
    expect(found?.proposals).toHaveLength(2);
    expect(found?.proposals?.[0]?.id).toBe('prop-1');
    expect(found?.proposals?.[0]?.agent).toBe('Agent-1');
    expect(found?.proposals?.[1]?.id).toBe('prop-2');
    expect(found?.proposals?.[1]?.agent).toBe('Agent-2');
  });

  it('records challenge event with challenger and claimant association', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Buffer cache' }, TEST_CHANNEL);

    // Agent A claims task
    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Researcher-Alpha', 'Implementing');

    // Agent B challenges
    const challenged = challengeTask(
      cwd,
      TEST_SESSION,
      task.id,
      'Verifier-Beta',
      'Ring buffer lacks overflow check',
      'Researcher-Alpha'
    );

    expect(challenged).not.toBeNull();
    expect(challenged?.challenges).toHaveLength(1);
    expect(challenged?.challenges?.[0]).toEqual({
      id: 'chal-1',
      agent: 'Verifier-Beta',
      content: 'Ring buffer lacks overflow check',
      targetClaimant: 'Researcher-Alpha',
      timestamp: expect.any(String),
    });

    // Replay from raw events file
    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);
    expect(found?.challenges).toHaveLength(1);
    expect(found?.challenges?.[0]?.targetClaimant).toBe('Researcher-Alpha');
  });
});

describe('task operations handler: taskPropose and taskChallenge', () => {
  it('validates required inputs for propose', () => {
    const cwd = createTempCwd();
    const state = createMockState();

    const missingId = taskPropose({}, state, cwd, TEST_CHANNEL, TEST_SESSION);
    expect(missingId.content[0]?.text).toContain('Error: id or taskId required');

    const missingContent = taskPropose({ id: 'task-1' }, state, cwd, TEST_CHANNEL, TEST_SESSION);
    expect(missingContent.content[0]?.text).toContain('Error: content required');

    const notFound = taskPropose(
      { id: 'non-existent', content: 'Hypothesis' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(notFound.content[0]?.text).toContain('not found');
  });

  it('validates required inputs for challenge', () => {
    const cwd = createTempCwd();
    const state = createMockState();

    const missingId = taskChallenge({}, state, cwd, TEST_CHANNEL, TEST_SESSION);
    expect(missingId.content[0]?.text).toContain('Error: id or taskId required');

    const missingReason = taskChallenge({ id: 'task-1' }, state, cwd, TEST_CHANNEL, TEST_SESSION);
    expect(missingReason.content[0]?.text).toContain('Error: reason/challenge required');

    const notFound = taskChallenge(
      { id: 'non-existent', reason: 'Counter-example' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(notFound.content[0]?.text).toContain('not found');
  });

  it('logs feed events when proposing and challenging', () => {
    const cwd = createTempCwd();
    const state = createMockState('Tester-Bot');
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Feed logging test' },
      TEST_CHANNEL
    );

    const proposeRes = executeTask(
      'propose',
      { id: task.id, content: 'My proposal for feed' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(proposeRes.content[0]?.text).toContain('Proposal submitted');

    const challengeRes = executeTask(
      'challenge',
      { id: task.id, reason: 'My objection for feed' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(challengeRes.content[0]?.text).toContain('Challenge recorded');

    // Read channel feed events
    const events = readFeedEvents(cwd, undefined, TEST_CHANNEL);
    const proposeEvent = events.find((e) => e.type === 'task.propose');
    const challengeEvent = events.find((e) => e.type === 'task.challenge');

    expect(proposeEvent).toBeDefined();
    expect(proposeEvent?.target).toBe(task.id);
    expect(proposeEvent?.preview).toBe('My proposal for feed');

    expect(challengeEvent).toBeDefined();
    expect(challengeEvent?.target).toBe(task.id);
    expect(challengeEvent?.preview).toBe('My objection for feed');

    // Check formatted lines
    const formattedPropose = formatFeedLine(proposeEvent!);
    expect(formattedPropose).toContain('[Swarm] Tester-Bot proposed task-1 — My proposal for feed');

    const formattedChallenge = formatFeedLine(challengeEvent!);
    expect(formattedChallenge).toContain(
      '[Swarm] Tester-Bot challenged task-1 — My objection for feed'
    );
  });
});

describe('router integration: top-level and task subcommands', () => {
  it('dispatches top-level propose action', async () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const dirs = createMockDirs(cwd);
    const ctx = { cwd } as any;

    await executeAction(
      'task.create',
      { title: 'Router propose test' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );

    const res = await executeAction(
      'propose',
      { taskId: 'task-1', content: 'Top level proposal' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );

    expect(res.content[0]?.text).toContain('Proposal submitted for task-1');
  });

  it('dispatches top-level challenge action', async () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const dirs = createMockDirs(cwd);
    const ctx = { cwd } as any;

    await executeAction(
      'task.create',
      { title: 'Router challenge test' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );

    const res = await executeAction(
      'challenge',
      { taskId: 'task-1', reason: 'Top level objection' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );

    expect(res.content[0]?.text).toContain('Challenge recorded for task-1');
  });

  it('dispatches task.propose action', async () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const dirs = createMockDirs(cwd);
    const ctx = { cwd } as any;

    await executeAction(
      'task.create',
      { title: 'Task.propose test' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );

    const res = await executeAction(
      'task.propose',
      { id: 'task-1', content: 'Dot action proposal' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );

    expect(res.content[0]?.text).toContain('Proposal submitted for task-1');
  });

  it('dispatches task.challenge action', async () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const dirs = createMockDirs(cwd);
    const ctx = { cwd } as any;

    await executeAction(
      'task.create',
      { title: 'Task.challenge test' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );

    const res = await executeAction(
      'task.challenge',
      { id: 'task-1', reason: 'Dot action challenge' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );

    expect(res.content[0]?.text).toContain('Challenge recorded for task-1');
  });
});

describe('CLI argument splitting for propose and challenge', () => {
  it('correctly splits top-level propose command into id and rest+ content', () => {
    expect(splitCliArgs('propose task-1 Use non-blocking sockets with epoll')).toEqual([
      'propose',
      'task-1',
      'Use non-blocking sockets with epoll',
    ]);
  });

  it('correctly splits top-level challenge command into id and rest+ reason', () => {
    expect(splitCliArgs('challenge task-1 Epoll may miss events during socket close')).toEqual([
      'challenge',
      'task-1',
      'Epoll may miss events during socket close',
    ]);
  });

  it('correctly splits task propose command', () => {
    expect(splitCliArgs('task propose task-1 Use non-blocking sockets with epoll')).toEqual([
      'task',
      'propose',
      'task-1',
      'Use non-blocking sockets with epoll',
    ]);
  });

  it('correctly splits task challenge command', () => {
    expect(splitCliArgs('task challenge task-1 Epoll may miss events during socket close')).toEqual(
      ['task', 'challenge', 'task-1', 'Epoll may miss events during socket close']
    );
  });

  it('matches CommandSpec for propose and challenge', () => {
    expect(findCommandSpec('propose task-1')?.action).toBe('propose');
    expect(findCommandSpec('challenge task-1')?.action).toBe('challenge');
    expect(findCommandSpec('task propose task-1')?.action).toBe('task.propose');
    expect(findCommandSpec('task challenge task-1')?.action).toBe('task.challenge');
  });
});
