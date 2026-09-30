import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeRunId } from '../project.js';

export interface HandoffState {
  failures: number;
  errors: string[];
  suspended?: boolean;
  predecessor?: string;
  successor?: string;
  startedAt?: string;
  takenOver?: boolean;
}
export interface SwarmRun {
  id: string;
  project: string;
  goal: string;
  delegator: string;
  status: 'active' | 'completed' | 'aborted';
  startedAt: string;
  endedAt?: string;
  maxSteps: number;
  consumedSteps: number;
  concurrency: number;
  stopReason?: string;
  acceptanceCommand?: string;
  acceptanceOwner?: number;
  acceptancePid?: number;
  acceptance?: {
    command: string;
    exitCode: number;
    output: string;
    checkedAt: string;
    head: string;
  };
  handoffs: Record<string, HandoffState>;
}
const root = (cwd: string) => path.join(cwd, '.pi/messenger');
const runPath = (cwd: string, id: string) => {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Invalid run ID');
  return path.join(root(cwd), 'run-history', `${id}.json`);
};
export function readRun(cwd: string, id = activeRunId(cwd)): SwarmRun | undefined {
  if (!id) return;
  return JSON.parse(fs.readFileSync(runPath(cwd, id), 'utf8'));
}
export function readRunIfPresent(cwd: string, id?: string): SwarmRun | undefined {
  try {
    return readRun(cwd, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof Error && error.message === 'Invalid run ID') return;
    throw error;
  }
}
/** Active run, otherwise the most recently ended run still on disk. */
export function readMostRecentRun(cwd: string): SwarmRun | undefined {
  const active = readRunIfPresent(cwd);
  if (active) return active;
  const history = path.join(root(cwd), 'run-history');
  if (!fs.existsSync(history)) return;
  const runs: SwarmRun[] = [];
  for (const file of fs.readdirSync(history)) {
    if (!file.endsWith('.json')) continue;
    const run = readRunIfPresent(cwd, file.slice(0, -5));
    if (run) runs.push(run);
  }
  runs.sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
  return runs[0];
}
function atomicWrite(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}
// Held only for synchronous state changes; never hold across a verifier or process wait.
export function withRunLock<T>(cwd: string, operation: () => T): T {
  fs.mkdirSync(root(cwd), { recursive: true });
  const lock = path.join(root(cwd), 'run.lock');
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        try {
          process.kill(owner, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        }
      } catch {
        // A crash between mkdir and writing the owner must not wedge admission forever.
        try {
          if (
            Date.now() - fs.statSync(lock).mtimeMs > 30_000 &&
            !fs.existsSync(path.join(lock, 'pid'))
          ) {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        } catch {}
      }
      if (Date.now() >= deadline) throw new Error('Project run is busy; retry the command.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  try {
    return operation();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
export function startRun(
  cwd: string,
  input: {
    goal: string;
    delegator: string;
    maxSteps?: number;
    concurrency?: number;
    acceptanceCommand?: string;
  }
): SwarmRun {
  return withRunLock(cwd, () => {
    if (activeRunId(cwd))
      throw new Error('A Swarm Run is already active; use run join or run status.');
    if (!input.goal?.trim()) throw new Error('run start requires --goal.');
    const maxSteps = input.maxSteps ?? 50,
      concurrency = input.concurrency ?? 3;
    if (![maxSteps, concurrency].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('Budget and concurrency must be positive integers.');
    const run: SwarmRun = {
      id: randomUUID(),
      project: cwd,
      goal: input.goal,
      delegator: input.delegator,
      status: 'active',
      startedAt: new Date().toISOString(),
      maxSteps,
      consumedSteps: 0,
      concurrency,
      acceptanceCommand: input.acceptanceCommand,
      handoffs: {},
    };
    atomicWrite(runPath(cwd, run.id), run);
    atomicWrite(path.join(root(cwd), 'active-run.json'), { id: run.id });
    return run;
  });
}
export function updateRun(cwd: string, id: string, update: (run: SwarmRun) => void): SwarmRun {
  return withRunLock(cwd, () => {
    const run = readRun(cwd, id)!;
    update(run);
    atomicWrite(runPath(cwd, id), run);
    return run;
  });
}
export function endRun(
  cwd: string,
  id: string,
  status: 'completed' | 'aborted',
  validate?: () => void
): void {
  withRunLock(cwd, () => {
    const run = readRun(cwd, id)!;
    if (run.status !== 'active' && run.status !== status) {
      if (validate) throw new Error('Run stopped during overall acceptance.');
      return;
    }
    validate?.();
    run.status = status;
    run.endedAt = new Date().toISOString();
    atomicWrite(runPath(cwd, id), run);
    const snapshot = path.join(cwd, 'BLACKBOARD.md');
    if (fs.existsSync(snapshot))
      fs.copyFileSync(snapshot, runPath(cwd, id).replace(/\.json$/, '.md'));
    if (activeRunId(cwd) === id) fs.unlinkSync(path.join(root(cwd), 'active-run.json'));
  });
}
