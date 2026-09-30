import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { startRun } from '../../swarm/run-store.js';
import { listSpawned, reconcileSpawnedAgents, PRESERVATION_FAILED } from '../../swarm/spawn.js';
import { createTestGitRepo } from '../helpers/git-fixtures.js';

it('keeps a crashed peer Sandbox and records the failure when its candidate cannot be saved', () => {
  const repo = createTestGitRepo({ prefix: 'reconcile-preserve-' });
  const run = startRun(repo.gitDir, { goal: 'Reconcile after restart', delegator: 'Delegator' });
  // Outside any repository, so every git command in the Sandbox fails.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-broken-sandbox-'));
  fs.writeFileSync(path.join(sandbox, 'work.ts'), 'export const unsaved = 1;\n');
  const exited = spawnSync(process.execPath, ['-e', '0']).pid!;
  const events = path.join(repo.gitDir, '.pi', 'messenger', 'agents', `${run.id}.jsonl`);
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.writeFileSync(
    events,
    JSON.stringify({
      id: 'crashed1',
      type: 'spawned',
      timestamp: new Date().toISOString(),
      agent: {
        id: 'crashed1',
        cwd: repo.gitDir,
        name: 'Crashed',
        role: 'Subagent',
        objective: 'work',
        taskId: 'task-1',
        status: 'running',
        startedAt: new Date().toISOString(),
        sessionId: run.id,
        worktreePath: sandbox,
        pid: exited,
      },
    }) + '\n'
  );
  try {
    expect(reconcileSpawnedAgents(repo.gitDir, run.id)).toBe(1);
    const [peer] = listSpawned(repo.gitDir, run.id, true);
    expect(peer).toMatchObject({ id: 'crashed1', status: 'failed' });
    expect(peer.error).toContain(PRESERVATION_FAILED);
    expect(fs.readFileSync(path.join(sandbox, 'work.ts'), 'utf8')).toContain('unsaved');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
    repo.cleanup();
  }
});
