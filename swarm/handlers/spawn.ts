import * as fs from 'node:fs';
import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import * as taskStore from '../task-store.js';
import {
  cleanupExitedSpawned,
  listSpawned,
  listSpawnedHistory,
  reconcileSpawnedAgents,
  spawnSubagent,
  stopSpawn,
} from '../spawn.js';
import type { SpawnRequest } from '../types.js';
import { formatRoleLabel } from '../labels.js';
import { getCircuitBreaker } from '../circuit-breaker/index.js';
import { isProcessAlive } from '../../lib.js';
import { readRun, withRunLock } from '../run-store.js';
import { computeWidth, widthFullMessage } from '../width.js';

export function executeSpawn(
  op: string | null,
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string
) {
  cleanupExitedSpawned(cwd, sessionId);
  reconcileSpawnedAgents(cwd, sessionId);

  if (!op) {
    return spawnCreate(params, state, cwd, sessionId);
  }

  if (op === 'list') {
    return spawnList(cwd, sessionId);
  }

  if (op === 'history') {
    return spawnHistory(cwd, sessionId);
  }

  if (op === 'stop') {
    return spawnStop(params, cwd);
  }

  return result(`Unknown spawn operation: ${op}`, {
    mode: 'spawn',
    error: 'unknown_operation',
    operation: op,
  });
}

function spawnList(cwd: string, sessionId: string) {
  const items = listSpawned(cwd, sessionId);
  if (items.length === 0) {
    return result('No spawned agents for this project.', {
      mode: 'spawn.list',
      agents: [],
    });
  }

  const lines = [
    '# Running Spawned Agents',
    '',
    ...items.map((agent) => {
      const tail = agent.taskId ? ` → ${agent.taskId}` : '';
      return `- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)}) · ${agent.status}${tail}`;
    }),
    '',
    `Use pi-messenger-swarm spawn history to see all agents including completed.`,
  ];

  return result(lines.join('\n'), {
    mode: 'spawn.list',
    agents: items,
  });
}

function spawnHistory(cwd: string, sessionId: string) {
  const items = listSpawnedHistory(cwd, sessionId);
  const running = items.filter((a) => a.status === 'running');
  const completed = items.filter((a) => a.status === 'completed');
  const failed = items.filter((a) => a.status === 'failed');
  const stopped = items.filter((a) => a.status === 'stopped');

  if (items.length === 0) {
    return result('No spawned agents for this project.', { mode: 'spawn.history', agents: [] });
  }

  const lines: string[] = ['# Spawned Agent History', ''];

  const formatAgentLine = (agent: (typeof items)[number]) => {
    const tail = agent.taskId ? ` → ${agent.taskId}` : '';
    const ended = agent.endedAt ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}` : '';
    const error = agent.error?.split('\n')[0];
    return `- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}${ended}${error ? ` — ${error}` : ''}`;
  };

  if (running.length > 0) {
    lines.push('## Running');
    for (const agent of running.slice(0, 8)) lines.push(formatAgentLine(agent));
    lines.push('');
  }

  if (completed.length > 0) {
    lines.push(`## Completed (${completed.length})`);
    for (const agent of completed.slice(0, 10)) lines.push(formatAgentLine(agent));
    if (completed.length > 10) {
      lines.push(`... and ${completed.length - 10} more`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push(`## Failed (${failed.length})`);
    for (const agent of failed.slice(0, 5)) lines.push(formatAgentLine(agent));
    lines.push('');
  }

  if (stopped.length > 0) {
    lines.push(`## Stopped (${stopped.length})`);
    for (const agent of stopped.slice(0, 5)) lines.push(formatAgentLine(agent));
    lines.push('');
  }

  return result(lines.join('\n'), {
    mode: 'spawn.history',
    agents: items,
    counts: {
      running: running.length,
      completed: completed.length,
      failed: failed.length,
      stopped: stopped.length,
    },
  });
}

function spawnStop(params: { id?: string }, cwd: string) {
  const id = params.id;
  if (!id) {
    return result('Error: id required for spawn.stop', {
      mode: 'spawn.stop',
      error: 'missing_id',
    });
  }

  const stopped = stopSpawn(cwd, id);
  if (!stopped) {
    return result(`Error: could not stop spawn ${id}.`, {
      mode: 'spawn.stop',
      error: 'not_found_or_not_running',
      id,
    });
  }

  return result(`Stopping spawned agent ${id}...`, {
    mode: 'spawn.stop',
    id,
  });
}

function spawnCreate(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string
) {
  if (getCircuitBreaker(cwd, sessionId).isTripped()) {
    return result('Error: Circuit breaker is tripped. Spawning new agents is locked.', {
      mode: 'spawn',
      error: 'circuit_broken',
    });
  }

  // Without an active Run, an unbound spawn still warns when ready tasks exist.
  // Under an active Run the Claimable Task gate rejects it, including --force.
  if (!readRun(cwd) && !params.taskId && !params.force) {
    const ready = taskStore.getReadyTasks(cwd, sessionId);
    if (ready.length > 0) {
      const list = ready.map((t) => `  ${t.id}: ${t.title}`).join('\n');
      return result(
        `⚠️  You have ${ready.length} ready task${ready.length === 1 ? '' : 's'} waiting to be claimed.\n${list}\n\n` +
          `Use --task-id to bind this spawn to a specific task:\n` +
          `  pi-messenger-swarm spawn --task-id ${ready[0].id} --role "${params.role ?? 'Subagent'}" "..."\n\n` +
          `This prevents the parent agent from accidentally owning work meant for the subagent.`,
        {
          mode: 'spawn',
          error: 'missing_task_id',
          readyTasks: ready.map((t) => ({ id: t.id, title: t.title })),
        }
      );
    }
  }

  // Enforce the Width Cap to prevent thundering-herd API failures.
  // When more subagents run than the provider supports concurrently,
  // excess agents hit rate limits and spin on retries — wasting tokens
  // and making the whole swarm appear stuck.
  // Recheck under the Project Run lock and start before releasing it.
  return withRunLock(cwd, () => {
    const running = listSpawned(cwd, sessionId);
    const caller = running.find((agent) => agent.name === state.agentName);
    if (caller?.cohort && caller.cohort >= 2) {
      return result('Error: A Peer Node in a Cohort cannot spawn another Peer Node.', {
        mode: 'spawn',
        error: 'cohort_closed',
      });
    }
    const requested =
      typeof params.cohort === 'number' && params.cohort >= 2
        ? Math.floor(params.cohort)
        : undefined;
    if (requested && running.filter((agent) => agent.cohort === requested).length >= requested) {
      return result(`Error: A Cohort of ${requested} Peer Nodes is already started.`, {
        mode: 'spawn',
        error: 'cohort_closed',
      });
    }

    const run = readRun(cwd);
    if (run && run.id === sessionId) {
      if (run.status === 'aborted') {
        return result('Error: Run aborted; peer admission is stopped.', {
          mode: 'spawn',
          error: 'stopped',
        });
      }
      if (run.status !== 'active') {
        return result('Error: Run archived; peer admission is stopped.', {
          mode: 'spawn',
          error: 'stopped',
        });
      }
      if (run.consumedSteps >= run.maxSteps) {
        return result('Error: Step budget exhausted; peer admission is stopped.', {
          mode: 'spawn',
          error: 'breaker',
        });
      }
      if (run.acceptanceOwner && isProcessAlive(run.acceptanceOwner)) {
        return result('Error: Overall Goal Acceptance is running; peer admission is paused.', {
          mode: 'spawn',
          error: 'acceptance',
        });
      }
    }
    if (getCircuitBreaker(cwd, sessionId).isTripped()) {
      return result('Error: Circuit breaker is tripped. Spawning new agents is locked.', {
        mode: 'spawn',
        error: 'circuit_broken',
      });
    }

    const width = computeWidth(cwd);
    if (width.live >= width.cap) {
      return result(`Error: ${widthFullMessage(width)}`, {
        mode: 'spawn',
        error: 'concurrency_limit',
        running: width.live,
        limit: width.cap,
        limiter: width.limiter,
      });
    }

    // --message-file: read mission text from a file to avoid shell interpolation
    // of backticks, ${...}, parentheses, etc. in the prompt.
    let message = params.message?.trim() || params.prompt?.trim();
    if (params.messageFile) {
      try {
        const fileContent = fs.readFileSync(params.messageFile, 'utf-8').trim();
        if (fileContent) message = fileContent;
      } catch {
        return result(`Error: cannot read --message-file: ${params.messageFile}`, {
          mode: 'spawn',
          error: 'message_file_read_error',
        });
      }
    }

    // File-based spawn mode
    if (params.agentFile) {
      const cohort =
        typeof params.cohort === 'number' && params.cohort >= 2
          ? Math.floor(params.cohort)
          : undefined;
      const request: SpawnRequest = {
        agentFile: params.agentFile,
        model: params.model,
        objective: params.objective,
        message,
        context: params.context,
        taskId: params.taskId,
        name: params.name,
        cohort,
      };

      try {
        const record = spawnSubagent(cwd, request, sessionId, state.currentChannel);
        const roleLabel = formatRoleLabel(record.role);
        logFeedEvent(
          cwd,
          state.agentName,
          'message',
          undefined,
          `spawned ${record.name} (${roleLabel})`,
          state.currentChannel
        );

        return result(`🚀 Spawned ${record.name} (${record.id}) as ${roleLabel}.`, {
          mode: 'spawn',
          agent: record,
        });
      } catch (err) {
        return result(`Error: ${err instanceof Error ? err.message : String(err)}`, {
          mode: 'spawn',
          error: 'spawn_failed',
        });
      }
    }

    // Autoregressive spawn mode (traditional)
    const objective = params.objective?.trim() || message;
    if (!objective) {
      return result('Error: spawn requires mission text or --objective.', {
        mode: 'spawn',
        error: 'missing_objective',
      });
    }

    const cohort =
      typeof params.cohort === 'number' && params.cohort >= 2
        ? Math.floor(params.cohort)
        : undefined;
    const role = params.role?.trim() || params.title?.trim() || (cohort ? 'Peer' : 'Subagent');
    const request: SpawnRequest = {
      role,
      persona: params.persona,
      objective,
      model: params.model,
      context: params.context,
      taskId: params.taskId,
      name: params.name,
      cohort,
    };

    try {
      const record = spawnSubagent(cwd, request, sessionId, state.currentChannel);
      const roleLabel = formatRoleLabel(record.role);
      logFeedEvent(
        cwd,
        state.agentName,
        'message',
        undefined,
        `spawned ${record.name} (${roleLabel})`,
        state.currentChannel
      );

      return result(`🚀 Spawned ${record.name} (${record.id}) as ${roleLabel}.`, {
        mode: 'spawn',
        agent: record,
      });
    } catch (err) {
      return result(`Error: ${err instanceof Error ? err.message : String(err)}`, {
        mode: 'spawn',
        error: 'spawn_failed',
      });
    }
  });
}
