import * as fs from 'node:fs';
import * as os from 'node:os';
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

import { executeSpawn } from '../../swarm/handlers/spawn.js';
import { clearSpawnStateForTests } from '../../swarm/spawn.js';
import type { MessengerState } from '../../lib.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 80000 + Math.floor(Math.random() * 9999);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
}

function createTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-concurrency-test-'));
}

const roots = new Set<string>();

function tempCwd(hostWidthCap?: number): string {
  const cwd = createTempCwd();
  roots.add(cwd);
  if (hostWidthCap !== undefined) {
    fs.mkdirSync(path.join(cwd, '.pi'));
    fs.writeFileSync(
      path.join(cwd, '.pi/pi-messenger.json'),
      JSON.stringify({ maxConcurrentSpawns: hostWidthCap })
    );
  }
  return cwd;
}

const baseState: MessengerState = {
  agentName: 'TestOrchestrator',
  registered: true,
  reservations: [],
  chatHistory: new Map(),
  unreadCounts: new Map(),
  channelPostHistory: [],
  seenSenders: new Map(),
  model: '',
  gitBranch: undefined,
  spec: undefined,
  scopeToFolder: false,
  isHuman: false,
  session: { toolCalls: 0, tokens: 0, filesModified: [] },
  activity: { lastActivityAt: new Date().toISOString() },
  statusMessage: undefined,
  customStatus: false,
  registryFlushTimer: null,
  sessionStartedAt: new Date().toISOString(),
  contextSessionId: 'test-session',
  currentChannel: 'test',
  sessionChannel: 'test',
  joinedChannels: ['test'],
};

describe('spawn concurrency limit', () => {
  beforeEach(() => {
    clearSpawnStateForTests();
    spawnMock.mockReset();
  });

  afterEach(() => {
    clearSpawnStateForTests();
    for (const root of roots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    }
    roots.clear();
  });

  it('allows spawning when under the limit', () => {
    const cwd = tempCwd(3);
    const sessionId = 'concurrency-under';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const result = executeSpawn(null, { objective: 'Test under limit' }, baseState, cwd, sessionId);

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');
  });

  it('rejects spawn when at the concurrency limit', () => {
    const cwd = tempCwd(2);
    const sessionId = 'concurrency-at';

    // Spawn 2 agents to fill the limit
    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);

    executeSpawn(null, { objective: 'Agent 1' }, baseState, cwd, sessionId);
    executeSpawn(null, { objective: 'Agent 2' }, baseState, cwd, sessionId);

    // Third spawn should be rejected
    const result = executeSpawn(null, { objective: 'Agent 3' }, baseState, cwd, sessionId);

    expect(result).toBeDefined();
    const details = (result as any).details ?? {};
    expect(details.error).toBe('concurrency_limit');
    expect(details.running).toBe(2);
    expect(details.limit).toBe(2);
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('2 subagents already running');
  });

  it('allows spawn after an agent completes', () => {
    const cwd = tempCwd(2);
    const sessionId = 'concurrency-complete';

    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);

    executeSpawn(null, { objective: 'Agent 1' }, baseState, cwd, sessionId);
    executeSpawn(null, { objective: 'Agent 2' }, baseState, cwd, sessionId);

    // Complete agent 1
    proc1.exitCode = 0;
    proc1.emit('close', 0);

    // Now there's room
    const proc3 = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc3 as any);

    const result = executeSpawn(null, { objective: 'Agent 3' }, baseState, cwd, sessionId);

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');
  });

  it('uses the machine-derived Host Width Cap when maxConcurrentSpawns is not configured', () => {
    const cwd = tempCwd();
    const sessionId = 'concurrency-default';
    const hostDefault = Math.min(6, Math.max(1, os.availableParallelism() - 1));

    for (let i = 0; i < hostDefault; i++) {
      const proc = new FakeProcess();
      spawnMock.mockReturnValueOnce(proc as any);
      executeSpawn(null, { objective: `Agent ${i}` }, baseState, cwd, sessionId);
    }

    const result = executeSpawn(null, { objective: 'One more' }, baseState, cwd, sessionId);

    expect(result).toBeDefined();
    const details = (result as any).details ?? {};
    expect(details.error).toBe('concurrency_limit');
    expect(details.limit).toBe(hostDefault);
    expect(details.limiter).toBe('host-cap');
  });

  it('respects a custom limit of 1', () => {
    const cwd = tempCwd(1);
    const sessionId = 'concurrency-1';

    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    // First spawn succeeds
    executeSpawn(null, { objective: 'Only one' }, baseState, cwd, sessionId);

    // Second spawn is rejected
    const result = executeSpawn(null, { objective: 'Too many' }, baseState, cwd, sessionId);

    expect(result).toBeDefined();
    const details = (result as any).details ?? {};
    expect(details.error).toBe('concurrency_limit');
    expect(details.limit).toBe(1);
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('1 subagent already running');
  });

  it('non-create spawn operations bypass concurrency check', () => {
    const cwd = tempCwd();
    const sessionId = 'concurrency-list';

    const result = executeSpawn('list', {}, baseState, cwd, sessionId);

    // list returns normally (no agents) — doesn't hit concurrency check
    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('No spawned agents');
  });
});
