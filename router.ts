import { readRun, readRunIfPresent, updateRun } from './swarm/run-store.js';
import { listCandidates, restoreCandidate } from './swarm/candidates.js';
import { listSpawned, stopSpawn } from './swarm/spawn.js';
import { getTask } from './swarm/task-store.js';
import { listCritical } from './swarm/notifications.js';
import { executeRun } from './swarm/handlers/run.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { getCircuitBreaker } from './swarm/circuit-breaker/index.js';
import { executeSelfStatus, executePeers } from './handlers/coordination/peer-toolbox.js';
import { executeObserverStatus, executeObserverExplain } from './swarm/handlers/observer.js';

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
  const run = readRun(cwd);
  const addressed = readRunIfPresent(cwd, sessionId);
  const readOnly = [
    'status',
    'explain',
    'peers',
    'list',
    'whois',
    'feed',
    'inbox',
    'notifications',
    'task.list',
    'task.show',
    'task.ready',
    'task.blackboard',
    'spawn.list',
    'spawn.history',
    'run.status',
    'run.show',
    'candidate.list',
    'candidate.show',
    'handoff.status',
    'blackboard',
  ];
  if (
    ((run && getCircuitBreaker(cwd, run.id).isTripped()) ||
      (addressed && addressed.status !== 'active')) &&
    !readOnly.includes(action) &&
    !['abort', 'swarm.abort', 'run.start'].includes(action)
  )
    throw new Error('Swarm Run is stopped or its budget is exhausted.');

  // Helper to get current channel or throw
  function requireChannel(): string {
    const channel = state.currentChannel ?? state.sessionChannel;
    if (!channel) {
      throw new Error('No current or session channel set');
    }
    return channel;
  }

  if (group === 'run' && op === 'join' && !readRun(cwd))
    throw new Error('No active Swarm Run; use run start --goal.');
  if (group === 'run' && op !== 'join')
    return executeRun(cwd, state.agentName, op || 'status', params);
  if (group === 'join' || (group === 'run' && op === 'join')) {
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

  const isObserverAction =
    (group === 'status' && !params.self) ||
    group === 'explain' ||
    group === 'notifications' ||
    group === 'abort' ||
    (group === 'swarm' && op === 'abort');
  if (!state.registered && !isObserverAction) {
    return handlers.notRegisteredError();
  }

  switch (group) {
    case 'status':
      return params.self
        ? executeSelfStatus(state, cwd)
        : executeObserverStatus(cwd, sessionId, state, dirs);

    case 'explain':
      return executeObserverExplain(cwd, sessionId, state, dirs);

    case 'abort': {
      const reason = params.reason || 'Manual abort requested';
      await getCircuitBreaker(cwd, sessionId).triggerAbort(cwd, sessionId, reason);
      return result(`🛑 Swarm aborted: ${reason}`, { mode: 'swarm.abort', aborted: true, reason });
    }

    case 'list':
      return handlers.executeList(state, dirs, cwd, { stuckThreshold: config?.stuckThreshold });

    case 'peers':
      return executePeers(state, dirs, cwd, params.taskId);

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

    case 'handoff': {
      const run = readRun(cwd);
      if (!run) throw new Error('No active run.');
      if (op === 'resume') {
        const id = params.id || '';
        const task = getTask(cwd, sessionId, id);
        if (!task || !['todo', 'staked', 'in_progress'].includes(task.status))
          throw new Error('Task is not eligible for handoff.');
        updateRun(cwd, run.id, (r) => {
          const h = r.handoffs[id];
          if (!h?.suspended) throw new Error('Task handoff is not suspended.');
          h.suspended = false;
          h.failures = 0;
          h.successor = undefined;
          h.errors.push(`Explicitly resumed by ${state.agentName} at ${new Date().toISOString()}`);
        });
      }
      return result(JSON.stringify(readRun(cwd)!.handoffs), { mode: 'handoff' });
    }
    case 'candidate': {
      const candidates = listCandidates(cwd, sessionId).filter(
        (c) => !params.taskId || c.taskId === params.taskId
      );
      if (!op || op === 'list')
        return result(JSON.stringify(candidates), { mode: 'candidate.list' });
      const candidate =
        params.id === 'latest' ? candidates[0] : candidates.find((c) => c.id === params.id);
      if (!candidate) throw new Error('Handoff Candidate not found in this run.');
      if (op === 'show')
        return result(JSON.stringify(candidate) + '\n' + fs.readFileSync(candidate.patch, 'utf8'), {
          mode: 'candidate.show',
        });
      if (op !== 'restore') throw new Error('Unknown candidate operation.');
      const task = getTask(cwd, sessionId, candidate.taskId);
      if (
        !task ||
        !['staked', 'in_progress'].includes(task.status) ||
        task.claimed_by !== state.agentName
      )
        throw new Error('Claim the eligible task before restoring its candidate.');
      const peer = listSpawned(cwd, sessionId).find((p) => p.name === state.agentName);
      if (!peer?.worktreePath) throw new Error('Candidate restoration requires your own Sandbox.');
      restoreCandidate(candidate, peer.worktreePath, params.paths);
      return result(
        'Candidate restored as UNVERIFIED. Inspect, verify, and submit through task done.',
        { mode: 'candidate.restore', candidate }
      );
    }
    case 'notifications':
      return result(JSON.stringify(listCritical(cwd, params.runId || sessionId)), {
        mode: 'notifications',
      });
    case 'inbox': {
      const file = path.join(dirs.base, 'inbox', `${state.agentName}.jsonl`);
      return result(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'No messages.', {
        mode: 'inbox',
      });
    }

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
      if (op === 'abort')
        return executeAction('abort', params, state, dirs, ctx, deliverMessage, updateStatus);
      return executeSwarmStatus(cwd, params.channel ?? requireChannel(), sessionId);
    }

    case 'ps': {
      const operation = op ?? 'list';
      if (operation === 'list') {
        const workers = processManager.list(params.all === true).filter((w) => w.cwd === cwd);
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
        const owned =
          listSpawned(cwd, sessionId, true).some((p) => p.id === id) ||
          processManager.list(true).some((p) => p.id === id && p.cwd === cwd);
        if (!owned) throw new Error('Worker not found in this Project and run.');
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
        const owned =
          listSpawned(cwd, sessionId, true).some((p) => p.id === id) ||
          processManager.list(true).some((p) => p.id === id && p.cwd === cwd);
        if (!owned) throw new Error('Worker not found in this Project and run.');
        const stopped = stopSpawn(cwd, id) || processManager.kill(id);
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
