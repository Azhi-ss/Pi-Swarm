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

  constructor(config?: Partial<BudgetConfig>) {
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
    if (this.tripped) {
      return { tripped: true, consumed: this.consumedSteps };
    }

    this.consumedSteps++;
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
    return this.tripped;
  }

  /**
   * Red-line trip: broadcast abort, batch terminate workers, clean worktrees,
   * lock blackboard while strictly preserving Zone 3 verified facts.
   */
  public async triggerAbort(cwd: string, sessionId: string, reason?: string): Promise<void> {
    // A human observer may have no registration/session header. Keep the
    // displayed session's verified facts when refreshing its locked projection.
    let snapshotSessionId = sessionId;
    try {
      const snapshot = fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf8');
      snapshotSessionId =
        snapshot.match(/^> Updated: [^\n]* \| Session: ([^\n|]*) \| Active Peers:/m)?.[1] ??
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
