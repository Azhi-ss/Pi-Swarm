/**
 * Pi Messenger action router (swarm-first).
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { MessengerState, Dirs, AgentMailMessage, NameThemeConfig } from './lib.js';
import * as handlers from './handlers.js';
import type { MessengerActionParams } from './action-types.js';
import { result } from './swarm/result.js';
import { executeSpawn, executeSwarmStatus, executeTask } from './swarm/handlers.js';
import { getEffectiveSessionId } from './store/shared.js';
import { processManager } from './swarm/process-manager.js';
import { circuitBreaker } from './swarm/circuit-breaker/index.js';

type DeliverFn = (msg: AgentMailMessage) => void;
type UpdateStatusFn = (ctx: ExtensionContext) => void;

export interface RouterConfig {
  stuckThreshold?: number;
  swarmEventsInFeed?: boolean;
  nameTheme?: NameThemeConfig;
  feedRetention?: number;
  maxConcurrentSpawns?: number;
}

export async function executeAction(
  action: string,
  params: MessengerActionParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  deliverMessage: DeliverFn,
  updateStatus: UpdateStatusFn,
  _appendEntry?: (type: string, data: unknown) => void,
  config?: RouterConfig,
  _signal?: AbortSignal
) {
  const dotIndex = action.indexOf('.');
  const group = dotIndex > 0 ? action.slice(0, dotIndex) : action;
  const op = dotIndex > 0 ? action.slice(dotIndex + 1) : null;
  const cwd = ctx.cwd ?? process.cwd();
  const sessionId = getEffectiveSessionId(cwd, state);

  // Helper to get current channel or throw
  function requireChannel(): string {
    const channel = state.currentChannel ?? state.sessionChannel;
    if (!channel) {
      throw new Error('No current or session channel set');
    }
    return channel;
  }

  if (group === 'join') {
    return handlers.executeJoin(
      state,
      dirs,
      ctx,
      deliverMessage,
      updateStatus,
      params.spec,
      config?.nameTheme,
      config?.feedRetention,
      params.channel,
      params.create
    );
  }

  if (group === 'autoRegisterPath') {
    if (!params.autoRegisterPath) {
      return result("Error: autoRegisterPath requires value ('add', 'remove', or 'list').", {
        mode: 'autoRegisterPath',
        error: 'missing_value',
      });
    }
    return handlers.executeAutoRegisterPath(params.autoRegisterPath);
  }

  if (!state.registered) {
    return handlers.notRegisteredError();
  }

  switch (group) {
    case 'status':
      return handlers.executeStatus(state, dirs, cwd);

    case 'list':
      return handlers.executeList(state, dirs, cwd, { stuckThreshold: config?.stuckThreshold });

    case 'whois': {
      if (!params.name) {
        return result('Error: name required for whois action.', {
          mode: 'whois',
          error: 'missing_name',
        });
      }
      return handlers.executeWhois(state, dirs, cwd, params.name, {
        stuckThreshold: config?.stuckThreshold,
      });
    }

    case 'set_status':
      return handlers.executeSetStatus(state, dirs, ctx, params.message);

    case 'feed':
      return handlers.executeFeed(
        cwd,
        requireChannel(),
        params.limit,
        config?.swarmEventsInFeed ?? true,
        params.channel
      );

    case 'send':
      return handlers.executeSend(
        state,
        dirs,
        cwd,
        params.to,
        params.message,
        params.replyTo,
        params.channel ?? requireChannel()
      );

    case 'broadcast':
      return result(
        'Action "broadcast" was removed. Use `pi-messenger-swarm send #channel "message"` instead.',
        { mode: 'broadcast_removed', error: 'removed_action', action }
      );

    case 'reserve':
      if (!params.paths || params.paths.length === 0) {
        return result('Error: paths required for reserve action.', {
          mode: 'reserve',
          error: 'missing_paths',
        });
      }
      return handlers.executeReserve(state, dirs, ctx, params.paths, params.reason);

    case 'release':
      return handlers.executeRelease(state, dirs, ctx, params.paths ?? true);

    case 'rename':
      if (!params.name) {
        return result('Error: name required for rename action.', {
          mode: 'rename',
          error: 'missing_name',
        });
      }
      return handlers.executeRename(state, dirs, ctx, params.name, deliverMessage, updateStatus);

    case 'swarm': {
      if (op === 'abort') {
        const reason = (params.reason as string) || 'Swarm abort requested';
        await circuitBreaker.triggerAbort(cwd, sessionId, reason);
        return result(`🛑 Swarm aborted: ${reason}`, {
          mode: 'swarm.abort',
          aborted: true,
          reason,
        });
      }
      return executeSwarmStatus(cwd, params.channel ?? requireChannel(), sessionId);
    }

    case 'abort': {
      const reason = (params.reason as string) || 'Manual abort requested';
      await circuitBreaker.triggerAbort(cwd, sessionId, reason);
      return result(`🛑 Swarm aborted: ${reason}`, { mode: 'swarm.abort', aborted: true, reason });
    }

    case 'ps': {
      const operation = op ?? 'list';
      if (operation === 'list') {
        const workers = processManager.list(params.all === true);
        if (workers.length === 0) {
          return result('No running swarm workers.', { mode: 'ps.list', workers: [] });
        }
        const lines = [
          '| ID | Name | Agent | PID | Status | Started |',
          '|---|---|---|---|---|---|',
        ];
        for (const w of workers) {
          lines.push(
            `| ${w.id} | ${w.name} | ${w.agentName} | ${w.pid} | ${w.status} | ${w.startedAt} |`
          );
        }
        return result(lines.join('\n'), { mode: 'ps.list', workers });
      }
      if (operation === 'logs') {
        const id = (params.id ?? params.workerId) as string;
        if (!id) {
          return result('Error: worker id required for ps logs', {
            mode: 'ps.logs',
            error: 'missing_id',
          });
        }
        const maxLines = typeof params.lines === 'number' ? params.lines : 100;
        const logs = processManager.getLogs(id, maxLines);
        const text = `=== Worker ${id} Logs ===\n--- STDOUT ---\n${logs.stdout || '(no stdout)'}\n--- STDERR ---\n${logs.stderr || '(no stderr)'}`;
        return result(text, { mode: 'ps.logs', id, ...logs });
      }
      if (operation === 'kill') {
        const id = (params.id ?? params.workerId) as string;
        if (!id) {
          return result('Error: worker id required for ps kill', {
            mode: 'ps.kill',
            error: 'missing_id',
          });
        }
        const stopped = processManager.kill(id);
        if (!stopped) {
          return result(`Error: worker ${id} not found`, {
            mode: 'ps.kill',
            error: 'not_found',
            id,
          });
        }
        return result(`Worker ${id} terminated and sandbox cleaned.`, {
          mode: 'ps.kill',
          id,
          stopped: true,
        });
      }
      return result(`Unknown ps operation: ${operation}`, {
        mode: 'ps',
        error: 'unknown_operation',
      });
    }

    case 'task': {
      const operation = op ?? 'list';
      return executeTask(
        operation,
        params,
        state,
        cwd,
        params.channel ?? requireChannel(),
        sessionId,
        deliverMessage
      );
    }

    // Backward-compatible aliases for older swarm calls
    case 'claim': {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result('Error: id or taskId required for claim action.', {
          mode: 'claim',
          error: 'missing_task_id',
        });
      }
      return executeTask(
        'claim',
        { ...params, id: taskId },
        state,
        cwd,
        params.channel ?? requireChannel(),
        sessionId
      );
    }

    case 'unclaim': {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result('Error: id or taskId required for unclaim action.', {
          mode: 'unclaim',
          error: 'missing_task_id',
        });
      }
      return executeTask(
        'unclaim',
        { ...params, id: taskId },
        state,
        cwd,
        params.channel ?? requireChannel(),
        sessionId
      );
    }

    case 'complete': {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result('Error: id or taskId required for complete action.', {
          mode: 'complete',
          error: 'missing_task_id',
        });
      }
      return executeTask(
        'done',
        { ...params, id: taskId },
        state,
        cwd,
        params.channel ?? requireChannel(),
        sessionId,
        deliverMessage
      );
    }

    case 'done': {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result('Error: id or taskId required for done action.', {
          mode: 'done',
          error: 'missing_task_id',
        });
      }
      return executeTask(
        'done',
        { ...params, id: taskId },
        state,
        cwd,
        params.channel ?? requireChannel(),
        sessionId,
        deliverMessage
      );
    }

    case 'blackboard': {
      return executeTask(
        'blackboard',
        params,
        state,
        cwd,
        params.channel ?? requireChannel(),
        sessionId
      );
    }

    case 'propose': {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result('Error: id or taskId required for propose action.', {
          mode: 'propose',
          error: 'missing_task_id',
        });
      }
      return executeTask(
        'propose',
        { ...params, id: taskId },
        state,
        cwd,
        params.channel ?? requireChannel(),
        sessionId
      );
    }

    case 'challenge': {
      const taskId = params.taskId ?? params.id;
      if (!taskId) {
        return result('Error: id or taskId required for challenge action.', {
          mode: 'challenge',
          error: 'missing_task_id',
        });
      }
      return executeTask(
        'challenge',
        { ...params, id: taskId },
        state,
        cwd,
        params.channel ?? requireChannel(),
        sessionId
      );
    }

    case 'channels':
      return handlers.executeChannels(state, dirs, cwd, params.showAll ? true : undefined);

    case 'spawn':
      return executeSpawn(op, params, state, cwd, sessionId, config?.maxConcurrentSpawns);

    default:
      return result(`Unknown action: ${action}`, {
        mode: 'error',
        error: 'unknown_action',
        action,
      });
  }
}
