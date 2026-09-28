import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState, AgentMailMessage } from '../../lib.js';
import { normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import * as taskStore from '../task-store.js';
import type { SwarmTaskEvidence } from '../types.js';
import { summaryLine } from './_utils.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listSpawned } from '../spawn.js';
import {
  runVerification,
  detectProjectTestCommand,
  generatePatch,
  precheckPatchSync,
  applyAndCommitPatchSync,
  computePatchSha,
} from '../verifier/index.js';
import { getWorktreeInfo } from '../worktree/index.js';
import { circuitBreaker } from '../circuit-breaker/index.js';

/**
 * Ensures BLACKBOARD.md is excluded from Git status without dirtying .gitignore or tracked files.
 */
function ensureGitExclude(cwd: string): void {
  try {
    const res = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status === 0 && res.stdout.trim()) {
      const trimmed = res.stdout.trim();
      const excludePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
      if (fs.existsSync(excludePath)) {
        const content = fs.readFileSync(excludePath, 'utf-8');
        if (!content.includes('BLACKBOARD.md')) {
          fs.appendFileSync(excludePath, '\nBLACKBOARD.md\n');
        }
      }
    }
  } catch {
    // Ignore
  }
}

export function taskClaim(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (circuitBreaker.isTripped()) {
    return result('Error: Circuit breaker is tripped. Task mutations are locked.', {
      mode: 'task.claim',
      error: 'circuit_broken',
    });
  }

  if (!params.id)
    return result('Error: id required for task.claim', { mode: 'task.claim', error: 'missing_id' });

  const claimed = taskStore.claimTask(cwd, sessionId, params.id, state.agentName, params.reason);
  if (!claimed) {
    const existing = taskStore.getTask(cwd, sessionId, params.id);
    if (!existing)
      return result(`Error: task ${params.id} not found`, {
        mode: 'task.claim',
        error: 'not_found',
        id: params.id,
      });
    if (existing.status === 'in_progress' || existing.status === 'staked') {
      return result(
        `Error: ${params.id} is already claimed by ${existing.claimed_by ?? 'another agent'}.`,
        {
          mode: 'task.claim',
          error: 'already_claimed',
          id: params.id,
          claimedBy: existing.claimed_by,
        }
      );
    }
    if (existing.status === 'done' || existing.status === 'verified') {
      return result(`Error: ${params.id} is already completed.`, {
        mode: 'task.claim',
        error: 'already_done',
        id: params.id,
      });
    }
    return result(`Error: ${params.id} is not ready to claim (check dependencies).`, {
      mode: 'task.claim',
      error: 'not_ready',
      id: params.id,
    });
  }

  taskStore.writeBlackboard(cwd, sessionId);
  logFeedEvent(cwd, state.agentName, 'task.start', claimed.id, claimed.title, channelId);

  // Warn if the claiming agent also created the task and delegated it.
  // This catches the common anti-pattern of a coordinator spawning subagents
  // then claiming those tasks itself, leaving spawned agents idle.
  let warning: string | undefined;
  if (claimed.created_by === state.agentName && claimed.created_by !== undefined && cwd) {
    // Check if there are live spawned agents for this session
    const alive = listSpawned(cwd, sessionId);
    if (alive.length > 0) {
      warning =
        `⚠️  You created and delegated this task but are now claiming it yourself. ` +
        `${alive.length} spawned agent(s) are still running. Did you mean to let them claim it?`;
    }
  }

  const text = warning
    ? `🔄 Claimed ${claimed.id}: ${claimed.title}\n\n${warning}`
    : `🔄 Claimed ${claimed.id}: ${claimed.title}`;

  return result(text, {
    mode: 'task.claim',
    channel: normalizeChannelId(channelId),
    task: claimed,
  });
}

export function taskStake(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (circuitBreaker.isTripped()) {
    return result('Error: Circuit breaker is tripped. Task mutations are locked.', {
      mode: 'task.stake',
      error: 'circuit_broken',
    });
  }

  if (!params.id)
    return result('Error: id required for task.stake', { mode: 'task.stake', error: 'missing_id' });

  const staked = taskStore.stakeTask(cwd, sessionId, params.id, state.agentName, {
    ttl: params.ttl,
    reason: params.reason,
  });

  if (!staked) {
    const existing = taskStore.getTask(cwd, sessionId, params.id);
    if (!existing)
      return result(`Error: task ${params.id} not found`, {
        mode: 'task.stake',
        error: 'not_found',
        id: params.id,
      });
    if (
      (existing.status === 'in_progress' || existing.status === 'staked') &&
      !taskStore.isLeaseExpired(existing)
    ) {
      return result(
        `Error: ${params.id} is already claimed by ${existing.claimed_by ?? 'another agent'}.`,
        {
          mode: 'task.stake',
          error: 'already_claimed',
          id: params.id,
          claimedBy: existing.claimed_by,
        }
      );
    }
    if (existing.status === 'done' || existing.status === 'verified') {
      return result(`Error: ${params.id} is already completed.`, {
        mode: 'task.stake',
        error: 'already_done',
        id: params.id,
      });
    }
    return result(`Error: ${params.id} is not ready to stake (check dependencies).`, {
      mode: 'task.stake',
      error: 'not_ready',
      id: params.id,
    });
  }

  taskStore.writeBlackboard(cwd, sessionId);
  logFeedEvent(
    cwd,
    state.agentName,
    'task.start',
    staked.id,
    params.reason ? `staked — ${params.reason}` : 'staked',
    channelId
  );

  return result(
    `⚡ Staked ${staked.id}: ${staked.title} (TTL: ${staked.lease_ttl ?? 300}s)${params.reason ? `\nReason: ${params.reason}` : ''}`,
    {
      mode: 'task.stake',
      channel: normalizeChannelId(channelId),
      task: staked,
    }
  );
}

export function taskUnclaim(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.unclaim', {
      mode: 'task.unclaim',
      error: 'missing_id',
    });

  const unclaimed = taskStore.unclaimTask(cwd, sessionId, params.id, state.agentName);
  if (!unclaimed) {
    const existing = taskStore.getTask(cwd, sessionId, params.id);
    if (!existing)
      return result(`Error: task ${params.id} not found`, {
        mode: 'task.unclaim',
        error: 'not_found',
        id: params.id,
      });
    return result(`Error: ${params.id} cannot be unclaimed by ${state.agentName}.`, {
      mode: 'task.unclaim',
      error: 'not_owner',
      id: params.id,
      claimedBy: existing.claimed_by,
    });
  }

  taskStore.writeBlackboard(cwd, sessionId);
  logFeedEvent(cwd, state.agentName, 'task.reset', unclaimed.id, 'unclaimed', channelId);

  return result(`Released claim on ${unclaimed.id}.`, {
    mode: 'task.unclaim',
    channel: normalizeChannelId(channelId),
    task: unclaimed,
  });
}

export function taskDone(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string,
  deliverMessage?: (msg: AgentMailMessage) => void
) {
  if (!params.id)
    return result('Error: id required for task.done', { mode: 'task.done', error: 'missing_id' });

  const existing = taskStore.getTask(cwd, sessionId, params.id);
  if (!existing) {
    return result(`Error: task ${params.id} not found`, {
      mode: 'task.done',
      error: 'not_found',
      id: params.id,
    });
  }
  if (existing.status !== 'in_progress' && existing.status !== 'staked') {
    return result(`Error: ${params.id} is ${existing.status}, not in_progress.`, {
      mode: 'task.done',
      error: 'invalid_status',
      id: params.id,
    });
  }
  if (existing.claimed_by !== state.agentName) {
    return result(`Error: ${params.id} is claimed by ${existing.claimed_by ?? 'another agent'}.`, {
      mode: 'task.done',
      error: 'not_owner',
      id: params.id,
      claimedBy: existing.claimed_by,
    });
  }

  const summary = params.summary ?? 'Task completed';
  const evidence = params.evidence as SwarmTaskEvidence | undefined;

  // If agent operates in an active worktree sandbox, execute verification & generate patch in that worktree
  const worktree = getWorktreeInfo(state.agentName);
  const targetCwd =
    worktree?.worktreePath && fs.existsSync(worktree.worktreePath) ? worktree.worktreePath : cwd;

  // Determine verify command: params.verify (task-level override) or task.verify_command or detectProjectTestCommand(targetCwd)
  const verifyCommand =
    params.verify || existing.verify_command || detectProjectTestCommand(targetCwd);

  if (verifyCommand) {
    const verifRes = runVerification(targetCwd, verifyCommand, 60_000);

    if (!verifRes.passed) {
      // Verification failed!
      const rawOutput =
        (verifRes.stderr ? verifRes.stderr + '\n' : '') + (verifRes.stdout || '') ||
        verifRes.error ||
        'Verification failed';
      const output =
        rawOutput.length > 2000 ? rawOutput.slice(0, 2000) + '\n... [truncated]' : rawOutput;

      const attempt = (existing.verification_attempts ?? 0) + 1;
      const maxAttempts = 3;

      taskStore.recordVerificationFailed(cwd, sessionId, existing.id, state.agentName, {
        agent: state.agentName,
        attempt,
        maxAttempts,
        command: verifyCommand,
        exitCode: verifRes.exitCode,
        output,
      });

      // Deliver steer message to drive autonomous self-healing
      if (deliverMessage) {
        try {
          deliverMessage({
            id: `verif-${existing.id}-${Date.now()}`,
            from: 'verifier',
            to: state.agentName,
            text: `🚨 [Verification Failed] Task ${existing.id} completion rejected (Attempt ${attempt}/${maxAttempts}):\nCommand: ${verifyCommand}\nExit Code: ${verifRes.exitCode}\n\n${output}`,
            timestamp: new Date().toISOString(),
            replyTo: null,
            channel: channelId,
          });
        } catch {
          // Best effort
        }
      }

      if (attempt >= maxAttempts) {
        // Fast Pruning: 3 consecutive failures transitions to dead_end
        taskStore.deadEndTask(cwd, sessionId, existing.id, state.agentName, {
          agent: state.agentName,
          reason: `Verification failed ${maxAttempts} times`,
          attempts: attempt,
          lastCommand: verifyCommand,
          lastOutput: output,
          failureSummary: `Command "${verifyCommand}" exited with code ${verifRes.exitCode}`,
        });

        taskStore.writeBlackboard(cwd, sessionId);

        logFeedEvent(
          cwd,
          state.agentName,
          'task.dead_end',
          existing.id,
          `Pruned after ${maxAttempts} failed verifications: ${verifyCommand}`,
          channelId
        );

        return result(
          `🪦 Task ${existing.id} pruned to Dead End after ${maxAttempts} verification failures.\n\nExit code: ${verifRes.exitCode}\nOutput:\n${output}`,
          {
            mode: 'task.done',
            error: 'verification_failed',
            pruned: true,
            id: existing.id,
            exitCode: verifRes.exitCode,
            output,
            attempt,
            maxAttempts,
          }
        );
      }

      taskStore.writeBlackboard(cwd, sessionId);

      return result(
        `❌ Verification failed for ${existing.id} (Attempt ${attempt}/${maxAttempts}, exit code ${verifRes.exitCode}).\nTask remains in progress for self-healing.\n\nOutput:\n${output}`,
        {
          mode: 'task.done',
          error: 'verification_failed',
          id: existing.id,
          exitCode: verifRes.exitCode,
          output,
          attempt,
          maxAttempts,
        }
      );
    }

    // Exit 0: Passed verification!
    ensureGitExclude(cwd);

    let patchPath = generatePatch(targetCwd, existing.id, cwd);
    let resolvedPatchPath = patchPath
      ? path.isAbsolute(patchPath)
        ? patchPath
        : path.resolve(cwd, patchPath)
      : '';
    const workerId = worktree?.agentId || state.agentName;
    const currentPatchSha =
      resolvedPatchPath && fs.existsSync(resolvedPatchPath)
        ? computePatchSha(resolvedPatchPath)
        : '';

    // Run merge precheck
    let precheck = precheckPatchSync({
      hostCwd: cwd,
      targetCwd,
      patchPath: resolvedPatchPath,
      taskId: existing.id,
      workerId,
      verifyCommand,
      summary,
    });

    if (!precheck.ok) {
      // Collision Handling (Precheck fails):
      const attempt = (existing.verification_attempts ?? 0) + 1;
      const maxAttempts = 3;
      const conflictError = precheck.error || 'git apply --check failed';

      taskStore.recordVerificationFailed(cwd, sessionId, existing.id, state.agentName, {
        agent: state.agentName,
        attempt,
        maxAttempts,
        command: verifyCommand,
        exitCode: 1,
        output: `${conflictError}\n[patch_sha:${currentPatchSha}]`,
      });

      if (attempt >= maxAttempts) {
        // Fast Pruning triggers: mark task dead_end / graveyard, broadcast task.dead_end channel event, unclaim task
        taskStore.deadEndTask(cwd, sessionId, existing.id, state.agentName, {
          agent: state.agentName,
          reason: `Merge collision failed ${maxAttempts} times`,
          attempts: attempt,
          lastCommand: verifyCommand,
          lastOutput: conflictError,
          failureSummary: `Merge conflict: ${conflictError}`,
        });

        ensureGitExclude(cwd);
        taskStore.writeBlackboard(cwd, sessionId);

        logFeedEvent(
          cwd,
          state.agentName,
          'task.dead_end',
          existing.id,
          `Pruned after ${maxAttempts} merge collisions: ${conflictError}`,
          channelId
        );

        return result(
          `🪦 Task ${existing.id} pruned to Dead End after ${maxAttempts} merge collision failures.\n\nError:\n${conflictError}`,
          {
            mode: 'task.done',
            error: 'merge_conflict',
            pruned: true,
            id: existing.id,
            output: conflictError,
            attempt,
            maxAttempts,
          }
        );
      }

      // If < 3 failures:
      // Reject the done request.
      // Keep task in in_progress (do NOT mark completed or verified).
      // Deliver Steer message to worker sandbox with exact content:
      // "Main branch evolved with conflicts. Rebase your sandbox onto latest HEAD and re-verify!" (with triggerTurn: true).
      if (deliverMessage) {
        try {
          deliverMessage({
            id: `steer-collision-${existing.id}-${Date.now()}`,
            from: 'verifier',
            to: state.agentName,
            text: 'Main branch evolved with conflicts. Rebase your sandbox onto latest HEAD and re-verify!',
            timestamp: new Date().toISOString(),
            replyTo: null,
            channel: channelId,
            triggerTurn: true,
          } as any);
        } catch {
          // Best effort
        }
      }

      ensureGitExclude(cwd);
      taskStore.writeBlackboard(cwd, sessionId);

      return result(
        `❌ Merge collision detected for ${existing.id} (Attempt ${attempt}/${maxAttempts}).\nMain branch evolved with conflicts. Rebase your sandbox onto latest HEAD and re-verify!\nTask remains in progress for self-healing.\n\n${conflictError}`,
        {
          mode: 'task.done',
          error: 'merge_conflict',
          id: existing.id,
          output: conflictError,
          attempt,
          maxAttempts,
        }
      );
    }

    // Clean Path (Precheck succeeds):
    const mergeRes = applyAndCommitPatchSync({
      hostCwd: cwd,
      targetCwd,
      patchPath: resolvedPatchPath,
      taskId: existing.id,
      workerId,
      verifyCommand,
      summary,
    });

    if (!mergeRes.ok) {
      return result(`Error: Failed to merge patch: ${mergeRes.error}`, {
        mode: 'task.done',
        error: 'merge_failed',
        id: existing.id,
        output: mergeRes.error,
      });
    }

    const commitSha = mergeRes.commitSha;

    const verified = taskStore.verifyTask(cwd, sessionId, existing.id, state.agentName, {
      summary,
      command: verifyCommand,
      exitCode: 0,
      patch: patchPath ?? undefined,
      evidence,
      outputSnippet: verifRes.stdout.slice(0, 300),
      commitSha,
      commit: commitSha,
      passed: true,
    } as any);

    ensureGitExclude(cwd);
    taskStore.writeBlackboard(cwd, sessionId);

    logFeedEvent(cwd, state.agentName, 'task.verified', existing.id, summary, channelId);
    logFeedEvent(cwd, state.agentName, 'task.done', existing.id, summary, channelId);

    const commitInfo = commitSha ? `\nCommit: ${commitSha.slice(0, 7)}` : '';

    return result(
      `✅ Verified & Completed ${verified!.id}: ${verified!.title}\nGate: ${verifyCommand} (Exit: 0)${patchPath ? `\nArtifact: ${patchPath}` : ''}${commitInfo}\n\nSummary: ${summary}`,
      {
        mode: 'task.done',
        channel: normalizeChannelId(channelId),
        task: verified,
        summary: taskStore.getSummary(cwd, sessionId),
        verified: true,
        patch: patchPath,
        commitSha,
      }
    );
  }

  // Fallback for environments without verify command (e.g. bare test dirs)
  const completed = taskStore.completeTask(
    cwd,
    sessionId,
    params.id,
    state.agentName,
    summary,
    evidence
  );

  if (!completed) {
    return result(`Error: failed to complete task ${params.id}.`, {
      mode: 'task.done',
      error: 'completion_failed',
      id: params.id,
    });
  }

  taskStore.writeBlackboard(cwd, sessionId);
  logFeedEvent(cwd, state.agentName, 'task.done', completed.id, summary, channelId);

  return result(`✅ Completed ${completed.id}: ${completed.title}\n\nSummary: ${summary}`, {
    mode: 'task.done',
    channel: normalizeChannelId(channelId),
    task: completed,
    summary: taskStore.getSummary(cwd, sessionId),
  });
}

export function taskReset(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.reset', { mode: 'task.reset', error: 'missing_id' });

  const cascade = params.cascade === true;
  const reset = taskStore.resetTask(cwd, sessionId, params.id, cascade);
  if (reset.length === 0) {
    return result(`Error: failed to reset ${params.id}.`, {
      mode: 'task.reset',
      error: 'reset_failed',
      id: params.id,
    });
  }

  logFeedEvent(
    cwd,
    state.agentName,
    'task.reset',
    params.id,
    cascade ? `cascade (${reset.length})` : 'reset',
    channelId
  );

  return result(`🔄 Reset ${reset.length} task(s): ${reset.map((task) => task.id).join(', ')}`, {
    mode: 'task.reset',
    channel: normalizeChannelId(channelId),
    reset: reset.map((task) => task.id),
    cascade,
  });
}
