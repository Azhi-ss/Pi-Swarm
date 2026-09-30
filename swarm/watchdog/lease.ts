import { messengerDirs, peerBelongsToProject } from '../../project.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SwarmTask } from '../types.js';
import type { WatchdogConfig, ReclaimResult } from './types.js';
import { replayTasks, appendTaskEvent } from '../task-store/events.js';
import { writeBlackboard } from '../task-store/blackboard.js';
import { isLeaseExpired } from '../task-store/queries.js';
import { logFeedEvent } from '../../feed/index.js';
import { isProcessAlive } from '../../lib.js';
import { processManager } from '../process-manager.js';
import { loadSpawnedAgents } from '../spawn.js';

/**
 * Check if the claiming worker process for a task is confirmed dead.
 */
function isWorkerDead(cwd: string, sessionId: string, claimant: string): boolean {
  // Only this Project and run count. A live peer in another Project must not keep the lease.
  const local = processManager.list(true).filter((worker) => {
    if (!peerBelongsToProject(cwd, worker.cwd)) return false;
    if (worker.runId && worker.runId !== sessionId) return false;
    return (
      worker.agentName === claimant ||
      worker.id === claimant ||
      worker.name === claimant ||
      worker.name === `[Swarm] worker-${claimant}`
    );
  });
  if (local.length) {
    return local.every((worker) => {
      if (worker.status === 'failed' || worker.status === 'timeout' || worker.status === 'stopped')
        return true;
      if (worker.pid && !isProcessAlive(worker.pid)) return true;
      return false;
    });
  }

  // 2. Check spawned agent event logs
  const spawned = loadSpawnedAgents(cwd, sessionId);
  const matchedSpawn = spawned.find(
    (a) =>
      a.name === claimant || a.id === claimant || a.name === claimant.replace(/^\[Swarm\]\s*/, '')
  );
  if (matchedSpawn) {
    if (matchedSpawn.status === 'failed' || matchedSpawn.status === 'stopped') {
      return true;
    }
    if (matchedSpawn.pid && !isProcessAlive(matchedSpawn.pid)) {
      return true;
    }
  }

  // 3. Check messenger registry
  const regPath = path.join(messengerDirs(cwd).registry, `${claimant}.json`);
  if (fs.existsSync(regPath)) {
    try {
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
      if (reg.pid && !isProcessAlive(reg.pid)) {
        return true;
      }
    } catch {
      // Malformed registry JSON
    }
  } else {
    // If registry folder exists and has other registrations, this agent departed
    const registryDir = messengerDirs(cwd).registry;
    if (fs.existsSync(registryDir)) {
      try {
        const others = fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
        if (others.length > 0) {
          return true;
        }
      } catch {}
    }
  }

  return false;
}

/**
 * Scan active tasks in 'staked' or 'in_progress' and reclaim leases if expired or worker dead.
 * Emits 'released' event and immediately refreshes BLACKBOARD.md.
 */
export function inspectAndReclaimStaleLeases(
  cwd: string,
  sessionId: string,
  now: number = Date.now(),
  _config?: WatchdogConfig
): ReclaimResult {
  const tasks = replayTasks(cwd, sessionId);
  let reclaimedCount = 0;
  const reclaimedTasks: string[] = [];

  for (const task of tasks) {
    if ((task.status !== 'in_progress' && task.status !== 'staked') || !task.claimed_by) {
      continue;
    }

    const expired = isLeaseExpired(task, now);
    const dead = isWorkerDead(cwd, sessionId, task.claimed_by);

    if (expired || dead) {
      const reason = expired
        ? 'lease expired - task auto-released'
        : 'agent crashed/dead - task auto-unclaimed';

      appendTaskEvent(cwd, sessionId, {
        taskId: task.id,
        type: 'released',
        timestamp: new Date(now).toISOString(),
        agent: task.claimed_by,
      });

      logFeedEvent(cwd, task.claimed_by, 'task.reset', task.id, reason, task.channel ?? 'unknown');

      reclaimedTasks.push(task.id);
      reclaimedCount++;
    }
  }

  // Synchronize blackboard projection immediately
  if (reclaimedCount > 0) {
    try {
      writeBlackboard(cwd, sessionId);
    } catch {
      // Ignore blackboard write errors in tests
    }
  }

  return { reclaimedCount, reclaimedTasks };
}
