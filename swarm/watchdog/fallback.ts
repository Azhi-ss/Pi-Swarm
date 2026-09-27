import type { SwarmTask } from '../types.js';
import type { AllDeadStatus, SteerSender } from './types.js';
import { replayTasks } from '../task-store/events.js';
import { getRunningSpawnCount } from '../spawn.js';
import { processManager } from '../process-manager.js';
import { generateAttributionBrief } from './brief.js';
import { logFeedEvent } from '../../feed/index.js';

// Idempotency latches to prevent multiple steer wakeup events for the same incident
const fallbackLatches = new Set<string>();

function getLatchKey(sessionId: string, taskId?: string): string {
  return `${sessionId}:${taskId ?? '__all__'}`;
}

export function isFallbackLatched(sessionId: string, taskId?: string): boolean {
  if (taskId) {
    return (
      fallbackLatches.has(getLatchKey(sessionId, taskId)) ||
      fallbackLatches.has(getLatchKey(sessionId, '__all__'))
    );
  }
  if (fallbackLatches.has(getLatchKey(sessionId, '__all__'))) {
    return true;
  }
  for (const key of fallbackLatches) {
    if (key.startsWith(`${sessionId}:`)) return true;
  }
  return false;
}

export function resetFallbackLatch(sessionId?: string, taskId?: string): void {
  if (!sessionId) {
    fallbackLatches.clear();
    return;
  }
  if (taskId) {
    fallbackLatches.delete(getLatchKey(sessionId, taskId));
    fallbackLatches.delete(getLatchKey(sessionId, '__all__'));
  } else {
    for (const key of Array.from(fallbackLatches)) {
      if (key.startsWith(`${sessionId}:`)) {
        fallbackLatches.delete(key);
      }
    }
  }
}

/**
 * Check if all hypotheses under a task or across the session have failed (dead_end)
 * and no active workers or todo tasks remain.
 */
export function checkAllDead(cwd: string, sessionId: string, targetTaskId?: string): AllDeadStatus {
  const allTasks = replayTasks(cwd, sessionId);
  const runningSpawn = getRunningSpawnCount(cwd);
  const runningManaged = processManager.list().length;
  const runningWorkerCount = Math.max(runningSpawn, runningManaged);

  if (targetTaskId) {
    const task = allTasks.find((t) => t.id === targetTaskId);
    if (!task) {
      return {
        isAllDead: false,
        deadEndTasks: [],
        runningWorkerCount,
        fallbackTriggered: false,
      };
    }

    const isAllDead = task.status === 'dead_end' && runningWorkerCount === 0;
    const latched = isFallbackLatched(sessionId, targetTaskId);

    return {
      isAllDead,
      deadEndTasks: isAllDead ? [task] : [],
      runningWorkerCount,
      fallbackTriggered: latched,
    };
  }

  // Across session
  const deadEndTasks = allTasks.filter((t) => t.status === 'dead_end');
  const todoTasks = allTasks.filter((t) => t.status === 'todo');
  const activeTasks = allTasks.filter((t) => t.status === 'staked' || t.status === 'in_progress');

  const isAllDead =
    deadEndTasks.length > 0 &&
    todoTasks.length === 0 &&
    activeTasks.length === 0 &&
    runningWorkerCount === 0;

  const latched = isFallbackLatched(sessionId);

  return {
    isAllDead,
    deadEndTasks: isAllDead ? deadEndTasks : [],
    runningWorkerCount,
    fallbackTriggered: latched,
  };
}

/**
 * Trigger the All-Dead Steer wakeup protocol if all-dead state is detected and unlatched.
 */
export function triggerAllDeadFallback(
  cwd: string,
  sessionId: string,
  status: AllDeadStatus,
  steerSender?: SteerSender
): boolean {
  if (!status.isAllDead) return false;

  const targetTaskId = status.deadEndTasks.length === 1 ? status.deadEndTasks[0].id : undefined;
  if (isFallbackLatched(sessionId, targetTaskId)) {
    return false;
  }

  // Engage latch
  fallbackLatches.add(getLatchKey(sessionId, targetTaskId));

  // Generate Attribution Brief
  const briefMarkdown = generateAttributionBrief(
    cwd,
    sessionId,
    status.deadEndTasks.map((t) => t.id)
  );
  status.briefMarkdown = briefMarkdown;

  // Log feed event
  const primaryTask = status.deadEndTasks[0];
  logFeedEvent(
    cwd,
    'watchdog',
    'task.dead_end',
    primaryTask?.id,
    '🛑 [ALL-DEAD] All hypotheses failed. Main agent awakened with Attribution Brief.',
    primaryTask?.channel ?? 'unknown'
  );

  // Dispatch Steer message if callback provided
  if (steerSender) {
    try {
      void steerSender({
        customType: 'all_dead_fallback',
        content: briefMarkdown,
        display: true,
        details: {
          event: 'all_dead',
          taskId: primaryTask?.id,
          taskIds: status.deadEndTasks.map((t) => t.id),
        },
      });
    } catch {}
  }

  status.fallbackTriggered = true;
  return true;
}
