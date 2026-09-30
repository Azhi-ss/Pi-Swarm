/** Project ownership is independent of package location and messaging storage. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Dirs } from './lib.js';

/**
 * Select the Project for a command.
 * Explicit `--project` and peer-supplied `PI_SWARM_PROJECT_ROOT` win over the working directory.
 * A service pin, last-used Project, installation directory, or startup directory is not a selector.
 */
export function resolveProjectContext(input: {
  cwd: string;
  explicit?: string;
  peer?: string;
}): string {
  const explicit = input.explicit?.trim();
  if (explicit) return resolveProject(explicit);
  const peer = input.peer?.trim();
  if (peer) return resolveProject(peer);
  return resolveProject(input.cwd);
}

export function resolveProject(start: string): string {
  let dir: string;
  try {
    dir = fs.realpathSync(path.resolve(start));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Missing Project Context: ${start} was not found. Run inside a Project or use --project <path>.`
      );
    }
    throw error;
  }
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

/** A peer cwd belongs to this Project when it is the Project root or one of its Sandboxes. */
export function peerBelongsToProject(project: string, peerCwd: string): boolean {
  const canonical = (dir: string) => {
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  const location = path.relative(canonical(project), canonical(peerCwd));
  return (
    location === '' ||
    (location !== '' &&
      !location.startsWith(`..${path.sep}`) &&
      location !== '..' &&
      location.startsWith(`.swarm${path.sep}workspaces${path.sep}`))
  );
}

export function activeRunId(cwd: string): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.pi/messenger/active-run.json'), 'utf8')).id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Swarm operations follow the owning Project's active run, not a conversation id. */
export function swarmSessionId(cwd: string, interactionSessionId = ''): string {
  let project = cwd;
  try {
    project = resolveProject(cwd);
  } catch {
    // Missing Project Context keeps the Interaction Session.
  }
  return activeRunId(project) || interactionSessionId;
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
