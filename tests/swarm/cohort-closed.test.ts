import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../swarm/progress.js', () => ({
  createProgress: () => ({
    tokens: 0,
    toolCallCount: 0,
    recentTools: [],
    status: 'running',
  }),
  updateProgress: () => {},
}));

vi.mock('../../swarm/live-progress.js', () => ({
  removeLiveWorker: () => {},
  updateLiveWorker: () => {},
}));

import { executeAction } from '../../router.js';
import type { MessengerState } from '../../lib.js';
import { clearSpawnStateForTests } from '../../swarm/spawn.js';
import { processManager } from '../../swarm/process-manager.js';
import { startRun } from '../../swarm/run-store.js';
import {
  createContext,
  createMessengerFixture,
  createState,
  writeRegistration,
} from '../helpers/messenger-fixtures.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = process.pid;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn();
}

const processes: FakeProcess[] = [];

function actionFor(cwd: string, state: MessengerState, sessionId: string) {
  const dirs = {
    base: path.join(cwd, '.pi', 'messenger'),
    registry: path.join(cwd, '.pi', 'messenger', 'registry'),
  };
  const ctx = createContext(cwd, sessionId);
  return (params: Parameters<typeof executeAction>[1]) =>
    executeAction(
      params.action!,
      params,
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );
}

afterEach(() => {
  for (const proc of processes) proc.emit('close', 0);
  processes.length = 0;
  clearSpawnStateForTests();
  processManager.clear();
});

describe('closed Cohort', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const proc = new FakeProcess();
      processes.push(proc);
      return proc;
    });
  });

  it('lists the other Peer Nodes in the Cohort and leaves the Delegator out', async () => {
    const { cwd, dirs } = createMessengerFixture('cohort-closed-');
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.pi/pi-messenger.json'),
      JSON.stringify({ maxConcurrentSpawns: 6 })
    );
    const run = startRun(cwd, {
      goal: 'One shared problem',
      delegator: 'Delegator',
      concurrency: 6,
    });
    const delegator = createState('Delegator', { registered: true, contextSessionId: run.id });
    const spawn = actionFor(cwd, delegator, run.id);

    for (const name of ['PeerA', 'PeerB', 'PeerC', 'PeerD']) {
      const started = await spawn({
        action: 'spawn',
        cohort: 4,
        message: 'Reduce the failing test to one assertion.',
        name,
      });
      expect(started.details.error).toBeUndefined();
    }

    for (const name of ['Delegator', 'PeerA', 'PeerB', 'PeerC', 'PeerD', 'Outsider']) {
      writeRegistration(dirs, { name, cwd, sessionId: run.id });
    }

    const peer = createState('PeerA', { registered: true, contextSessionId: run.id });
    const listed = JSON.parse(
      (await actionFor(cwd, peer, run.id)({ action: 'peers' })).content[0].text
    ) as Array<{ name: string }>;

    expect(listed.map((partner) => partner.name).sort()).toEqual(['PeerB', 'PeerC', 'PeerD']);
  });

  it('does not let a Peer Node in the Cohort spawn another Peer Node', async () => {
    const { cwd } = createMessengerFixture('cohort-closed-');
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.pi/pi-messenger.json'),
      JSON.stringify({ maxConcurrentSpawns: 6 })
    );
    const run = startRun(cwd, {
      goal: 'One shared problem',
      delegator: 'Delegator',
      concurrency: 6,
    });
    const delegator = createState('Delegator', { registered: true, contextSessionId: run.id });
    const spawn = actionFor(cwd, delegator, run.id);

    for (const name of ['PeerA', 'PeerB']) {
      const started = await spawn({
        action: 'spawn',
        cohort: 2,
        message: 'Reduce the failing test to one assertion.',
        name,
      });
      expect(started.details.error).toBeUndefined();
    }

    const peer = createState('PeerA', { registered: true, contextSessionId: run.id });
    const refused = await actionFor(
      cwd,
      peer,
      run.id
    )({
      action: 'spawn',
      cohort: 2,
      message: 'Start another Peer Node.',
      name: 'PeerE',
    });

    expect(refused.content[0].text).toContain(
      'A Peer Node in a Cohort cannot spawn another Peer Node.'
    );
    const running = await actionFor(cwd, peer, run.id)({ action: 'spawn.list' });
    expect(running.content[0].text).not.toContain('PeerE');
    expect(running.content[0].text).toContain('PeerA');
    expect(running.content[0].text).toContain('PeerB');
  });

  it('keeps the partner list at the Cohort size minus one', async () => {
    const { cwd, dirs } = createMessengerFixture('cohort-closed-');
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.pi/pi-messenger.json'),
      JSON.stringify({ maxConcurrentSpawns: 6 })
    );
    const run = startRun(cwd, {
      goal: 'One shared problem',
      delegator: 'Delegator',
      concurrency: 6,
    });
    const delegator = createState('Delegator', { registered: true, contextSessionId: run.id });
    const spawn = actionFor(cwd, delegator, run.id);

    for (const name of ['PeerA', 'PeerB']) {
      const started = await spawn({
        action: 'spawn',
        cohort: 2,
        message: 'Reduce the failing test to one assertion.',
        name,
      });
      expect(started.details.error).toBeUndefined();
    }

    for (const name of ['Delegator', 'PeerA', 'PeerB', 'Outsider']) {
      writeRegistration(dirs, { name, cwd, sessionId: run.id });
    }

    const peer = createState('PeerA', { registered: true, contextSessionId: run.id });
    const partners = async () =>
      JSON.parse(
        (await actionFor(cwd, peer, run.id)({ action: 'peers' })).content[0].text
      ) as Array<{ name: string }>;

    expect((await partners()).map((partner) => partner.name).sort()).toEqual(['PeerB']);

    const extra = await spawn({
      action: 'spawn',
      cohort: 2,
      message: 'Start another Peer Node.',
      name: 'PeerC',
    });
    expect(extra.content[0].text).toContain('A Cohort of 2 Peer Nodes is already started.');
    expect((await partners()).map((partner) => partner.name).sort()).toEqual(['PeerB']);
  });
});
