/** Project ownership is independent of package location and messaging storage. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Dirs } from './lib.js';

export function resolveProject(start: string, explicit?: string): string {
  let dir = fs.realpathSync(path.resolve(explicit || start));
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      // Only managed sandboxes inherit ownership; ordinary worktrees are Projects.
      if (dir.includes(`${path.sep}.swarm${path.sep}workspaces${path.sep}`)) {
        const parent = dir.slice(
          0,
          dir.indexOf(`${path.sep}.swarm${path.sep}workspaces${path.sep}`)
        );
        const listing = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
          cwd: parent,
          encoding: 'utf8',
        });
        if (listing.split('\0').includes(`worktree ${dir}`)) return fs.realpathSync(parent);
      }
      return dir;
    }
    if (fs.existsSync(path.join(dir, '.pi'))) return dir;
    const parent = path.dirname(dir);
    if (dir === parent)
      throw new Error('Missing Project Context: run inside a Project or use --project <path>.');
    dir = parent;
  }
}

export function activeRunId(cwd: string): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.pi/messenger/active-run.json'), 'utf8')).id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function configuredStorage(): string | undefined {
  return (
    process.env.PI_MESSENGER_DIR?.trim() ||
    (process.env.PI_MESSENGER_GLOBAL === '1'
      ? path.join(
          process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'),
          'messenger'
        )
      : undefined)
  );
}

export function selectStorage(cwd: string, storage: string): void {
  const file = path.join(cwd, '.pi/messenger/storage.json');
  const root = path.resolve(storage);
  if (root === path.join(cwd, '.pi/messenger')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).root !== root)
    throw new Error(
      'Project messaging storage is already selected; migrate it explicitly before changing it.'
    );
  fs.writeFileSync(file, JSON.stringify({ root }));
}

export function messengerDirs(cwd: string, runId = activeRunId(cwd)): Dirs {
  if (runId && !/^[\w.-]+$/.test(runId)) throw new Error('Invalid run identity.');
  cwd = fs.realpathSync(cwd);
  let storage: string | undefined;
  try {
    storage = JSON.parse(
      fs.readFileSync(path.join(cwd, '.pi/messenger/storage.json'), 'utf8')
    ).root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let base = storage
    ? path.join(storage, 'projects', createHash('sha256').update(cwd).digest('hex').slice(0, 24))
    : path.join(cwd, '.pi/messenger');
  if (runId) base = path.join(base, 'runs', runId);
  return { base, registry: path.join(base, 'registry') };
}
