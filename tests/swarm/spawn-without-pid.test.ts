import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { readRun, startRun } from '../../swarm/run-store.js';
import { appendTaskEvent } from '../../swarm/task-store/events.js';
import { listSpawned } from '../../swarm/spawn.js';
import { recoverRun } from '../../swarm/recovery.js';
import { createTestGitRepo } from '../helpers/git-fixtures.js';

it('counts a successor whose pi binary cannot start as a takeover failure, with no peer record', () => {
  const repo = createTestGitRepo({ prefix: 'spawn-without-pid-' });
  const cwd = repo.gitDir;
  const run = startRun(cwd, { goal: 'Start a successor', delegator: 'Delegator' });
  const now = new Date().toISOString();
  appendTaskEvent(cwd, run.id, {
    taskId: 'task-1',
    type: 'created',
    timestamp: now,
    agent: 'Delegator',
    payload: { title: 'Work', dependsOn: [], createdBy: 'Delegator' },
  } as Parameters<typeof appendTaskEvent>[2]);
  const events = path.join(cwd, '.pi', 'messenger', 'agents', `${run.id}.jsonl`);
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.writeFileSync(
    events,
    JSON.stringify({
      id: 'exited1',
      type: 'failed',
      timestamp: now,
      agent: {
        id: 'exited1',
        cwd,
        name: 'Exited',
        role: 'Subagent',
        objective: 'work',
        taskId: 'task-1',
        status: 'failed',
        startedAt: now,
        sessionId: run.id,
        exitCode: 1,
      },
    }) + '\n'
  );
  // Only git is reachable, so `pi` itself fails to spawn (ENOENT, no pid).
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-no-pi-bin-'));
  fs.symlinkSync(
    execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
    path.join(bin, 'git')
  );
  const PATH = process.env.PATH;
  process.env.PATH = bin;
  try {
    recoverRun(cwd);
  } finally {
    process.env.PATH = PATH;
  }
  try {
    const handoff = readRun(cwd)!.handoffs['task-1'];
    expect(handoff.failures).toBe(1);
    expect(handoff.errors.join('\n')).toContain('failed to start');
    expect(listSpawned(cwd, run.id, true).map((peer) => peer.id)).toEqual(['exited1']);
    const workspaces = path.join(cwd, '.swarm', 'workspaces');
    expect(fs.existsSync(workspaces) ? fs.readdirSync(workspaces) : []).toEqual([]);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  }
});
