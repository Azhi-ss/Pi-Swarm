import { relative, sep } from 'node:path';
import { isProcessAlive, type Dirs, type MessengerState } from '../../lib.js';
import { getActiveAgents } from '../../store/agents.js';
import { getEffectiveSessionId, normalizeCwd } from '../../store/shared.js';
import * as taskStore from '../../swarm/task-store.js';
import { findSpawnedAgentByName, listSpawned } from '../../swarm/spawn.js';
import { getWorktreeInfo } from '../../swarm/worktree/index.js';
import type { SwarmTask } from '../../swarm/types.js';
import { result } from '../result.js';

function belongsToProject(candidate: string, cwd: string): boolean {
  const location = relative(normalizeCwd(cwd), normalizeCwd(candidate));
  return location === '' || location.startsWith(`.swarm${sep}workspaces${sep}`);
}

function taskStatus(task: SwarmTask) {
  return {
    id: task.id,
    status: task.status,
    leaseExpiresIn: task.lease_expires_at
      ? Math.max(0, Math.ceil((Date.parse(task.lease_expires_at) - Date.now()) / 1000))
      : null,
    verificationAttempts: task.verification_attempts ?? 0,
    remainingRetries: Math.max(0, 3 - (task.verification_attempts ?? 0)),
    lastError: task.last_verification_failure?.output ?? null,
  };
}

export function executeSelfStatus(state: MessengerState, cwd: string) {
  const sessionId = getEffectiveSessionId(cwd, state);
  const record = findSpawnedAgentByName(cwd, sessionId, state.agentName);
  const spawned = record?.status === 'running' ? record : null;
  const allocation = getWorktreeInfo(spawned?.id ?? state.agentName);
  const worktree = allocation && belongsToProject(allocation.worktreePath, cwd) ? allocation : null;
  const task = taskStore
    .getAllTasks(cwd, sessionId)
    .find(
      (task) =>
        task.claimed_by === state.agentName &&
        (task.status === 'staked' || task.status === 'in_progress' || task.status === 'blocked')
    );
  const status = {
    agentId: worktree?.agentId ?? spawned?.id ?? state.agentName,
    agentName: state.agentName,
    sandboxPath: worktree?.worktreePath ?? spawned?.worktreePath ?? null,
    currentTask: task ? taskStatus(task) : null,
    runtime: {
      port: worktree?.port ?? spawned?.port ?? null,
      testPort: worktree?.testPort ?? spawned?.testPort ?? null,
    },
  };
  return result(JSON.stringify(status, null, 2), { mode: 'status.self', ...status });
}

export function executePeers(state: MessengerState, dirs: Dirs, cwd: string, taskId?: string) {
  const sessionId = getEffectiveSessionId(cwd, state);
  const tasks = taskStore.getAllTasks(cwd, sessionId);
  const spawned = listSpawned(cwd, sessionId);
  const peers = getActiveAgents({ ...state, scopeToFolder: false }, dirs)
    .filter((peer) => !peer.isHuman && belongsToProject(peer.cwd, cwd) && isProcessAlive(peer.pid))
    .map((peer) => ({
      name: peer.name,
      agentId: spawned.find((agent) => agent.name === peer.name)?.id ?? peer.name,
      pid: peer.pid,
      tasks: tasks
        .filter(
          (task) =>
            task.claimed_by === peer.name &&
            (task.status === 'staked' || task.status === 'in_progress') &&
            !taskStore.isLeaseExpired(task)
        )
        .map(taskStatus),
    }))
    .filter((peer) => !taskId || peer.tasks.some((task) => task.id === taskId));
  return result(JSON.stringify(peers, null, 2), { mode: 'peers', peers });
}
