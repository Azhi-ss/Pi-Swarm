import { forceKillProcessGroup } from './process-manager.js';
import { getCircuitBreaker } from './circuit-breaker/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readRun, updateRun, endRun, type HandoffState } from './run-store.js';
import {
  listSpawned,
  spawnSubagent,
  reconcileSpawnedAgents,
  stopSpawn,
  reclaimSandbox,
  recordRetainedSandbox,
} from './spawn.js';
import { replayTasks, appendTaskEvent } from './task-store/events.js';
import { getAllTasks, getTaskSpec } from './task-store/queries.js';
import { writeBlackboard } from './task-store/blackboard.js';
import { listCandidates } from './candidates.js';
import { isProcessAlive } from '../lib.js';
import { messengerDirs } from '../project.js';
import { ensureSessionChannel } from '../channel.js';
import { criticalHeader, enqueueCritical } from './notifications.js';
import { generateAttributionBrief } from './watchdog/brief.js';
import { acceptanceEvidence, executeRun, readyForAcceptance } from './handlers/run.js';
import { claimableRejection, computeWidth, isDeferredAdmission } from './width.js';

/** A failed check reads external evidence the task log does not contain. */
const FAILED_ACCEPTANCE_RETRY_MS = 2_000;
/** Successor must claim after boot and one thinking turn, not within 30s of spawn. */
const CLAIM_GRACE_MS = 3 * 60 * 1000;
/** No tool call and no in-flight tool. A running evaluation is progress. */
const IDLE_MS = 10 * 60 * 1000;
const IDLE_REASON = 'Idle for 10 minutes with no tool call or task progress.';

/** Width, budget, and stopped-run refusals end the fill. A non-claimable task does not. */
function stopsFill(message: string): boolean {
  return (
    message.includes('Width Cap') ||
    message.includes('peer admission') ||
    message.includes('Circuit breaker is tripped') ||
    message.includes('no longer eligible')
  );
}

/**
 * After Automatic Handoff, start one peer per Open Demand task up to the Width Cap.
 * The caller does not hold the run lock. Each admission takes it once around spawnSubagent.
 */
function fillOpenDemand(cwd: string, runId: string): void {
  const run = readRun(cwd, runId);
  if (!run?.demandFill || run.status !== 'active') return;
  if (run.consumedSteps >= run.maxSteps) return;
  if (run.acceptanceOwner && isProcessAlive(run.acceptanceOwner)) return;
  for (const task of getAllTasks(cwd, runId)) {
    let stop = false;
    let suspendedNow = false;
    updateRun(cwd, runId, (current) => {
      if (!current.demandFill || current.status !== 'active') return void (stop = true);
      if (current.consumedSteps >= current.maxSteps) return void (stop = true);
      if (current.acceptanceOwner && isProcessAlive(current.acceptanceOwner))
        return void (stop = true);
      const width = computeWidth(cwd, current);
      if (width.live >= width.cap) return void (stop = true);
      // A bound peer, including one awaiting Automatic Handoff, is not Open Demand.
      if (
        listSpawned(cwd, runId, true).some((peer) => peer.taskId === task.id && !peer.stopRequested)
      )
        return;
      if (claimableRejection(cwd, current, task.id)) return;
      const handoff: HandoffState = (current.handoffs[task.id] ||= { failures: 0, errors: [] });
      if (handoff.suspended) return;
      const spec = getTaskSpec(cwd, runId, task.id);
      try {
        const peer = spawnSubagent(
          cwd,
          {
            role: task.title,
            objective: spec?.trim() || task.title,
            taskId: task.id,
          },
          runId,
          ensureSessionChannel(messengerDirs(cwd), runId).id
        );
        handoff.successor = peer.id;
        handoff.startedAt = peer.startedAt;
        handoff.takenOver = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isDeferredAdmission(message)) {
          if (stopsFill(message)) stop = true;
          return;
        }
        handoff.failures++;
        handoff.errors.push(message);
        if (handoff.failures >= 3) {
          handoff.suspended = true;
          suspendedNow = true;
        }
      }
    });
    // No peer record exists, so the handoff loop will not see this suspension.
    // Notify outside the run lock; enqueueCritical takes it itself.
    if (suspendedNow) {
      const current = readRun(cwd, runId);
      const handoff = current?.handoffs[task.id];
      if (current && handoff?.suspended)
        notify(
          cwd,
          runId,
          current.delegator,
          `suspended-${task.id}-${handoff.errors.length}`,
          `Automatic Handoff suspended for ${task.id} after three startup/takeover failures. Verification attempts unchanged.\n${handoff.errors.join('\n')}\nRepair the environment and use handoff resume ${task.id}.`,
          task.id
        );
    }
    if (stop) return;
  }
}

function notify(cwd: string, runId: string, to: string, id: string, text: string, taskId?: string) {
  enqueueCritical(
    cwd,
    runId,
    {
      id,
      from: 'watchdog',
      to,
      text: criticalHeader(cwd, runId, to, id, taskId) + text,
      timestamp: new Date().toISOString(),
      replyTo: null,
    },
    taskId
  );
}

export function recordTakeover(cwd: string, runId: string, taskId: string, peerName: string): void {
  const run = readRun(cwd);
  if (!run || run.id !== runId || !run.handoffs[taskId]) return;
  const peer = listSpawned(cwd, runId).find((p) => p.name === peerName);
  if (!peer || run.handoffs[taskId].successor !== peer.id) return;
  updateRun(cwd, runId, (current) => {
    const handoff = current.handoffs[taskId];
    handoff.takenOver = true;
    handoff.failures = 0;
  });
}

/** One service tick. Filesystem admission serializes independent daemons too. */
export function recoverRun(cwd: string): void {
  // A Pi host can trip the persisted budget from another process. Finish its
  // project-scoped physical shutdown even after the active pointer was cleared.
  const history = path.join(cwd, '.pi/messenger/run-history');
  if (fs.existsSync(history))
    for (const file of fs.readdirSync(history).filter((f) => f.endsWith('.json'))) {
      const ended = readRun(cwd, file.slice(0, -5))!;
      if (ended.status === 'active') continue;
      if (ended.acceptancePid)
        updateRun(cwd, ended.id, (current) => {
          if (current.acceptancePid) forceKillProcessGroup(current.acceptancePid);
          delete current.acceptancePid;
          delete current.acceptanceOwner;
        });
      for (const peer of listSpawned(cwd, ended.id)) stopSpawn(cwd, peer.id);
    }
  const run = readRun(cwd);
  if (!run) return;
  if (run.acceptanceOwner && !isProcessAlive(run.acceptanceOwner))
    updateRun(cwd, run.id, (current) => {
      if (current.acceptanceOwner && !isProcessAlive(current.acceptanceOwner)) {
        if (current.acceptancePid) forceKillProcessGroup(current.acceptancePid);
        delete current.acceptancePid;
        delete current.acceptanceOwner;
      }
    });
  if (run.status !== 'active') {
    endRun(cwd, run.id, run.status);
    return;
  }
  if (run.consumedSteps >= run.maxSteps) {
    void getCircuitBreaker(cwd, run.id).triggerAbort(
      cwd,
      run.id,
      `Global step budget exceeded (${run.consumedSteps}/${run.maxSteps} steps)`
    );
    return;
  }
  reconcileSpawnedAgents(cwd, run.id);
  let peers = listSpawned(cwd, run.id, true);
  const live = (peer: (typeof peers)[number]) =>
    peer.status === 'running' && !!peer.pid && isProcessAlive(peer.pid);
  const retained = new Set<string>();
  for (const peer of peers) {
    if (live(peer) || peer.stopRequested || !peer.worktreePath || !fs.existsSync(peer.worktreePath))
      continue;
    const failure = reclaimSandbox(cwd, peer.id, peer);
    if (!failure) continue;
    // The Sandbox is retained and only this peer's task waits for repair.
    if (peer.taskId) retained.add(peer.taskId);
    if (!peer.sandboxRetained) recordRetainedSandbox(cwd, run.id, peer.id, failure);
  }
  const tasks = replayTasks(cwd, run.id);
  for (const task of tasks) {
    if (!['todo', 'staked', 'in_progress'].includes(task.status) || retained.has(task.id)) continue;
    const bound = peers.filter((p) => p.taskId === task.id);
    const latest = bound.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!latest || latest.stopRequested) continue;
    const currentHandoff = readRun(cwd, run.id)!.handoffs[task.id];
    if (currentHandoff?.suspended) {
      notify(
        cwd,
        run.id,
        run.delegator,
        `suspended-${task.id}-${currentHandoff.errors.length}`,
        `Automatic Handoff suspended for ${task.id} after three startup/takeover failures. Verification attempts unchanged.\n${currentHandoff.errors.join('\n')}\nRepair the environment and use handoff resume ${task.id}.`,
        task.id
      );
      continue;
    }
    if (live(latest)) {
      // A successor must actually claim work within the startup window.
      if (
        currentHandoff?.successor === latest.id &&
        !currentHandoff.takenOver &&
        Date.now() - Date.parse(latest.startedAt) > CLAIM_GRACE_MS
      ) {
        stopSpawn(cwd, latest.id, true);
        updateRun(cwd, run.id, (r) => {
          const handoff = (r.handoffs[task.id] ||= { failures: 0, errors: [] });
          if (handoff.errors.some((error) => error.startsWith('Takeover timed out:'))) return;
          handoff.failures++;
          handoff.errors.push('Takeover timed out: peer did not claim the task within 3 minutes.');
        });
      } else if (
        currentHandoff?.takenOver &&
        !latest.toolBusy &&
        Date.now() - Date.parse(latest.lastActiveAt || latest.startedAt) > IDLE_MS
      ) {
        stopSpawn(cwd, latest.id, true, IDLE_REASON);
      }
      continue;
    }
    if (task.claimed_by && task.claimed_by !== latest.name) {
      const owner = peers.find((p) => p.name === task.claimed_by);
      if (owner && live(owner)) continue;
      try {
        const registered = JSON.parse(
          fs.readFileSync(path.join(messengerDirs(cwd).registry, `${task.claimed_by}.json`), 'utf8')
        );
        if (registered.pid && isProcessAlive(registered.pid)) continue;
      } catch {
        /* Honor an unexpired lease when ownership cannot be disproved. */
      }
      if (task.lease_expires_at && Date.parse(task.lease_expires_at) > Date.now()) continue;
    }
    updateRun(cwd, run.id, (current) => {
      if (current.status !== 'active' || current.consumedSteps >= current.maxSteps) return;
      const h: HandoffState = (current.handoffs[task.id] ||= { failures: 0, errors: [] });
      if (h.suspended) return;
      const currentTask = replayTasks(cwd, run.id).find((t) => t.id === task.id);
      if (
        !currentTask ||
        currentTask.status !== task.status ||
        currentTask.claimed_by !== task.claimed_by
      )
        return;
      // Reload under admission lock: another service may already have spawned.
      const existing = listSpawned(cwd, run.id, true).filter((p) => p.taskId === task.id);
      if (existing.some(live)) return;
      if (h.predecessor !== latest.id && latest.error?.startsWith('Idle for 10 minutes')) {
        h.failures++;
        h.errors.push(latest.error);
      }
      if (h.successor === latest.id && !h.takenOver && h.predecessor !== latest.id) {
        h.failures++;
        h.errors.push(
          latest.error ||
            `Peer ${latest.id} exited before claiming the task (exit ${latest.exitCode ?? 'unknown'}).`
        );
      }
      h.predecessor = latest.id;
      if (h.failures >= 3) {
        h.suspended = true;
        return;
      }
      const width = computeWidth(cwd, current);
      if (width.live >= width.cap) return;
      if (current.acceptanceOwner && isProcessAlive(current.acceptanceOwner)) return;
      if (task.claimed_by)
        appendTaskEvent(cwd, run.id, {
          taskId: task.id,
          type: 'released',
          agent: task.claimed_by,
          timestamp: new Date().toISOString(),
        });
      // Same Claimable Task gate as an explicit spawn. Not a takeover failure.
      if (claimableRejection(cwd, current, task.id)) return;
      const candidates = listCandidates(cwd, run.id).filter((c) => c.taskId === task.id);
      const context = `Automatic Handoff for ${task.id}. Original goal: ${current.goal}. Remaining budget: ${current.maxSteps - current.consumedSteps}. Verification history: ${JSON.stringify(task.last_verification_failure || null)}. Unverified Handoff Candidates: ${JSON.stringify(candidates)}. Use candidate show, then selectively restore in your own Sandbox; normal verification is mandatory.`;
      try {
        const peer = spawnSubagent(
          cwd,
          {
            role: latest.role,
            model: latest.model,
            persona: latest.persona,
            objective: latest.objective,
            taskId: task.id,
            context,
          },
          run.id,
          ensureSessionChannel(messengerDirs(cwd), run.id).id
        );
        h.successor = peer.id;
        h.startedAt = peer.startedAt;
        h.takenOver = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isDeferredAdmission(message)) return;
        h.failures++;
        h.errors.push(String(error));
        if (h.failures >= 3) h.suspended = true;
      }
    });
    peers = listSpawned(cwd, run.id, true);
  }
  // Handoff owns a freed slot before any new task is admitted.
  fillOpenDemand(cwd, run.id);
  peers = listSpawned(cwd, run.id, true);
  const remaining = peers.filter(live);
  if (
    !remaining.length &&
    tasks.length &&
    tasks.every((t) =>
      ['dead_end', 'done', 'verified', 'archived', 'superseded'].includes(t.status)
    ) &&
    tasks.some((t) => t.status === 'dead_end')
  ) {
    notify(
      cwd,
      run.id,
      run.delegator,
      `all-dead-${run.id}-${tasks
        .filter((t) => t.status === 'dead_end')
        .map((t) => t.id)
        .join('-')}`,
      generateAttributionBrief(
        cwd,
        run.id,
        tasks.filter((t) => t.status === 'dead_end').map((t) => t.id)
      ),
      tasks.find((t) => t.status === 'dead_end')?.id
    );
  }
  writeBlackboard(cwd, run.id);
  const current = readRun(cwd, run.id);
  if (
    current?.status === 'active' &&
    !remaining.length &&
    current.acceptanceCommand &&
    (!current.acceptanceOwner || !isProcessAlive(current.acceptanceOwner))
  ) {
    const acceptanceTasks = getAllTasks(cwd, current.id);
    if (readyForAcceptance(acceptanceTasks)) {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
      const snapshot = acceptanceEvidence(cwd, current.id, head);
      const previous = current.acceptance;
      const sameSnapshot = previous?.snapshot === snapshot;
      const retryFailure =
        sameSnapshot &&
        previous.exitCode !== 0 &&
        Date.now() - Date.parse(previous.checkedAt) >= FAILED_ACCEPTANCE_RETRY_MS;
      if (!sameSnapshot || retryFailure)
        void executeRun(cwd, current.delegator, 'accept', {}).catch(() => {
          /* Evidence is persisted; remains visibly incomplete. */
        });
    }
  }
}
