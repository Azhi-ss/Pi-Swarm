import type { SwarmTask, SwarmTaskCreateInput, SwarmTaskEvidence } from '../types.js';
import type {
  CreatedPayload,
  ClaimedPayload,
  StakedPayload,
  RenewedPayload,
  ProgressPayload,
  CompletedPayload,
  VerifiedPayload,
  VerificationFailedPayload,
  DeadEndPayload,
  BlockedPayload,
  ProposedPayload,
  ChallengedPayload,
  SupersededPayload,
} from './types.js';
import { appendTaskEvent, replayAllTasks } from './events.js';
import { taskSpecPath, writeTaskSpec, deleteTaskSpec } from './persistence.js';
import { getTasks, getAllTasks, getTask, taskExists, isLeaseExpired } from './queries.js';
import { normalizeChannelId } from '../../channel.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCircuitBreaker } from '../circuit-breaker/index.js';
import {
  alternativeRoot,
  finishedAlternativeRoot,
  groupMembers,
  inAlternativeGroup,
  isTerminalStatus,
} from '../alternative.js';

function allocateTaskId(cwd: string, sessionId: string): string {
  const allTasks = getAllTasks(cwd, sessionId);
  const maxId = allTasks.reduce((max, t) => {
    const match = t.id.match(/(\d+)$/);
    const num = match ? Number.parseInt(match[1], 10) : 0;
    return Math.max(max, num);
  }, 0);
  return `task-${maxId + 1}`;
}

export function createTask(
  cwd: string,
  sessionId: string,
  input: SwarmTaskCreateInput,
  channelId: string
): SwarmTask {
  if (getCircuitBreaker(cwd, sessionId).isTripped()) {
    throw new Error('Circuit breaker is tripped: swarm mutations locked');
  }
  const normalizedChannel = normalizeChannelId(channelId);
  const id = allocateTaskId(cwd, sessionId);
  const now = new Date().toISOString();

  // Append creation event
  appendTaskEvent(cwd, sessionId, {
    taskId: id,
    type: 'created',
    timestamp: now,
    channel: normalizedChannel,
    payload: {
      title: input.title,
      content: input.content,
      dependsOn: input.dependsOn,
      createdBy: input.createdBy,
      verifyCommand: input.verifyCommand,
      alternativeOf: input.alternativeOf,
    } as CreatedPayload,
  });

  // Write spec file separately
  writeTaskSpec(cwd, sessionId, id, input.title, input.content);

  // Return the task as it now exists
  const tasks = getTasks(cwd, sessionId);
  return tasks.find((t) => t.id === id)!;
}

export function claimTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  reason?: string
): SwarmTask | null {
  if (getCircuitBreaker(cwd, sessionId).isTripped()) {
    return null;
  }
  let task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  // Check dependencies: must be satisfied by 'done' or 'verified'
  const allTasks = getTasks(cwd, sessionId);
  const doneIds = new Set(
    allTasks.filter((t) => t.status === 'done' || t.status === 'verified').map((t) => t.id)
  );
  const unmetDeps = task.depends_on.filter((dep) => !doneIds.has(dep));
  if (unmetDeps.length > 0) return null;
  if (finishedAlternativeRoot(task, allTasks)) return null;

  // If claimed/staked, check if lease is expired for opportunistic preemption
  if (task.status === 'in_progress' || task.status === 'staked') {
    if (isLeaseExpired(task)) {
      appendTaskEvent(cwd, sessionId, {
        taskId,
        type: 'released',
        timestamp: new Date().toISOString(),
        agent: task.claimed_by,
      });
      task = getTask(cwd, sessionId, taskId);
    } else {
      return null;
    }
  }

  if (!task || task.status !== 'todo') return null;

  // Append claim event
  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'claimed',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { reason } as ClaimedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function stakeTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  options?: { ttl?: number; proposalId?: string; reason?: string }
): SwarmTask | null {
  if (getCircuitBreaker(cwd, sessionId).isTripped()) {
    return null;
  }
  let task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  // Check dependencies: must be satisfied by 'done' or 'verified'
  const allTasks = getTasks(cwd, sessionId);
  const doneIds = new Set(
    allTasks.filter((t) => t.status === 'done' || t.status === 'verified').map((t) => t.id)
  );
  const unmetDeps = task.depends_on.filter((dep) => !doneIds.has(dep));
  if (unmetDeps.length > 0) return null;
  if (finishedAlternativeRoot(task, allTasks)) return null;

  // If already claimed/staked, check if lease is expired for opportunistic preemption
  if (task.status === 'staked' || task.status === 'in_progress') {
    if (isLeaseExpired(task)) {
      appendTaskEvent(cwd, sessionId, {
        taskId,
        type: 'released',
        timestamp: new Date().toISOString(),
        agent: task.claimed_by,
      });
      task = getTask(cwd, sessionId, taskId);
    } else {
      return null;
    }
  }

  if (!task || (task.status !== 'todo' && task.status !== 'staked')) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'staked',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: {
      ttl: options?.ttl ?? 300,
      proposalId: options?.proposalId,
      reason: options?.reason,
    } as StakedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function renewTaskLease(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  ttl?: number
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;
  if (task.status !== 'staked' && task.status !== 'in_progress') return null;
  if (task.claimed_by !== agentName) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'renewed',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { ttl } as RenewedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function unclaimTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;
  if (task.status !== 'in_progress' && task.status !== 'staked') return null;
  if (task.claimed_by !== agentName) return null;

  // Append release event
  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'released',
    timestamp: new Date().toISOString(),
    agent: agentName,
  });

  return getTask(cwd, sessionId, taskId);
}

export function blockTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  reason: string
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'blocked',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { reason, blockedBy: agentName } as BlockedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function unblockTask(cwd: string, sessionId: string, taskId: string): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'unblocked',
    timestamp: new Date().toISOString(),
  });

  return getTask(cwd, sessionId, taskId);
}

export function completeTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  summary: string,
  evidence?: SwarmTaskEvidence
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;
  if (task.status !== 'in_progress' && task.status !== 'staked') return null;
  if (task.claimed_by !== agentName) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'completed',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { summary, evidence } as CompletedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function verifyTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  payload: VerifiedPayload
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;
  if (task.status !== 'in_progress' && task.status !== 'staked') return null;
  if (task.claimed_by !== agentName) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'verified',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function recordVerificationFailed(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  payload: VerificationFailedPayload
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'verification_failed',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function deadEndTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  payload: DeadEndPayload
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'dead_end',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function resetTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  cascade: boolean = false
): SwarmTask[] {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return [];

  const resetTasks: SwarmTask[] = [];

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'reset',
    timestamp: new Date().toISOString(),
  });
  resetTasks.push(getTask(cwd, sessionId, taskId)!);

  if (cascade) {
    const allTasks = getAllTasks(cwd, sessionId);
    const doneIds = new Set(
      allTasks.filter((t) => t.status === 'done' || t.status === 'verified').map((t) => t.id)
    );

    // Find all tasks that depend on this one (directly or transitively)
    const toReset = new Set<string>();
    const findDependents = (parentId: string) => {
      for (const t of allTasks) {
        if (t.depends_on.includes(parentId) && doneIds.has(t.id)) {
          toReset.add(t.id);
          findDependents(t.id);
        }
      }
    };
    findDependents(taskId);

    for (const dependentId of toReset) {
      appendTaskEvent(cwd, sessionId, {
        taskId: dependentId,
        type: 'reset',
        timestamp: new Date().toISOString(),
      });
      const resetTask = getTask(cwd, sessionId, dependentId);
      if (resetTask) resetTasks.push(resetTask);
    }
  }

  return resetTasks;
}

export function archiveTask(cwd: string, sessionId: string, taskId: string): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'archived',
    timestamp: new Date().toISOString(),
  });

  // Use replayAllTasks to get the archived task
  return replayAllTasks(cwd, sessionId).find((t) => t.id === taskId) ?? null;
}

export function archiveDoneTasks(cwd: string, sessionId: string): number {
  const doneTasks = getTasks(cwd, sessionId).filter(
    (t) => t.status === 'done' || t.status === 'verified'
  );
  for (const task of doneTasks) {
    archiveTask(cwd, sessionId, task.id);
  }
  return doneTasks.length;
}

export function deleteTask(cwd: string, sessionId: string, taskId: string): boolean {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return false;

  // Remove spec file
  deleteTaskSpec(cwd, sessionId, taskId);

  // Archive to mark as deleted
  archiveTask(cwd, sessionId, taskId);

  return true;
}

export function appendTaskProgress(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  message: string
): void {
  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'progress',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { message } as ProgressPayload,
  });
}

export function proposeTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  proposal: string
): SwarmTask | null {
  if (getCircuitBreaker(cwd, sessionId).isTripped()) {
    return null;
  }
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'proposed',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { proposal, author: agentName } as ProposedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function challengeTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  objection: string,
  targetClaimant?: string
): SwarmTask | null {
  if (getCircuitBreaker(cwd, sessionId).isTripped()) {
    return null;
  }
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'challenged',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: {
      objection,
      challenger: agentName,
      targetClaimant: targetClaimant ?? task.claimed_by,
    } as ChallengedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

/**
 * After a Direct Verified Merge, mark every other non-terminal member Superseded.
 * Returns their task ids so the caller can stop peers outside the run lock.
 * If another member already won, this task is Superseded instead and `won` is false.
 */
export function supersedeAlternativeLosers(
  cwd: string,
  sessionId: string,
  winnerId: string
): { won: boolean; stopTaskIds: string[] } {
  const tasks = getAllTasks(cwd, sessionId);
  const winner = tasks.find((task) => task.id === winnerId);
  if (!winner || !inAlternativeGroup(winner, tasks)) return { won: true, stopTaskIds: [] };
  const root = alternativeRoot(winner, tasks);
  const members = groupMembers(tasks, root);
  const prior = members.find(
    (member) =>
      member.id !== winnerId && member.status === 'verified' && member.verification?.exitCode === 0
  );
  if (prior) {
    supersedeMember(cwd, sessionId, winner, prior.id, root);
    return { won: false, stopTaskIds: [] };
  }
  const stopTaskIds: string[] = [];
  for (const member of members) {
    if (member.id === winnerId || isTerminalStatus(member.status)) continue;
    supersedeMember(cwd, sessionId, member, winnerId, root);
    stopTaskIds.push(member.id);
  }
  return { won: true, stopTaskIds };
}

function supersedeMember(
  cwd: string,
  sessionId: string,
  task: SwarmTask,
  winnerId: string,
  rootId: string
): void {
  if (isTerminalStatus(task.status)) return;
  appendTaskEvent(cwd, sessionId, {
    taskId: task.id,
    type: 'superseded',
    timestamp: new Date().toISOString(),
    agent: task.claimed_by,
    payload: { rootId, winnerId } as SupersededPayload,
  });
}
