import { execFileSync } from 'node:child_process';
import { readRun, startRun, updateRun, endRun } from '../run-store.js';
import { listSpawned } from '../spawn.js';
import { getAllTasks, writeBlackboard } from '../task-store.js';
import { runVerification } from '../verifier/index.js';
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
  };
}

export function executeRun(
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
    if (
      !tasks.length ||
      tasks.some(
        (t) =>
          !['done', 'verified', 'archived'].includes(t.status) || t.verification?.exitCode !== 0
      )
    )
      throw new Error('Overall Goal Acceptance is incomplete: tasks still lack verified evidence.');
    if (listSpawned(cwd, run.id).length)
      throw new Error('Overall Goal Acceptance waits for live peers to exit.');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const checked = runVerification(cwd, command);
    updateRun(cwd, run.id, (current) => {
      current.acceptance = {
        command,
        exitCode: checked.exitCode,
        output: (checked.stdout + checked.stderr).slice(-16000),
        checkedAt: new Date().toISOString(),
        head,
      };
    });
    if (!checked.passed)
      throw new Error(
        `Overall Goal Acceptance failed (exit ${checked.exitCode}): ${checked.stderr || checked.stdout}`
      );
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() !== head)
      throw new Error('Project changed during overall acceptance; reverify.');
    endRun(cwd, run.id, 'completed');
    return result(JSON.stringify(readRun(cwd, run.id)), { mode: 'run.accept' });
  }
  throw new Error(`Unknown run operation: ${operation}`);
}
