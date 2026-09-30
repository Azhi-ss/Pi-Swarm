import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { messengerDirs } from '../../project.js';
import { startRun } from '../../swarm/run-store.js';
import * as store from '../../store.js';
import { createContext, createState } from '../helpers/messenger-fixtures.js';
import { createTestGitRepo } from '../helpers/git-fixtures.js';

it('registers a sandbox peer against the owning project run, not its interaction session', () => {
  const repo = createTestGitRepo({ prefix: 'run-bind-' });
  const run = startRun(repo.gitDir, { goal: 'Bind the sandbox peer', delegator: 'Delegator' });
  const sandbox = repo.allocateSandbox('binder', 'Binder');
  const dirs = messengerDirs(repo.gitDir, run.id);
  fs.mkdirSync(dirs.registry, { recursive: true });
  const state = createState('Binder');
  const ctx = createContext(sandbox.worktreePath, 'interaction-session');

  expect(store.register(state, dirs, ctx)).toBe(true);

  const saved = JSON.parse(fs.readFileSync(path.join(dirs.registry, 'Binder.json'), 'utf8'));
  expect(saved.sessionId).toBe(run.id);
  expect(saved.sessionId).not.toBe('interaction-session');
});
