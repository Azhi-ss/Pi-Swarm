import { activeRunId } from '../../project.js';
import type { WatchdogConfig, ReclaimResult, AllDeadStatus, SteerSender } from './types.js';
import { inspectAndReclaimStaleLeases } from './lease.js';
import { checkAllDead, triggerAllDeadFallback, resetFallbackLatch } from './fallback.js';

export class WatchdogService {
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;

  constructor(
    public cwd: string,
    public sessionId: string,
    public config: WatchdogConfig = {},
    public steerSender?: SteerSender
  ) {}

  /**
   * Start periodic watchdog polling daemon (default: 5000ms).
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.config.pollIntervalMs ?? 5000;
    this.timer = setInterval(() => {
      this.tick();
    }, interval);
    this.timer.unref?.();
  }

  /**
   * Stop watchdog daemon and clear timer.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * Execute a single synchronous inspection pass:
   * 1. Inspect and reclaim stale leases
   * 2. Check all-dead conditions and trigger Steer fallback if unlatched
   */
  public tick(now: number = Date.now()): { reclaimed: ReclaimResult; allDead: AllDeadStatus } {
    const sessionId = activeRunId(this.cwd) || this.sessionId;
    const reclaimed = inspectAndReclaimStaleLeases(this.cwd, sessionId, now, this.config);
    const allDead = checkAllDead(this.cwd, sessionId);

    if (allDead.isAllDead && !allDead.fallbackTriggered) {
      triggerAllDeadFallback(this.cwd, sessionId, allDead, this.steerSender);
    }

    return { reclaimed, allDead };
  }

  /**
   * Reset idempotency latch for this session (and optional task).
   */
  public resetLatch(taskId?: string): void {
    resetFallbackLatch(this.sessionId, taskId);
  }
}
