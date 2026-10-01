import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config.js';
import { isProcessAlive } from '../lib.js';
import { messengerDirs } from '../project.js';
import { readRun, type SwarmRun } from './run-store.js';
import { getRunningSpawnCount, listSpawned } from './spawn.js';
import { finishedAlternativeRoot } from './alternative.js';
import { getAllTasks, getReadyTasksForTasks } from './task-store/queries.js';

/** A service process's Port Slot pool; beyond it port allocation degrades to random overflow. */
export const PORT_SLOTS = 50;
export const PEER_STEP_RESERVE = 5;

export type WidthLimiter =
  | 'demand'
  | 'run-cap'
  | 'host-cap'
  | 'budget'
  | 'port-slots'
  | 'acceptance'
  | 'breaker'
  | 'stopped';

export interface Width {
  live: number;
  cap: number;
  run?: number;
  host: number;
  budget?: number;
  openDemand: number;
  idle: number;
  fill: 'on' | 'off';
  limiter: WidthLimiter;
}

/** The one Width Cap computation: persisted Run record plus the Project config read live. */
export function computeWidth(cwd: string, run: SwarmRun | undefined = readRun(cwd)): Width {
  const configured = loadConfig(cwd).maxConcurrentSpawns;
  const host = Math.min(configured, PORT_SLOTS);
  if (!run) {
    const live = getRunningSpawnCount(cwd);
    const limiter = configured > PORT_SLOTS ? 'port-slots' : 'host-cap';
    return { live, cap: host, host, openDemand: 0, idle: 0, fill: 'off', limiter };
  }
  const peers = listSpawned(cwd, run.id, true);
  const livePeers = peers.filter((p) => p.status === 'running' && p.pid && isProcessAlive(p.pid));
  const tasks = getAllTasks(cwd, run.id);
  const leased = new Set(
    tasks.filter((t) => ['staked', 'in_progress'].includes(t.status)).map((t) => t.claimed_by)
  );
  // A task whose bound peer exited awaits Automatic Handoff, not new admission.
  const openDemand = getReadyTasksForTasks(tasks).filter(
    (t) =>
      !run.handoffs[t.id]?.suspended && !peers.some((p) => p.taskId === t.id && !p.stopRequested)
  ).length;
  const live = livePeers.length;
  const budget = Math.max(0, Math.floor((run.maxSteps - run.consumedSteps) / PEER_STEP_RESERVE));
  const cap = Math.min(run.concurrency, host, budget, PORT_SLOTS);
  const holding: Array<[WidthLimiter, boolean]> = [
    ['demand', openDemand === 0],
    ['run-cap', live >= run.concurrency],
    ['host-cap', live >= host],
    ['budget', live >= budget],
    ['port-slots', live >= PORT_SLOTS || configured > PORT_SLOTS],
    ['acceptance', !!run.acceptanceOwner && isProcessAlive(run.acceptanceOwner)],
    ['breaker', run.consumedSteps >= run.maxSteps],
    ['stopped', run.status !== 'active'],
  ];
  const binding: Array<[WidthLimiter, number]> = [
    ['run-cap', run.concurrency],
    ['host-cap', host],
    ['budget', budget],
  ];
  // Nothing holds yet: report the cap that will bind next.
  const limiter =
    holding.filter(([, holds]) => holds).pop()?.[0] ??
    binding.filter(([, value]) => value === cap).pop()?.[0] ??
    'port-slots';
  return {
    live,
    cap,
    run: run.concurrency,
    host,
    budget,
    openDemand,
    idle: livePeers.filter((p) => !leased.has(p.name)).length,
    fill: run.demandFill ? 'on' : 'off',
    limiter,
  };
}

function registryOwnerLive(cwd: string, name: string): boolean {
  try {
    const registered = JSON.parse(
      fs.readFileSync(path.join(messengerDirs(cwd).registry, `${name}.json`), 'utf8')
    ) as { pid?: number };
    return !!registered.pid && isProcessAlive(registered.pid);
  } catch {
    return false;
  }
}

/**
 * Why `taskId` cannot be admitted, or null when it is Claimable.
 * A member of a finished Alternative Group is not Claimable.
 */
export function claimableRejection(
  cwd: string,
  run: SwarmRun,
  taskId: string | undefined
): string | null {
  if (!taskId) return 'Spawn is not bound to a Claimable Task.';
  const tasks = getAllTasks(cwd, run.id);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return `Task ${taskId} is not a Claimable Task.`;
  const finished = finishedAlternativeRoot(task, tasks);
  if (finished)
    return `Task ${task.id} is not a Claimable Task (finished Alternative Group ${finished}).`;
  if (run.handoffs[task.id]?.suspended) return `Task ${task.id} is suspended.`;
  const peers = listSpawned(cwd, run.id, true);
  const live = (peer: (typeof peers)[number]) =>
    peer.status === 'running' && !!peer.pid && isProcessAlive(peer.pid);
  if (peers.some((peer) => peer.taskId === task.id && live(peer)))
    return `Task ${task.id} is claimed by a live owner.`;
  if (
    task.claimed_by &&
    task.lease_expires_at &&
    Date.parse(task.lease_expires_at) > Date.now() &&
    (peers.some((peer) => peer.name === task.claimed_by && live(peer)) ||
      registryOwnerLive(cwd, task.claimed_by))
  )
    return `Task ${task.id} is claimed by a live owner.`;
  if (task.status !== 'todo')
    return `Task ${task.id} is not a Claimable Task (status ${task.status}).`;
  const done = new Set(
    tasks
      .filter((item) => item.status === 'done' || item.status === 'verified')
      .map((item) => item.id)
  );
  const unmet = task.depends_on.filter((dep) => !done.has(dep));
  if (unmet.length) return `Task ${task.id} has unmet dependencies (${unmet.join(', ')}).`;
  return null;
}

/** Admission refusals that must not count as an Automatic Handoff takeover failure. */
export function isDeferredAdmission(message: string): boolean {
  return (
    message.includes('Claimable Task') ||
    message.includes('claimed by a live owner') ||
    message.includes('unmet dependencies') ||
    message.includes('is suspended') ||
    message.includes('peer admission') ||
    message.includes('Width Cap') ||
    message.includes('Circuit breaker is tripped') ||
    message.includes('no longer eligible')
  );
}

export const formatWidth = (w: Width) =>
  `Width: ${w.live}/${w.cap} (run ${w.run}, host ${w.host}, budget ${w.budget}) | Open Demand: ${w.openDemand} | Idle: ${w.idle} | Fill: ${w.fill} | Limited by: ${w.limiter}`;

export const widthFullMessage = (w: Width) =>
  `${w.live} subagent${w.live === 1 ? '' : 's'} already running (Width Cap: ${w.cap}, Limited by: ${w.limiter}). ` +
  `Wait for one to complete or raise maxConcurrentSpawns in .pi/pi-messenger.json; run concurrency is fixed at run start.`;
