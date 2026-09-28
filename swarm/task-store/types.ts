import type { SwarmTaskEvidence } from '../types.js';

export type TaskEventType =
  | 'created'
  | 'claimed'
  | 'staked'
  | 'renewed'
  | 'released'
  | 'progress'
  | 'completed'
  | 'verified'
  | 'dead_end'
  | 'verification_failed'
  | 'blocked'
  | 'unblocked'
  | 'reset'
  | 'archived'
  | 'proposed'
  | 'challenged'
  | 'swarm.abort';

export interface SwarmAbortPayload {
  reason?: string;
  consumedSteps?: number;
  maxSteps?: number;
}

export interface TaskEvent {
  taskId: string;
  type: TaskEventType;
  timestamp: string;
  agent?: string; // Who performed the action
  channel?: string; // Original channel (for reference)
  payload?: unknown; // Type-specific data
}

// Event payloads
export interface CreatedPayload {
  title: string;
  content?: string;
  dependsOn?: string[];
  createdBy?: string;
  verifyCommand?: string;
}

export interface StakedPayload {
  ttl?: number; // Lease duration in seconds (default 300)
  proposalId?: string;
  reason?: string;
}

export interface RenewedPayload {
  ttl?: number;
  reason?: string;
}

export interface VerifiedPayload {
  summary: string;
  command: string;
  exitCode: number; // 0
  patch?: string; // Path to .patch file
  evidence?: SwarmTaskEvidence;
  outputSnippet?: string;
  commitSha?: string;
  commit?: string;
  patchSha?: string;
}

export interface VerificationFailedPayload {
  agent: string;
  attempt: number;
  maxAttempts: number;
  command: string;
  exitCode: number;
  output: string;
}

export interface DeadEndPayload {
  agent: string;
  reason: string;
  hypothesis?: string;
  attempts: number;
  lastCommand: string;
  lastOutput: string;
  failureSummary?: string;
  refutedProposalId?: string;
}

export interface ClaimedPayload {
  previousAgent?: string;
  reason?: string;
}

export interface ProgressPayload {
  message: string;
  tokens?: number;
  toolCalls?: number;
}

export interface CompletedPayload {
  summary: string;
  evidence?: SwarmTaskEvidence;
}

export interface BlockedPayload {
  reason: string;
  blockedBy?: string;
}

export interface ProposedPayload {
  proposal: string;
  author?: string;
}

export interface ChallengedPayload {
  objection: string;
  challenger?: string;
  targetClaimant?: string;
}
