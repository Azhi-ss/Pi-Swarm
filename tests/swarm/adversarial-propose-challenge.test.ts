import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';
import { proposeTask, challengeTask } from '../../swarm/task-store/commands.js';
import { executeTask, taskPropose, taskChallenge } from '../../swarm/handlers/task-ops.js';
import { executeAction } from '../../router.js';
import { splitCliArgs, findCommandSpec } from '../../harness/commands.js';
import { readFeedEvents, formatFeedLine, pruneFeed } from '../../feed/index.js';
import type { MessengerState, Dirs } from '../../lib.js';

const roots = new Set<string>();
const TEST_SESSION = 'adv-test-session';
const TEST_CHANNEL = 'dev';

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-adversarial-'));
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

function createMockState(agentName: string = 'Adversary-Bot'): MessengerState {
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

describe('Suite 1: Adversarial — Non-existent tasks', () => {
  it('proposeTask and challengeTask return null on non-existent task IDs without throwing', () => {
    const cwd = createTempCwd();

    expect(proposeTask(cwd, TEST_SESSION, 'non-existent-1', 'Bot', 'Hypothesis')).toBeNull();
    expect(challengeTask(cwd, TEST_SESSION, 'non-existent-2', 'Bot', 'Objection')).toBeNull();
    expect(proposeTask(cwd, TEST_SESSION, '', 'Bot', 'Hypothesis')).toBeNull();
    expect(challengeTask(cwd, TEST_SESSION, '', 'Bot', 'Objection')).toBeNull();
  });

  it('taskPropose and taskChallenge gracefully return not_found results', () => {
    const cwd = createTempCwd();
    const state = createMockState();

    const pRes = taskPropose(
      { id: 'ghost-task-1', content: 'Hypothesis' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(pRes.details.error).toBe('not_found');
    expect(pRes.content[0]?.text).toContain('Error: task ghost-task-1 not found');

    const cRes = taskChallenge(
      { id: 'ghost-task-2', reason: 'Counter-evidence' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(cRes.details.error).toBe('not_found');
    expect(cRes.content[0]?.text).toContain('Error: task ghost-task-2 not found');
  });

  it('executeAction dispatches propose and challenge gracefully on non-existent tasks across all forms', async () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const dirs = createMockDirs(cwd);
    const ctx = { cwd } as any;

    // Top-level propose
    const res1 = await executeAction(
      'propose',
      { taskId: 'task-404', content: 'Plan' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );
    expect(res1.details.error).toBe('not_found');

    // Top-level challenge
    const res2 = await executeAction(
      'challenge',
      { taskId: 'task-404', reason: 'Flaw' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );
    expect(res2.details.error).toBe('not_found');

    // Subcommand task.propose
    const res3 = await executeAction(
      'task.propose',
      { id: 'task-404', content: 'Plan' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );
    expect(res3.details.error).toBe('not_found');

    // Subcommand task.challenge
    const res4 = await executeAction(
      'task.challenge',
      { id: 'task-404', reason: 'Flaw' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );
    expect(res4.details.error).toBe('not_found');
  });

  it('gracefully rejects proposing and challenging on archived tasks', () => {
    const cwd = createTempCwd();
    const state = createMockState();

    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Archived task' }, TEST_CHANNEL);
    taskStore.claimTask(cwd, TEST_SESSION, task.id, state.agentName);
    taskStore.completeTask(cwd, TEST_SESSION, task.id, state.agentName, 'Finished');
    taskStore.archiveTask(cwd, TEST_SESSION, task.id);

    const pRes = taskPropose(
      { id: task.id, content: 'Late proposal' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(pRes.details.error).toBe('not_found');

    const cRes = taskChallenge(
      { id: task.id, reason: 'Late challenge' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(cRes.details.error).toBe('not_found');
  });

  it('path traversal / special syntax task IDs are safely rejected as not_found', () => {
    const cwd = createTempCwd();
    const state = createMockState();

    const maliciousIds = [
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      'task-1/../../secret',
      'CON',
      'NUL',
      '*?<>|:"',
      'task:invalid:id',
    ];

    for (const badId of maliciousIds) {
      const pRes = taskPropose(
        { id: badId, content: 'Attack' },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(pRes.details.error).toBe('not_found');

      const cRes = taskChallenge(
        { id: badId, reason: 'Attack' },
        state,
        cwd,
        TEST_CHANNEL,
        TEST_SESSION
      );
      expect(cRes.details.error).toBe('not_found');
    }
  });
});

describe('Suite 2: Adversarial — Empty, missing, and whitespace arguments', () => {
  it('validates missing and empty task IDs in taskPropose and taskChallenge', () => {
    const cwd = createTempCwd();
    const state = createMockState();

    // Missing id/taskId entirely
    expect(
      taskPropose({ content: 'valid' }, state, cwd, TEST_CHANNEL, TEST_SESSION).details.error
    ).toBe('missing_id');
    expect(
      taskChallenge({ reason: 'valid' }, state, cwd, TEST_CHANNEL, TEST_SESSION).details.error
    ).toBe('missing_id');

    // Empty string id
    expect(
      taskPropose({ id: '', content: 'valid' }, state, cwd, TEST_CHANNEL, TEST_SESSION).details
        .error
    ).toBe('missing_id');
    expect(
      taskChallenge({ id: '', reason: 'valid' }, state, cwd, TEST_CHANNEL, TEST_SESSION).details
        .error
    ).toBe('missing_id');
  });

  it('validates missing, empty, and whitespace-only content in taskPropose', () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'T1' }, TEST_CHANNEL);

    // Missing content entirely
    expect(taskPropose({ id: task.id }, state, cwd, TEST_CHANNEL, TEST_SESSION).details.error).toBe(
      'missing_content'
    );

    // Empty string
    expect(
      taskPropose({ id: task.id, content: '' }, state, cwd, TEST_CHANNEL, TEST_SESSION).details
        .error
    ).toBe('missing_content');

    // Spaces only
    expect(
      taskPropose({ id: task.id, content: '     ' }, state, cwd, TEST_CHANNEL, TEST_SESSION).details
        .error
    ).toBe('missing_content');

    // Newlines and tabs only
    expect(
      taskPropose({ id: task.id, content: '\n\r\t   \n' }, state, cwd, TEST_CHANNEL, TEST_SESSION)
        .details.error
    ).toBe('missing_content');
  });

  it('validates missing, empty, and whitespace-only reason in taskChallenge', () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'T2' }, TEST_CHANNEL);

    // Missing reason entirely
    expect(
      taskChallenge({ id: task.id }, state, cwd, TEST_CHANNEL, TEST_SESSION).details.error
    ).toBe('missing_reason');

    // Empty string
    expect(
      taskChallenge({ id: task.id, reason: '' }, state, cwd, TEST_CHANNEL, TEST_SESSION).details
        .error
    ).toBe('missing_reason');

    // Spaces only
    expect(
      taskChallenge({ id: task.id, reason: '     ' }, state, cwd, TEST_CHANNEL, TEST_SESSION)
        .details.error
    ).toBe('missing_reason');

    // Newlines and tabs only
    expect(
      taskChallenge({ id: task.id, reason: '\n\r\t   \n' }, state, cwd, TEST_CHANNEL, TEST_SESSION)
        .details.error
    ).toBe('missing_reason');
  });

  it('validates router-level missing taskId in top-level propose and challenge', async () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const dirs = createMockDirs(cwd);
    const ctx = { cwd } as any;

    const pRes = await executeAction(
      'propose',
      { content: 'No task' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );
    expect(pRes.details.error).toBe('missing_task_id');

    const cRes = await executeAction(
      'challenge',
      { reason: 'No task' },
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );
    expect(cRes.details.error).toBe('missing_task_id');
  });

  it('CLI executable gracefully exits with code 1 and writes to stderr on missing arguments', () => {
    const cliPath = path.resolve(__dirname, '../../dist/harness/cli.js');

    const testCases = [
      { args: ['propose'], expectedStderr: 'Error: propose requires <taskId> <content>.' },
      { args: ['challenge'], expectedStderr: 'Error: challenge requires <taskId> <reason>.' },
      { args: ['task', 'propose'], expectedStderr: 'Error: task propose requires <id> <content>.' },
      {
        args: ['task', 'challenge'],
        expectedStderr: 'Error: task challenge requires <id> <reason>.',
      },
      {
        args: ['propose', 'task-1', ''],
        expectedStderr: 'Error: propose requires <taskId> <content>.',
      },
      {
        args: ['challenge', 'task-1', ''],
        expectedStderr: 'Error: challenge requires <taskId> <reason>.',
      },
    ];

    for (const { args, expectedStderr } of testCases) {
      try {
        execFileSync(process.execPath, [cliPath, ...args], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect.fail(`Command node cli.js ${args.join(' ')} should have exited with code 1`);
      } catch (err: any) {
        expect(err.status).toBe(1);
        expect(err.stderr).toContain(expectedStderr);
      }
    }
  });
});

describe('Suite 3: Adversarial — Extreme payloads, Unicode, JSON-like, and newlines', () => {
  it('handles massive 30,000 character proposals and challenges without truncation', () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Massive Payload Task' },
      TEST_CHANNEL
    );

    const hugeProposal = 'P'.repeat(30_000);
    const hugeChallenge = 'C'.repeat(30_000);

    const pRes = taskPropose(
      { id: task.id, content: hugeProposal },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(pRes.details.error).toBeUndefined();

    const cRes = taskChallenge(
      { id: task.id, reason: hugeChallenge },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(cRes.details.error).toBeUndefined();

    // Replay from raw disk storage
    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.proposals?.[0]?.content).toHaveLength(30_000);
    expect(replayed?.proposals?.[0]?.content).toBe(hugeProposal);
    expect(replayed?.challenges?.[0]?.content).toHaveLength(30_000);
    expect(replayed?.challenges?.[0]?.content).toBe(hugeChallenge);

    // Verify feed events and formatting
    const feedEvents = readFeedEvents(cwd, undefined, TEST_CHANNEL);
    const proposeFeed = feedEvents.find((e) => e.type === 'task.propose');
    const challengeFeed = feedEvents.find((e) => e.type === 'task.challenge');
    expect(proposeFeed).toBeDefined();
    expect(challengeFeed).toBeDefined();

    const formattedP = formatFeedLine(proposeFeed!);
    const formattedC = formatFeedLine(challengeFeed!);
    // Terminal line should be capped cleanly
    expect(formattedP).toContain('...');
    expect(formattedC).toContain('...');
  });

  it('faithfully preserves Unicode, emojis, RTL text, and mathematical symbols', () => {
    const cwd = createTempCwd();
    const state = createMockState('智能体-Ω');
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Unicode Task' }, TEST_CHANNEL);

    const unicodeProposal =
      '方案：采用零知识证明与环形缓冲区 🚀 🔥 🧬\n' +
      'مرحبا بالعالم - שלום עולם\n' +
      '定理：∀x ∈ ℝ⁺, ∃y ∈ ℕ: y > x² + 2π\n' +
      'Z͔͑ͫ̓a̋lͧgͬoͥ 腐化文字与特殊符号';

    const unicodeChallenge =
      '反驳：在非对易几何中，上述环形缓冲区会出现内存踩踏 💥 🤖\n' + '反例：x = ℵ₀, 极限发散';

    taskPropose({ id: task.id, content: unicodeProposal }, state, cwd, TEST_CHANNEL, TEST_SESSION);
    taskChallenge(
      { id: task.id, reason: unicodeChallenge },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.proposals?.[0]?.content).toBe(unicodeProposal);
    expect(replayed?.proposals?.[0]?.agent).toBe('智能体-Ω');
    expect(replayed?.challenges?.[0]?.content).toBe(unicodeChallenge);

    const feedEvents = readFeedEvents(cwd, undefined, TEST_CHANNEL);
    const pFeed = feedEvents.find((e) => e.type === 'task.propose');
    expect(pFeed?.preview).toContain('方案：采用零知识证明与环形缓冲区');
  });

  it('handles JSON-like strings and prevents JSONL line-injection attacks', () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'JSON Injection Task' },
      TEST_CHANNEL
    );

    // An attacker tries to inject raw newline + fake event into JSONL
    const injectionAttempt =
      'Legitimate strategy\n' +
      '{"taskId":"task-1","type":"completed","timestamp":"2099-01-01T00:00:00.000Z","agent":"Hacker","payload":{"summary":"Fake completed"}}\n' +
      'Continued normal proposal';

    taskPropose({ id: task.id, content: injectionAttempt }, state, cwd, TEST_CHANNEL, TEST_SESSION);

    // Verify task is NOT prematurely completed
    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.status).toBe('todo');
    expect(replayed?.proposals).toHaveLength(1);
    expect(replayed?.proposals?.[0]?.content).toBe(injectionAttempt);

    // Inspect the physical JSONL file: count lines
    const tasksJsonlPath = path.join(cwd, '.pi', 'messenger', 'tasks', `${TEST_SESSION}.jsonl`);
    const fileLines = fs.readFileSync(tasksJsonlPath, 'utf-8').trim().split('\n');
    // Exactly 2 lines: 1 created event + 1 proposed event
    expect(fileLines).toHaveLength(2);
    for (const line of fileLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('safely handles prototype pollution strings and quotes/backslashes', () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Pollution & Escapes' },
      TEST_CHANNEL
    );

    const trickyText =
      'quotes: "\'"` backslashes: \\ \\\\ \\n \\t null: \0 __proto__: true constructor: function() {}';

    taskPropose({ id: task.id, content: trickyText }, state, cwd, TEST_CHANNEL, TEST_SESSION);
    taskChallenge({ id: task.id, reason: trickyText }, state, cwd, TEST_CHANNEL, TEST_SESSION);

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.proposals?.[0]?.content).toBe(trickyText);
    expect(replayed?.challenges?.[0]?.content).toBe(trickyText);

    // Ensure Object prototype was not polluted
    expect((Object.prototype as any).fakeProp).toBeUndefined();
  });
});

describe('Suite 4: Adversarial — Rapid sequential execution & chronological replay ordering', () => {
  it('maintains strict chronological ordering and sequence IDs across 50 rapid sequential proposals', () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Proposal Stress Test' },
      TEST_CHANNEL
    );

    const N = 50;
    for (let i = 1; i <= N; i++) {
      proposeTask(cwd, TEST_SESSION, task.id, `Agent-${i % 5}`, `Hypothesis #${i}`);
    }

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.proposals).toHaveLength(N);

    for (let i = 1; i <= N; i++) {
      const prop = replayed?.proposals?.[i - 1];
      expect(prop?.id).toBe(`prop-${i}`);
      expect(prop?.agent).toBe(`Agent-${i % 5}`);
      expect(prop?.content).toBe(`Hypothesis #${i}`);
      expect(typeof prop?.timestamp).toBe('string');
    }
  });

  it('maintains strict chronological ordering and sequence IDs across 50 rapid sequential challenges', () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Challenge Stress Test' },
      TEST_CHANNEL
    );
    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'OriginalClaimant');

    const N = 50;
    for (let i = 1; i <= N; i++) {
      challengeTask(cwd, TEST_SESSION, task.id, `Challenger-${i % 3}`, `Objection #${i}`);
    }

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.challenges).toHaveLength(N);

    for (let i = 1; i <= N; i++) {
      const chal = replayed?.challenges?.[i - 1];
      expect(chal?.id).toBe(`chal-${i}`);
      expect(chal?.agent).toBe(`Challenger-${i % 3}`);
      expect(chal?.content).toBe(`Objection #${i}`);
      expect(chal?.targetClaimant).toBe('OriginalClaimant');
    }
  });

  it('interleaves 60 rapid operations across 4 agents without sequence collisions', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Interleaved Debate' },
      TEST_CHANNEL
    );

    const agents = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    const count = 30;

    for (let i = 1; i <= count; i++) {
      const aProp = agents[(i * 1) % agents.length];
      const aChal = agents[(i * 3) % agents.length];
      proposeTask(cwd, TEST_SESSION, task.id, aProp, `Proposal round ${i}`);
      challengeTask(cwd, TEST_SESSION, task.id, aChal, `Challenge round ${i}`);
    }

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.proposals).toHaveLength(count);
    expect(replayed?.challenges).toHaveLength(count);

    // Verify proposals IDs are strictly prop-1..prop-30
    expect(replayed?.proposals?.map((p) => p.id)).toEqual(
      Array.from({ length: count }, (_, idx) => `prop-${idx + 1}`)
    );

    // Verify challenges IDs are strictly chal-1..chal-30
    expect(replayed?.challenges?.map((c) => c.id)).toEqual(
      Array.from({ length: count }, (_, idx) => `chal-${idx + 1}`)
    );
  });

  it('isolates proposals and challenges across multiple concurrent tasks without cross-contamination', () => {
    const cwd = createTempCwd();
    const task1 = taskStore.createTask(cwd, TEST_SESSION, { title: 'Task 1' }, TEST_CHANNEL);
    const task2 = taskStore.createTask(cwd, TEST_SESSION, { title: 'Task 2' }, TEST_CHANNEL);

    proposeTask(cwd, TEST_SESSION, task1.id, 'Agent-1', 'T1 Proposal A');
    proposeTask(cwd, TEST_SESSION, task2.id, 'Agent-2', 'T2 Proposal A');
    challengeTask(cwd, TEST_SESSION, task1.id, 'Agent-3', 'T1 Challenge A');
    proposeTask(cwd, TEST_SESSION, task1.id, 'Agent-1', 'T1 Proposal B');
    challengeTask(cwd, TEST_SESSION, task2.id, 'Agent-4', 'T2 Challenge A');

    const tasks = taskStore.replayTasks(cwd, TEST_SESSION);
    const t1 = tasks.find((t) => t.id === task1.id);
    const t2 = tasks.find((t) => t.id === task2.id);

    expect(t1?.proposals).toHaveLength(2);
    expect(t1?.challenges).toHaveLength(1);
    expect(t1?.proposals?.[0]?.content).toBe('T1 Proposal A');
    expect(t1?.proposals?.[1]?.content).toBe('T1 Proposal B');
    expect(t1?.challenges?.[0]?.content).toBe('T1 Challenge A');

    expect(t2?.proposals).toHaveLength(1);
    expect(t2?.challenges).toHaveLength(1);
    expect(t2?.proposals?.[0]?.content).toBe('T2 Proposal A');
    expect(t2?.challenges?.[0]?.content).toBe('T2 Challenge A');
  });

  it('preserves proposals and challenges through full task lifecycle transitions and resets', () => {
    const cwd = createTempCwd();
    const state = createMockState('Worker-1');
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Lifecycle Resilience' },
      TEST_CHANNEL
    );

    // 1. Propose while in todo
    taskPropose(
      { id: task.id, content: 'Initial hypothesis' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );

    // 2. Claim task
    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'Worker-1');

    // 3. Challenge claimant
    taskChallenge(
      { id: task.id, reason: 'Flawed logic' },
      createMockState('Critic-2'),
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );

    // 4. Progress
    taskStore.appendTaskEvent(cwd, TEST_SESSION, {
      taskId: task.id,
      type: 'progress',
      timestamp: new Date().toISOString(),
      agent: 'Worker-1',
      payload: { message: 'Addressing flaw' },
    });

    // 5. Done
    taskStore.completeTask(cwd, TEST_SESSION, task.id, 'Worker-1', 'Fixed');

    // 6. Challenge completed task
    taskChallenge(
      { id: task.id, reason: 'Missed edge case' },
      createMockState('Auditor-3'),
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );

    // 7. Reset task back to todo
    taskStore.resetTask(cwd, TEST_SESSION, task.id);

    // Replay
    const resetTaskState = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(resetTaskState?.status).toBe('todo');
    expect(resetTaskState?.claimed_by).toBeUndefined();
    // Historical proposals & challenges must remain intact for auditability
    expect(resetTaskState?.proposals).toHaveLength(1);
    expect(resetTaskState?.challenges).toHaveLength(2);
    expect(resetTaskState?.challenges?.[0]?.targetClaimant).toBe('Worker-1');
    expect(resetTaskState?.challenges?.[1]?.targetClaimant).toBe('Worker-1');
  });
});

describe('Suite 5: Adversarial — Feed persistence and disk JSONL integrity', () => {
  it('guarantees strictly valid JSON on every single line of tasks JSONL', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Disk Integrity Test' },
      TEST_CHANNEL
    );

    for (let i = 0; i < 20; i++) {
      proposeTask(cwd, TEST_SESSION, task.id, `Agent-${i}`, `Line\nBreak\t"Quoted" #${i}`);
      challengeTask(cwd, TEST_SESSION, task.id, `Critic-${i}`, `Objection\r\n\\Backslash\\ #${i}`);
    }

    const tasksFile = path.join(cwd, '.pi', 'messenger', 'tasks', `${TEST_SESSION}.jsonl`);
    expect(fs.existsSync(tasksFile)).toBe(true);

    const rawContent = fs.readFileSync(tasksFile, 'utf-8').trim();
    const lines = rawContent.split('\n');

    // 1 created + 20 proposed + 20 challenged = 41 lines
    expect(lines).toHaveLength(41);

    for (const [index, line] of lines.entries()) {
      expect(() => JSON.parse(line), `Line ${index} is invalid JSON: ${line}`).not.toThrow();
    }
  });

  it('guarantees strictly valid JSON on every single line of channels JSONL and accurate feed events', () => {
    const cwd = createTempCwd();
    const state = createMockState('FeedTester');
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Channel Feed Test' },
      TEST_CHANNEL
    );

    taskPropose(
      { id: task.id, content: 'Feed proposal 1\nwith newline' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    taskChallenge(
      { id: task.id, reason: 'Feed challenge 1\r\nwith carriage return' },
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );

    const channelFile = path.join(cwd, '.pi', 'messenger', 'channels', `${TEST_CHANNEL}.jsonl`);
    expect(fs.existsSync(channelFile)).toBe(true);

    const rawContent = fs.readFileSync(channelFile, 'utf-8').trim();
    const lines = rawContent.split('\n');

    expect(lines.length).toBeGreaterThanOrEqual(3); // metadata header + 2 feed events
    for (const [index, line] of lines.entries()) {
      expect(
        () => JSON.parse(line),
        `Channel line ${index} is invalid JSON: ${line}`
      ).not.toThrow();
    }

    // Verify feed events can be parsed
    const events = readFeedEvents(cwd, undefined, TEST_CHANNEL);
    const pEvent = events.find((e) => e.type === 'task.propose');
    const cEvent = events.find((e) => e.type === 'task.challenge');
    expect(pEvent).toBeDefined();
    expect(cEvent).toBeDefined();
    expect(pEvent?.preview).toContain('Feed proposal 1\nwith newline');
    // sanitizePreview maps \r -> \n, so \r\n becomes \n\n in feed preview
    expect(cEvent?.preview).toContain('Feed challenge 1');
    expect(cEvent?.preview).toContain('with carriage return');

    // But raw task store preserves raw verbatim objection
    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.challenges?.[0]?.content).toBe('Feed challenge 1\r\nwith carriage return');
  });

  it('feed pruning preserves file integrity and removes old entries without error', () => {
    const cwd = createTempCwd();
    const state = createMockState('Pruner');
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Prune Test' }, TEST_CHANNEL);

    for (let i = 0; i < 20; i++) {
      taskPropose({ id: task.id, content: `Prop ${i}` }, state, cwd, TEST_CHANNEL, TEST_SESSION);
    }

    expect(readFeedEvents(cwd, undefined, TEST_CHANNEL).length).toBe(20);

    // Prune to 5 events
    pruneFeed(cwd, 5, TEST_CHANNEL);

    const prunedEvents = readFeedEvents(cwd, undefined, TEST_CHANNEL);
    expect(prunedEvents.length).toBe(5);
    expect(prunedEvents[prunedEvents.length - 1]?.preview).toBe('Prop 19');
  });
});

describe('Suite 6: Adversarial — CLI argument splitting and schema resolution', () => {
  it('correctly parses CLI arguments with multiple words, quotes, and flags', () => {
    const specP = findCommandSpec('propose task-1 Strategy with many words');
    expect(specP?.action).toBe('propose');

    const splitP = splitCliArgs('propose task-1 Strategy with many words');
    expect(splitP).toEqual(['propose', 'task-1', 'Strategy with many words']);

    const specC = findCommandSpec('challenge task-1 Flaw with counter-example');
    expect(specC?.action).toBe('challenge');

    const splitC = splitCliArgs('challenge task-1 Flaw with counter-example');
    expect(splitC).toEqual(['challenge', 'task-1', 'Flaw with counter-example']);

    // Subcommand forms
    const splitSubP = splitCliArgs('task propose task-1 Use non-blocking io');
    expect(splitSubP).toEqual(['task', 'propose', 'task-1', 'Use non-blocking io']);

    const splitSubC = splitCliArgs('task challenge task-1 Race condition on socket');
    expect(splitSubC).toEqual(['task', 'challenge', 'task-1', 'Race condition on socket']);
  });
});

describe('Suite 7: Adversarial — Parameter aliases, blocked task debate, and E2E HTTP CLI', () => {
  it('supports parameter aliases across propose and challenge handlers', () => {
    const cwd = createTempCwd();
    const state = createMockState();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Alias Test' }, TEST_CHANNEL);

    // taskPropose with `proposal`
    const p1 = taskPropose(
      { id: task.id, proposal: 'Via proposal field' } as any,
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(p1.details.error).toBeUndefined();

    // taskPropose with `message`
    const p2 = taskPropose(
      { id: task.id, message: 'Via message field' } as any,
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(p2.details.error).toBeUndefined();

    // taskChallenge with `challenge`
    const c1 = taskChallenge(
      { id: task.id, challenge: 'Via challenge field' } as any,
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(c1.details.error).toBeUndefined();

    // taskChallenge with `content`
    const c2 = taskChallenge(
      { id: task.id, content: 'Via content field' } as any,
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(c2.details.error).toBeUndefined();

    // taskChallenge with `message`
    const c3 = taskChallenge(
      { id: task.id, message: 'Via message field' } as any,
      state,
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(c3.details.error).toBeUndefined();

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    expect(replayed?.proposals).toHaveLength(2);
    expect(replayed?.challenges).toHaveLength(3);
  });

  it('allows active debate (propose and challenge) on blocked tasks while preserving blocked status', () => {
    const cwd = createTempCwd();
    const state = createMockState('Architect');
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Blocked Task Debate' },
      TEST_CHANNEL
    );

    // Block the task
    taskStore.blockTask(cwd, TEST_SESSION, task.id, 'Architect', 'Waiting for hardware HSM');

    // Debaters propose workarounds and challenge assumptions
    const pRes = taskPropose(
      { id: task.id, content: 'Use TPM 2.0 or PKCS#11 software token instead' },
      createMockState('Debater-A'),
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(pRes.details.error).toBeUndefined();

    const cRes = taskChallenge(
      { id: task.id, reason: 'Software token fails FIPS 140-3 Level 3 compliance mandate' },
      createMockState('Auditor-B'),
      cwd,
      TEST_CHANNEL,
      TEST_SESSION
    );
    expect(cRes.details.error).toBeUndefined();

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION).find((t) => t.id === task.id);
    // Must remain blocked
    expect(replayed?.status).toBe('blocked');
    expect(replayed?.blocked_reason).toBe('Waiting for hardware HSM');
    expect(replayed?.proposals).toHaveLength(1);
    expect(replayed?.challenges).toHaveLength(1);
  });

  it('executes full CLI lifecycle end-to-end over HTTP server without crashing', () => {
    const cwd = createTempCwd();
    const cliPath = path.resolve(__dirname, '../../dist/harness/cli.js');
    const port = String(20000 + Math.floor(Math.random() * 5000));
    const messengerDir = path.join(cwd, '.pi', 'messenger');

    const env = {
      ...process.env,
      PI_MESSENGER_PORT: port,
      PI_MESSENGER_DIR: messengerDir,
      PI_MESSENGER_CWD: cwd,
    };

    // 1. Start server
    execFileSync(process.execPath, [cliPath, '--start'], { env, encoding: 'utf-8', cwd });

    try {
      // 2. Join mesh
      execFileSync(process.execPath, [cliPath, 'join', '--channel', 'dev'], {
        env,
        encoding: 'utf-8',
        cwd,
      });

      // 3. Propose on non-existent task -> must output error text and not crash
      const ghostPropOut = execFileSync(
        process.execPath,
        [cliPath, 'propose', 'non-existent-task', 'Ghost plan'],
        { env, encoding: 'utf-8', cwd }
      );
      expect(ghostPropOut).toContain('Error: task non-existent-task not found');

      // 4. Challenge on non-existent task -> must output error text and not crash
      const ghostChalOut = execFileSync(
        process.execPath,
        [cliPath, 'challenge', 'non-existent-task', 'Ghost objection'],
        { env, encoding: 'utf-8', cwd }
      );
      expect(ghostChalOut).toContain('Error: task non-existent-task not found');

      // 5. Create real task via CLI
      execFileSync(process.execPath, [cliPath, 'task', 'create', '--title', 'E2E Task'], {
        env,
        encoding: 'utf-8',
        cwd,
      });

      // 6. Propose via top-level CLI
      const topPropOut = execFileSync(
        process.execPath,
        [cliPath, 'propose', 'task-1', 'Top level CLI proposal'],
        { env, encoding: 'utf-8', cwd }
      );
      expect(topPropOut).toContain('Proposal submitted for task-1.');

      // 7. Challenge via top-level CLI
      const topChalOut = execFileSync(
        process.execPath,
        [cliPath, 'challenge', 'task-1', 'Top level CLI challenge'],
        { env, encoding: 'utf-8', cwd }
      );
      expect(topChalOut).toContain('Challenge recorded for task-1.');

      // 8. Propose via subcommand CLI
      const subPropOut = execFileSync(
        process.execPath,
        [cliPath, 'task', 'propose', 'task-1', 'Subcommand CLI proposal'],
        { env, encoding: 'utf-8', cwd }
      );
      expect(subPropOut).toContain('Proposal submitted for task-1.');

      // 9. Challenge via subcommand CLI
      const subChalOut = execFileSync(
        process.execPath,
        [cliPath, 'task', 'challenge', 'task-1', 'Subcommand CLI challenge'],
        { env, encoding: 'utf-8', cwd }
      );
      expect(subChalOut).toContain('Challenge recorded for task-1.');

      // 10. Check raw files persisted on disk
      const tasksFiles = fs.readdirSync(path.join(messengerDir, 'tasks'));
      const taskJsonl = tasksFiles.find((f) => f.endsWith('.jsonl'));
      expect(taskJsonl).toBeDefined();

      const taskJsonlContent = fs.readFileSync(
        path.join(messengerDir, 'tasks', taskJsonl!),
        'utf-8'
      );
      expect(taskJsonlContent).toContain('Top level CLI proposal');
      expect(taskJsonlContent).toContain('Top level CLI challenge');
      expect(taskJsonlContent).toContain('Subcommand CLI proposal');
      expect(taskJsonlContent).toContain('Subcommand CLI challenge');
    } finally {
      // 11. Stop server
      try {
        execFileSync(process.execPath, [cliPath, '--stop'], { env, encoding: 'utf-8', cwd });
      } catch {}
    }
  });
});
