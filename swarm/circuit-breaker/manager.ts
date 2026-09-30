import { forceKillProcessGroup } from '../process-manager.js';
import { activeRunId } from '../../project.js';
import { readRun, updateRun, endRun } from '../run-store.js';
import type { BudgetConfig, BudgetStatus } from './types.js';
import { forceKillAllSpawned } from '../spawn.js';
import { listActiveWorktrees, removeWorktree, pruneWorktrees } from '../worktree/index.js';
import { logFeedEvent } from '../../feed/index.js';
import { appendTaskEvent } from '../task-store/events.js';
import { writeBlackboard } from '../task-store/blackboard.js';
import { normalizeCwd } from '../../store/shared.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export class CircuitBreakerManager {
  private maxSteps: number = 50;
  private enabled: boolean = true;
  private consumedSteps: number = 0;
  private tripped: boolean = false;
  private trippedAt?: string;
  private trippedReason?: string;

  constructor(
    config?: Partial<BudgetConfig>,
    private scope?: { cwd: string; runId: string }
  ) {
    if (config?.maxSteps !== undefined) this.maxSteps = config.maxSteps;
    if (config?.enabled !== undefined) this.enabled = config.enabled;
  }

  /**
   * Record a tool execution step across host or worker.
   */
  public recordStep(
    _agentName?: string,
    _toolName?: string,
    context?: { cwd?: string; sessionId?: string }
  ): { tripped: boolean; consumed: number } {
    if (!this.enabled) {
      return { tripped: false, consumed: this.consumedSteps };
    }
    if (this.isTripped()) {
      return { tripped: true, consumed: this.consumedSteps };
    }

    if (this.scope) {
      const { cwd, runId } = this.scope;
      const run = updateRun(cwd, runId, (current) => {
        if (current.status === 'active' && current.consumedSteps < current.maxSteps)
          current.consumedSteps++;
      });
      this.consumedSteps = run.consumedSteps;
      this.maxSteps = run.maxSteps;
    } else this.consumedSteps++;
    if (this.consumedSteps >= this.maxSteps) {
      this.tripped = true;
      this.trippedAt = new Date().toISOString();
      this.trippedReason = `Global step budget exceeded (${this.consumedSteps}/${this.maxSteps} steps)`;
      if (context?.cwd && context?.sessionId) {
        void this.triggerAbort(context.cwd, context.sessionId, this.trippedReason);
      }
      return { tripped: true, consumed: this.consumedSteps };
    }

    return { tripped: false, consumed: this.consumedSteps };
  }

  public getStatus(): BudgetStatus {
    if (this.scope) {
      const run = readRun(this.scope.cwd, this.scope.runId)!;
      this.consumedSteps = run.consumedSteps;
      this.maxSteps = run.maxSteps;
      this.tripped = run.status !== 'active' || run.consumedSteps >= run.maxSteps;
    }
    return {
      consumedSteps: this.consumedSteps,
      maxSteps: this.maxSteps,
      remainingSteps: Math.max(0, this.maxSteps - this.consumedSteps),
      isTripped: this.tripped,
      trippedAt: this.trippedAt,
      trippedReason: this.trippedReason,
    };
  }

  public isTripped(): boolean {
    return this.scope ? this.getStatus().isTripped : this.tripped;
  }

  /**
   * Red-line trip: broadcast abort, batch terminate workers, clean worktrees,
   * lock blackboard while strictly preserving Zone 3 verified facts.
   */
  public async triggerAbort(cwd: string, sessionId: string, reason?: string): Promise<void> {
    if (this.scope && activeRunId(cwd) !== this.scope.runId) return;
    // A human observer may have no registration/session header. Keep the
    // displayed session's verified facts when refreshing its locked projection.
    let snapshotSessionId = sessionId;
    try {
      const snapshot = fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf8');
      snapshotSessionId =
        snapshot.match(/\| (?:Session|Run): ([^|\n]*?) \| Active Peers:/m)?.[1]?.trim() ??
        sessionId;
    } catch {
      // No projection yet; use the caller's session.
    }
    if (!this.tripped) {
      this.tripped = true;
      this.trippedAt = new Date().toISOString();
    }
    const finalReason =
      reason ||
      this.trippedReason ||
      `Global step budget exceeded (${this.consumedSteps}/${this.maxSteps} steps)`;
    this.trippedReason = finalReason;

    // Persist the stop before terminating peers: crash recovery must not resurrect them.
    if (this.scope)
      updateRun(cwd, this.scope.runId, (run) => {
        run.status = 'aborted';
        if (run.acceptancePid) forceKillProcessGroup(run.acceptancePid);
        delete run.acceptancePid;
      });

    // 1. Broadcast swarm.abort feed event to channels
    const msg = `🛑 [CIRCUIT BREAKER] Swarm aborted: ${finalReason}. All worker activity halted. Blackboard locked.`;
    try {
      logFeedEvent(cwd, 'circuit-breaker', 'swarm.abort' as any, undefined, msg, '#all');
      logFeedEvent(
        cwd,
        'circuit-breaker',
        'swarm.abort' as any,
        undefined,
        msg,
        'swarm/announcements'
      );
    } catch {}

    // 2. Append swarm.abort event to task event log
    try {
      appendTaskEvent(cwd, snapshotSessionId, {
        taskId: 'swarm',
        type: 'swarm.abort' as any,
        timestamp: new Date().toISOString(),
        agent: 'circuit-breaker',
        payload: {
          reason: finalReason,
          consumedSteps: this.consumedSteps,
          maxSteps: this.maxSteps,
        },
      });
    } catch {}

    // 3. Batch terminate all worker processes
    try {
      forceKillAllSpawned(cwd);
    } catch {}

    // 4. Coordinate sandbox worktree cleanup
    try {
      const active = listActiveWorktrees();
      for (const wt of active) {
        const location = path.relative(normalizeCwd(cwd), normalizeCwd(wt.worktreePath));
        if (location !== '' && !location.startsWith(`.swarm${path.sep}workspaces${path.sep}`))
          continue;
        removeWorktree(cwd, wt.agentId);
      }
      pruneWorktrees(cwd);
    } catch {}

    // 5. Update BLACKBOARD.md header with tripped banner
    try {
      writeBlackboard(cwd, snapshotSessionId);
    } catch {}
    if (this.scope) endRun(cwd, this.scope.runId, 'aborted');
  }

  public reset(): void {
    this.consumedSteps = 0;
    this.tripped = false;
    this.trippedAt = undefined;
    this.trippedReason = undefined;
  }

  public setBudget(maxSteps: number): void {
    this.maxSteps = maxSteps;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export const circuitBreaker = new CircuitBreakerManager();

const runBreakers = new Map<string, CircuitBreakerManager>();
export function getCircuitBreaker(cwd: string, sessionId?: string): CircuitBreakerManager {
  const id = sessionId || activeRunId(cwd);
  if (!id) return circuitBreaker;
  let run;
  try {
    run = readRun(cwd, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!run) return circuitBreaker; // Legacy session API, before explicit run admission.
  const key = `${cwd}:${id}`;
  if (!runBreakers.has(key))
    runBreakers.set(key, new CircuitBreakerManager({ maxSteps: run.maxSteps }, { cwd, runId: id }));
  return runBreakers.get(key)!;
}
