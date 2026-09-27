import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState, AgentMailMessage } from '../../lib.js';
import { normalizeChannelId } from '../../channel.js';
import { logFeedEvent } from '../../feed/index.js';
import { result } from '../result.js';
import * as taskStore from '../task-store.js';
import { proposeTask, challengeTask } from '../task-store/commands.js';
import { taskCreate } from './task-create.js';
import { taskList, taskShow, taskReady, taskStalled, taskBlackboard } from './task-query.js';
import { taskClaim, taskStake, taskUnclaim, taskDone, taskReset } from './task-lifecycle.js';
import { taskBlock, taskUnblock } from './task-block.js';
import { taskDelete, taskArchiveDone } from './task-archive.js';
import { taskProgress } from './task-progress.js';

export function taskPropose(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  const taskId = params.id ?? params.taskId;
  if (!taskId) {
    return result('Error: id or taskId required for task.propose', {
      mode: 'task.propose',
      error: 'missing_id',
    });
  }

  const proposal =
    ((params as Record<string, unknown>).proposal as string | undefined) ??
    params.content ??
    params.message;
  if (!proposal || !proposal.trim()) {
    return result('Error: content required for task.propose', {
      mode: 'task.propose',
      error: 'missing_content',
    });
  }

  const existing = taskStore.getTask(cwd, sessionId, taskId);
  if (!existing) {
    return result(`Error: task ${taskId} not found`, {
      mode: 'task.propose',
      error: 'not_found',
      id: taskId,
    });
  }

  const trimmed = proposal.trim();
  const updated = proposeTask(cwd, sessionId, taskId, state.agentName, trimmed);
  logFeedEvent(cwd, state.agentName, 'task.propose', taskId, trimmed, channelId);

  return result(`Proposal submitted for ${taskId}.`, {
    mode: 'task.propose',
    channel: normalizeChannelId(channelId),
    id: taskId,
    proposal: trimmed,
    proposals: updated?.proposals,
  });
}

export function taskChallenge(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  const taskId = params.id ?? params.taskId;
  if (!taskId) {
    return result('Error: id or taskId required for task.challenge', {
      mode: 'task.challenge',
      error: 'missing_id',
    });
  }

  const reason =
    ((params as Record<string, unknown>).challenge as string | undefined) ??
    params.reason ??
    params.content ??
    params.message;
  if (!reason || !reason.trim()) {
    return result('Error: reason/challenge required for task.challenge', {
      mode: 'task.challenge',
      error: 'missing_reason',
    });
  }

  const existing = taskStore.getTask(cwd, sessionId, taskId);
  if (!existing) {
    return result(`Error: task ${taskId} not found`, {
      mode: 'task.challenge',
      error: 'not_found',
      id: taskId,
    });
  }

  const trimmed = reason.trim();
  const updated = challengeTask(
    cwd,
    sessionId,
    taskId,
    state.agentName,
    trimmed,
    existing.claimed_by
  );
  logFeedEvent(cwd, state.agentName, 'task.challenge', taskId, trimmed, channelId);

  return result(`Challenge recorded for ${taskId}.`, {
    mode: 'task.challenge',
    channel: normalizeChannelId(channelId),
    id: taskId,
    objection: trimmed,
    targetClaimant: existing.claimed_by,
    challenges: updated?.challenges,
  });
}

export function executeTask(
  op: string,
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string,
  deliverMessage?: (msg: AgentMailMessage) => void
) {
  switch (op) {
    case 'create':
      return taskCreate(params, state, cwd, channelId, sessionId);
    case 'list':
      return taskList(cwd, channelId, sessionId);
    case 'show':
      return taskShow(params, cwd, channelId, sessionId);
    case 'start':
    case 'claim':
      return taskClaim(params, state, cwd, channelId, sessionId);
    case 'stake':
      return taskStake(params, state, cwd, channelId, sessionId);
    case 'unclaim':
    case 'stop':
      return taskUnclaim(params, state, cwd, channelId, sessionId);
    case 'done':
      return taskDone(params, state, cwd, channelId, sessionId, deliverMessage);
    case 'block':
      return taskBlock(params, state, cwd, channelId, sessionId);
    case 'unblock':
      return taskUnblock(params, state, cwd, channelId, sessionId);
    case 'ready':
      return taskReady(cwd, channelId, sessionId);
    case 'stalled':
      return taskStalled(cwd, channelId, sessionId);
    case 'progress':
      return taskProgress(params, state, cwd, channelId, sessionId);
    case 'reset':
      return taskReset(params, state, cwd, channelId, sessionId);
    case 'delete':
      return taskDelete(params, state, cwd, channelId, sessionId);
    case 'archive_done':
      return taskArchiveDone(state, cwd, channelId, sessionId);
    case 'propose':
      return taskPropose(params, state, cwd, channelId, sessionId);
    case 'challenge':
      return taskChallenge(params, state, cwd, channelId, sessionId);
    case 'blackboard':
      return taskBlackboard(cwd, sessionId);
    default:
      return result(`Unknown task operation: ${op}`, {
        mode: 'task',
        error: 'unknown_operation',
        operation: op,
      });
  }
}
