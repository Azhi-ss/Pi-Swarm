import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { isProcessAlive } from '../../lib.js';
import type { SwarmTask } from '../types.js';
import { readRun, startRun, updateRun, endRun } from '../run-store.js';
import { listSpawned } from '../spawn.js';
import { computeWidth } from '../width.js';
import { getAllTasks, getTasksJsonlPath, writeBlackboard } from '../task-store.js';
import { forceKillProcessGroup } from '../process-manager.js';
import { result } from '../result.js';
import type { MessengerActionParams } from '../../action-types.js';

export function runStatus(cwd: string) {
  const run = readRun(cwd);
  if (!run) return { project: cwd, phase: 'No active run' };
  const live = listSpawned(cwd, run.id).length;
  return {
    ...run,
    phase: live ? 'Running' : 'Awaiting Handoff',
    livePeers: live,
    remainingSteps: Math.max(0, run.maxSteps - run.consumedSteps),
    width: computeWidth(cwd, run),
  };
}

export async function executeRun(
  cwd: string,
  name: string,
  operation: string,
  params: MessengerActionParams
) {
  if (operation === 'show') {
    if (!params.id) throw new Error('run show requires a run ID.');
    return result(JSON.stringify(readRun(cwd, params.id)), { mode: 'run.show' });
  }
  if (operation === 'start') {
    const run = startRun(cwd, {
      goal: params.goal || '',
      delegator: name,
      maxSteps: params.maxSteps,
      concurrency: params.concurrency,
      demandFill: params.demandFill,
      acceptanceCommand: params.verify,
    });
    writeBlackboard(cwd, run.id);
    return result(JSON.stringify(run), { mode: 'run.start', run });
  }
  const run = readRun(cwd);
  if (operation === 'status') return result(JSON.stringify(runStatus(cwd)), { mode: 'run.status' });
  if (!run) throw new Error('No active Swarm Run; use run start --goal.');
  if (operation === 'accept') {
    const command = run.acceptanceCommand;
    if (!command)
      throw new Error(
        'Overall Goal Acceptance is incomplete: no acceptance command was recorded at run start.'
      );
    const tasks = getAllTasks(cwd, run.id);
    if (!readyForAcceptance(tasks))
      throw new Error('Overall Goal Acceptance is incomplete: tasks still lack verified evidence.');
    if (listSpawned(cwd, run.id).length)
      throw new Error('Overall Goal Acceptance waits for live peers to exit.');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const snapshot = acceptanceEvidence(cwd, run.id, head);
    let evaluator: ChildProcess | undefined;
    try {
      const checked = await new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
        try {
          updateRun(cwd, run.id, (current) => {
            if (current.status !== 'active') throw new Error('Run is no longer active.');
            if (current.acceptanceOwner && isProcessAlive(current.acceptanceOwner))
              throw new Error('Overall Goal Acceptance is already running.');
            if (listSpawned(cwd, run.id).length)
              throw new Error('Live peers must exit before acceptance.');
            if (current.acceptancePid) forceKillProcessGroup(current.acceptancePid);
            // Admission and the evaluator PID are published under one lock,
            // allowing even another service to stop the complete process group.
            evaluator = spawn(command, {
              cwd,
              shell: true,
              detached: process.platform !== 'win32',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            current.acceptanceOwner = process.pid;
            current.acceptancePid = evaluator.pid;
          });
        } catch (error) {
          reject(error);
          return;
        }
        const child = evaluator!;
        let output = '';
        const collect = (chunk: Buffer | string) => {
          output = (output + chunk.toString()).slice(-16000);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        const timeout = setTimeout(() => {
          if (child.pid) forceKillProcessGroup(child.pid);
        }, 60_000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          resolve({ exitCode: 1, output: output + error.message });
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          resolve({ exitCode: code ?? 1, output });
        });
      });
      const observed = updateRun(cwd, run.id, (current) => {
        if (current.status !== 'active') return;
        current.acceptance = {
          command,
          exitCode: checked.exitCode,
          output: checked.output,
          checkedAt: new Date().toISOString(),
          head,
          snapshot,
        };
        delete current.acceptancePid;
      });
      if (observed.status !== 'active') throw new Error('Run stopped during overall acceptance.');
      if (checked.exitCode !== 0)
        throw new Error(
          `Overall Goal Acceptance failed (exit ${checked.exitCode}): ${checked.output}`
        );
      endRun(cwd, run.id, 'completed', () => {
        const nowHead = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd,
          encoding: 'utf8',
        }).trim();
        if (acceptanceEvidence(cwd, run.id, nowHead) !== snapshot)
          throw new Error('Project changed during overall acceptance; reverify.');
      });
    } finally {
      if (evaluator?.pid)
        updateRun(cwd, run.id, (current) => {
          if (current.acceptanceOwner !== process.pid) return;
          delete current.acceptanceOwner;
          if (current.acceptancePid === evaluator?.pid) delete current.acceptancePid;
        });
    }
    return result(JSON.stringify(readRun(cwd, run.id)), { mode: 'run.accept' });
  }
  throw new Error(`Unknown run operation: ${operation}`);
}

/** Identity of the HEAD and task log examined by one acceptance attempt. */
export function acceptanceEvidence(cwd: string, runId: string, head: string): string {
  const file = getTasksJsonlPath(cwd, runId);
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return createHash('sha256').update(`${head}\0${body}`).digest('hex');
}

/** Pruned and Superseded hypotheses are terminal, and neither is a verified success. */
export function readyForAcceptance(tasks: SwarmTask[]): boolean {
  const succeeded = (task: SwarmTask) =>
    ['done', 'verified', 'archived'].includes(task.status) && task.verification?.exitCode === 0;
  return (
    tasks.some(succeeded) &&
    tasks.every(
      (task) => task.status === 'dead_end' || task.status === 'superseded' || succeeded(task)
    )
  );
}
