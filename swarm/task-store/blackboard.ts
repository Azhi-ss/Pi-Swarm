import { activeRunId, messengerDirs } from '../../project.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SwarmTask } from '../types.js';
import { getAllTasks, getSummaryForTasks } from './queries.js';
import { isProcessAlive } from '../../lib.js';
import { getCircuitBreaker } from '../circuit-breaker/index.js';
import { computeWidth, formatWidth } from '../width.js';

interface ActivePeerInfo {
  name: string;
  pid: number;
  currentTaskId?: string;
  leaseSecondsLeft?: number;
}

function getActivePeers(cwd: string, tasks: SwarmTask[]): ActivePeerInfo[] {
  const registryDir = messengerDirs(cwd).registry;
  if (!fs.existsSync(registryDir)) return [];

  const peers: ActivePeerInfo[] = [];
  try {
    const files = fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
    const now = Date.now();

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(registryDir, file), 'utf-8');
        const reg = JSON.parse(content);
        if (reg.pid && isProcessAlive(reg.pid)) {
          const peerName = reg.name || file.replace(/\.json$/, '');
          const currentTask = tasks.find(
            (t) =>
              (t.status === 'staked' || t.status === 'in_progress') && t.claimed_by === peerName
          );

          let leaseSecondsLeft: number | undefined;
          if (currentTask?.lease_expires_at) {
            const expires = Date.parse(currentTask.lease_expires_at);
            leaseSecondsLeft = Math.max(0, Math.round((expires - now) / 1000));
          }

          peers.push({
            name: peerName,
            pid: reg.pid,
            currentTaskId: currentTask?.id,
            leaseSecondsLeft,
          });
        }
      } catch {
        // Skip unparseable registration
      }
    }
  } catch {
    // Best-effort
  }

  return peers;
}

/**
 * Generate a single-file, compact CQRS projection of the Four-Zone Blackboard.
 * Designed to strictly stay under ~1000 tokens while providing full visibility.
 */
export function generateBlackboard(cwd: string, sessionId: string): string {
  const allTasks = getAllTasks(cwd, sessionId);
  const summary = getSummaryForTasks(allTasks);
  const peers = getActivePeers(cwd, allTasks);
  const now = Date.now();
  const timestamp = new Date().toISOString();

  const doneIds = new Set(
    allTasks.filter((t) => t.status === 'done' || t.status === 'verified').map((t) => t.id)
  );

  // Partition tasks into 4 zones
  const goalTasks = allTasks.filter((t) => t.status === 'todo' || t.status === 'blocked');
  const stakedTasks = allTasks.filter((t) => t.status === 'staked' || t.status === 'in_progress');
  const verifiedTasks = allTasks.filter((t) => t.status === 'verified' || t.status === 'done');
  const graveyardTasks = allTasks.filter((t) => t.status === 'dead_end');

  const lines: string[] = [];

  // Header & Status
  lines.push('# 🐝 Pi-Swarm Global Blackboard');
  const identity =
    activeRunId(cwd) === sessionId
      ? `Project: ${cwd} | Run: ${sessionId}`
      : `Session: ${sessionId}`;
  lines.push(`> Updated: ${timestamp} | ${identity} | Active Peers: ${peers.length}`);
  if (activeRunId(cwd) === sessionId) lines.push(`> ${formatWidth(computeWidth(cwd))}`);
  lines.push(
    `> Progress: Total: ${summary.total} | Goals: ${goalTasks.length} | Staked: ${stakedTasks.length} | Verified: ${verifiedTasks.length} | Dead Ends: ${graveyardTasks.length}`
  );
  const budget = getCircuitBreaker(cwd, sessionId).getStatus();
  if (budget.isTripped) {
    const reason =
      budget.trippedReason || `${budget.consumedSteps}/${budget.maxSteps} steps exceeded`;
    lines.push(
      `> 🛑 **CIRCUIT BREAKER TRIPPED**: ${reason} | Budget: ${budget.remainingSteps}/${budget.maxSteps} steps remaining | Blackboard LOCKED | Swarm Aborted`
    );
  } else {
    lines.push(
      `> Step Budget: ${budget.consumedSteps}/${budget.maxSteps} steps consumed (${budget.remainingSteps} remaining) | Status: HEALTHY`
    );
  }
  lines.push('');

  // Active Peers
  lines.push('## 👥 Active Peers (Mesh Registry)');
  if (peers.length === 0) {
    lines.push('*No active peers currently registered in mesh.*');
  } else {
    lines.push('| Agent | Status | Current Task | PID |');
    lines.push('|---|---|---|---|');
    for (const peer of peers) {
      const taskStr = peer.currentTaskId
        ? `${peer.currentTaskId} (TTL: ${peer.leaseSecondsLeft ?? 0}s left)`
        : 'idle';
      lines.push(
        `| ${peer.name} | ${peer.currentTaskId ? 'staked' : 'idle'} | ${taskStr} | ${peer.pid} |`
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Zone 1: Goal & Open Backlog
  lines.push('## 🎯 Zone 1: Goal & Open Backlog');
  lines.push('*Unclaimed tasks ready for staking or waiting for dependencies.*');
  if (goalTasks.length === 0) {
    lines.push('*No open tasks in backlog.*');
  } else {
    for (const t of goalTasks) {
      const isReady = t.status === 'todo' && t.depends_on.every((d) => doneIds.has(d));
      const statusLabel =
        t.status === 'blocked'
          ? `Blocked (${t.blocked_reason ?? 'unknown'})`
          : isReady
            ? 'Ready'
            : 'Pending Dependencies';
      lines.push(`- **[${t.id}]** \`${t.title}\` (${statusLabel})`);
      if (t.verify_command) {
        lines.push(`  - Verify: \`${t.verify_command}\``);
      }
      if (t.depends_on.length > 0) {
        lines.push(`  - Depends: ${t.depends_on.join(', ')}`);
      }
      if (t.proposals && t.proposals.length > 0) {
        lines.push(
          `  - Proposals (${t.proposals.length}): ${t.proposals.map((p) => `"${p.content.slice(0, 60)}"`).join(', ')}`
        );
      }
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Zone 2: Soft Staking
  lines.push('## ⚡ Zone 2: Soft Staking (Leased Explorations)');
  lines.push('*Tasks currently claimed under TTL lease (300s). Preemptible if expired.*');
  if (stakedTasks.length === 0) {
    lines.push('*No active explorations staked.*');
  } else {
    for (const t of stakedTasks) {
      let secondsLeft = 0;
      if (t.lease_expires_at) {
        secondsLeft = Math.max(0, Math.round((Date.parse(t.lease_expires_at) - now) / 1000));
      }
      lines.push(`- **[${t.id}]** \`${t.title}\``);
      lines.push(
        `  - Staked by: \`${t.claimed_by ?? 'unknown'}\` | Lease: ${secondsLeft}s left (expires: ${t.lease_expires_at ?? 'none'})`
      );
      if (t.claim_reason) {
        lines.push(`  - Approach: "${t.claim_reason}"`);
      }
      if (t.progress_log && t.progress_log.length > 0) {
        const last = t.progress_log[t.progress_log.length - 1];
        lines.push(`  - Latest Progress: "${last.message}" (${last.agent})`);
      }
      if (t.challenges && t.challenges.length > 0) {
        lines.push(`  - Active Challenges: ${t.challenges.length}`);
      }
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Zone 3: Verified Artifacts
  lines.push('## 🏆 Zone 3: Verified Artifacts (Immutable Golden Facts)');
  lines.push('*Passed ground truth verification (Exit Code 0). Available for peer reuse.*');
  if (verifiedTasks.length === 0) {
    lines.push('*No verified artifacts published yet.*');
  } else {
    for (const t of verifiedTasks) {
      const verif = t.verification;
      const cmd = verif?.command ?? 'passed';
      const patch = verif?.patch ? ` | Artifact: \`${verif.patch}\`` : '';
      const commitSha = verif?.commitSha || verif?.commit;
      const commit = commitSha ? ` | Commit: \`${commitSha.slice(0, 7)}\`` : '';
      lines.push(`- **[${t.id}]** \`${t.title}\``);
      lines.push(
        `  - Verified by: \`${verif?.verifiedBy ?? t.completed_by ?? 'unknown'}\` at ${verif?.verifiedAt ?? t.completed_at ?? 'unknown'} | Gate: \`${cmd}\` (Exit: 0)${patch}${commit}`
      );
      if (t.summary) {
        lines.push(`  - Summary: "${t.summary}"`);
      }
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Zone 4: Graveyard & Dead Ends
  lines.push('## 🪦 Zone 4: Graveyard & Dead Ends (Fast Pruned Paths)');
  lines.push('*Refuted hypotheses & fatal error stacks. DO NOT REPEAT.*');
  if (graveyardTasks.length === 0) {
    lines.push('*Graveyard is empty.*');
  } else {
    for (const t of graveyardTasks) {
      const lastFailure = t.last_verification_failure;
      const deRecord =
        t.dead_ends && t.dead_ends.length > 0 ? t.dead_ends[t.dead_ends.length - 1] : undefined;
      const agent = deRecord?.agent ?? lastFailure?.agent ?? 'unknown';
      const reason = t.dead_end_reason ?? deRecord?.reason ?? 'Hypothesis refuted';
      const prunedAt = t.dead_end_at ?? deRecord?.timestamp ?? t.updated_at;
      const attempts = t.verification_attempts ?? 3;

      lines.push(`- **[${t.id}]** \`${t.title}\``);
      lines.push(`  - Pruned at: ${prunedAt} by \`${agent}\` (Failed ${attempts} attempts)`);
      lines.push(`  - Refuted Reason: "${reason}"`);
      if (lastFailure?.output) {
        const errorExcerpt = lastFailure.output.slice(0, 180).replace(/\n/g, ' ');
        lines.push(`  - Error Snippet: \`${errorExcerpt}...\``);
      }
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Write single-file CQRS projection to BLACKBOARD.md at project root.
 */
export function writeBlackboard(cwd: string, sessionId: string): string {
  const content = generateBlackboard(cwd, sessionId);
  const targetPath = path.join(cwd, 'BLACKBOARD.md');
  try {
    fs.writeFileSync(targetPath, content, 'utf-8');
  } catch {
    // Best-effort write
  }
  return content;
}
