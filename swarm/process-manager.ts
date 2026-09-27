import { type ChildProcess } from 'node:child_process';
import { removeWorktree } from './worktree/index.js';

export interface ManagedWorkerProcess {
  id: string;
  name: string; // "[Swarm] worker-<id>"
  agentName: string; // Memorable agent name
  pid: number;
  cwd: string;
  worktreePath?: string;
  port?: number;
  testPort?: number;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'stopped';
  timeoutMs: number;
  error?: string;
}

export interface ProcessLogEntry {
  stdout: string[];
  stderr: string[];
}

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes (600s)
const MAX_LOG_LINES = 1_000;

export function forceKillProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid || pid <= 0) return;

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
    } catch {
      // Process group might not exist or process already dead
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process already dead
  }
}

export class ProcessManager {
  private workers = new Map<string, ManagedWorkerProcess>();
  private processes = new Map<string, ChildProcess>();
  private logs = new Map<string, ProcessLogEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  /**
   * Register a worker process with optional child process handle and timeout callback.
   */
  public register(worker: ManagedWorkerProcess, proc?: ChildProcess, onTimeout?: () => void): void {
    const timeoutMs =
      worker.timeoutMs && worker.timeoutMs > 0 ? worker.timeoutMs : DEFAULT_TIMEOUT_MS;
    const managed: ManagedWorkerProcess = {
      ...worker,
      timeoutMs,
      status: worker.status ?? 'running',
    };

    this.workers.set(worker.id, managed);
    if (!this.logs.has(worker.id)) {
      this.logs.set(worker.id, { stdout: [], stderr: [] });
    }

    if (proc) {
      this.processes.set(worker.id, proc);

      proc.once('close', (code, signal) => {
        this.clearTimer(worker.id);
        const w = this.workers.get(worker.id);
        if (w && w.status === 'running') {
          w.status = code === 0 && !signal ? 'completed' : 'failed';
          if (code !== 0 && !w.error) {
            w.error = signal ? `Terminated with signal ${signal}` : `Exited with code ${code ?? 1}`;
          }
        }
      });
    }

    // Clear any existing timer for this ID
    this.clearTimer(worker.id);

    // Setup hard timeout timer
    if (timeoutMs > 0 && timeoutMs !== Number.POSITIVE_INFINITY) {
      const timer = setTimeout(() => {
        const w = this.workers.get(worker.id);
        if (!w || w.status !== 'running') return;

        w.status = 'timeout';
        w.error = `Process timed out after ${timeoutMs}ms`;

        // Force kill process group
        forceKillProcessGroup(w.pid, 'SIGKILL');
        const p = this.processes.get(worker.id);
        if (p) {
          try {
            p.kill('SIGKILL');
          } catch {}
        }

        // Coordinate Module 7 sandbox cleanup
        if (w.cwd) {
          try {
            removeWorktree(w.cwd, w.id);
          } catch {}
        }

        this.appendLog(
          worker.id,
          'stderr',
          `[ProcessManager] Worker ${worker.id} exceeded hard timeout of ${timeoutMs}ms - SIGKILL dispatched.\n`
        );

        if (onTimeout) {
          try {
            onTimeout();
          } catch {}
        }
      }, timeoutMs);

      timer.unref?.();
      this.timers.set(worker.id, timer);
    }
  }

  /**
   * Append stdout or stderr lines to worker ring buffer.
   */
  public appendLog(id: string, type: 'stdout' | 'stderr', chunk: string): void {
    let entry = this.logs.get(id);
    if (!entry) {
      entry = { stdout: [], stderr: [] };
      this.logs.set(id, entry);
    }

    const lines = chunk.split('\n');
    const target = type === 'stdout' ? entry.stdout : entry.stderr;
    for (const line of lines) {
      if (!line && lines.length > 1) continue;
      target.push(line);
      if (target.length > MAX_LOG_LINES) {
        target.shift();
      }
    }
  }

  /**
   * Retrieve captured stdout and stderr for a worker.
   */
  public getLogs(id: string, maxLines: number = 100): { stdout: string; stderr: string } {
    const entry = this.logs.get(id);
    if (!entry) {
      return { stdout: '', stderr: '' };
    }
    const stdout = entry.stdout.slice(-maxLines).join('\n');
    const stderr = entry.stderr.slice(-maxLines).join('\n');
    return { stdout, stderr };
  }

  /**
   * Terminate a worker process group and coordinate worktree removal.
   */
  public kill(id: string, signal: NodeJS.Signals = 'SIGKILL'): boolean {
    const worker = this.get(id);
    if (!worker) return false;

    this.clearTimer(worker.id);

    forceKillProcessGroup(worker.pid, signal);
    const proc = this.processes.get(worker.id);
    if (proc) {
      try {
        proc.kill(signal);
      } catch {}
    }

    worker.status = 'stopped';
    worker.error = `Manually stopped with signal ${signal}`;

    // Clean up worktree if sandbox allocated
    if (worker.cwd) {
      try {
        removeWorktree(worker.cwd, worker.id);
      } catch {}
    }

    return true;
  }

  /**
   * Batch terminate all running worker processes.
   */
  public killAll(signal: NodeJS.Signals = 'SIGKILL'): void {
    for (const worker of this.workers.values()) {
      if (worker.status === 'running') {
        this.kill(worker.id, signal);
      }
    }
  }

  /**
   * List workers, defaulting to running only unless includeAll is true.
   */
  public list(includeAll: boolean = false): ManagedWorkerProcess[] {
    const all = Array.from(this.workers.values());
    if (includeAll) return all;
    return all.filter((w) => w.status === 'running');
  }

  /**
   * Lookup a worker by id, agentName, or name.
   */
  public get(id: string): ManagedWorkerProcess | undefined {
    if (this.workers.has(id)) {
      return this.workers.get(id);
    }
    for (const w of this.workers.values()) {
      if (w.agentName === id || w.name === id) {
        return w;
      }
    }
    return undefined;
  }

  /**
   * Clean up timers and references for a finished worker.
   */
  public cleanup(id: string): void {
    this.clearTimer(id);
    this.processes.delete(id);
  }

  /**
   * Clear all state (used for test teardown).
   */
  public clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.processes.clear();
    this.logs.clear();
    this.workers.clear();
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}

export const processManager = new ProcessManager();

/**
 * Handover child process to @aliou/pi-processes if active in the Pi extension runtime.
 */
export function adoptWorkerIfSupported(
  pi: any,
  worker: ManagedWorkerProcess,
  proc: ChildProcess
): boolean {
  if (
    pi &&
    typeof pi.events?.listenerCount === 'function' &&
    pi.events.listenerCount('processes:command:adopt') > 0
  ) {
    try {
      pi.events.emit('processes:command:adopt', {
        name: worker.name,
        command: `pi worker ${worker.id}`,
        cwd: worker.cwd,
        child: proc,
        startTime: Date.parse(worker.startedAt) || Date.now(),
        reply: () => {},
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
