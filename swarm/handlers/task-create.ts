import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import * as taskStore from '../task-store.js';
import { summaryLine } from './_utils.js';
import { getCircuitBreaker } from '../circuit-breaker/index.js';
import { finishedAlternativeRoot } from '../alternative.js';

export function taskCreate(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (getCircuitBreaker(cwd, sessionId).isTripped()) {
    return result('Error: Circuit breaker is tripped. Task creation is locked.', {
      mode: 'task.create',
      error: 'circuit_broken',
    });
  }

  if (!params.title) {
    return result('Error: title required for task.create', {
      mode: 'task.create',
      error: 'missing_title',
    });
  }

  const dependsOn = params.dependsOn ?? [];
  for (const depId of dependsOn) {
    if (!taskStore.getTask(cwd, sessionId, depId)) {
      return result(`Error: dependency ${depId} not found`, {
        mode: 'task.create',
        error: 'dependency_not_found',
        dependency: depId,
      });
    }
  }

  let alternativeOf: string | undefined;
  if (params.alternativeOf) {
    const target = taskStore
      .getAllTasks(cwd, sessionId)
      .find((task) => task.id === params.alternativeOf);
    if (!target) {
      return result(`Error: alternative ${params.alternativeOf} not found`, {
        mode: 'task.create',
        error: 'alternative_not_found',
        alternativeOf: params.alternativeOf,
      });
    }
    alternativeOf = target.alternative_of ?? target.id;
  }

  const created = taskStore.createTask(
    cwd,
    sessionId,
    {
      title: params.title,
      content: params.content,
      dependsOn,
      createdBy: state.agentName,
      channel: channelId,
      alternativeOf,
    },
    channelId
  );
  const tasks = taskStore.getAllTasks(cwd, sessionId);
  const fresh = tasks.find((task) => task.id === created.id) ?? created;
  // Joining a group that already has a Direct Verified Merge is terminal.
  if (finishedAlternativeRoot(fresh, tasks))
    taskStore.supersedeAlternativeLosers(cwd, sessionId, fresh.id);
  const task = taskStore.getTask(cwd, sessionId, fresh.id) ?? fresh;

  logFeedEvent(cwd, state.agentName, 'task.start', task.id, `created ${task.title}`, channelId);

  const deps = task.depends_on.length > 0 ? `\nDepends on: ${task.depends_on.join(', ')}` : '';

  return result(
    `✅ Created ${task.id}: ${task.title}${deps}\n\nClaim it:\n  pi-messenger-swarm task claim ${task.id}`,
    {
      mode: 'task.create',
      channel: normalizeChannelId(channelId),
      task,
    }
  );
}
