export type SwarmTaskStatus =
  | 'todo'
  | 'staked'
  | 'in_progress'
  | 'verified'
  | 'done'
  | 'dead_end'
  | 'blocked'
  | 'archived'
  | 'superseded';

export interface SwarmTaskEvidence {
  commits?: string[];
  tests?: string[];
  prs?: string[];
}

export interface SwarmTaskVerification {
  verifiedAt: string;
  verifiedBy: string;
  command: string;
  exitCode: number;
  patch?: string;
  outputSnippet?: string;
  commitSha?: string;
  commit?: string;
  patchSha?: string;
}

export interface SwarmTaskDeadEndRecord {
  id: string;
  agent: string;
  reason: string;
  errorLog?: string;
  timestamp: string;
}

export interface TaskProposalRecord {
  id: string;
  agent: string;
  content: string;
  timestamp: string;
}
export type TaskProposal = TaskProposalRecord;

export interface TaskChallengeRecord {
  id: string;
  agent: string;
  content: string;
  timestamp: string;
  targetClaimant?: string;
}
export type TaskChallenge = TaskChallengeRecord;

export interface SwarmTask {
  id: string;
  title: string;
  status: SwarmTaskStatus;
  depends_on: string[];
  created_at: string;
  updated_at: string;
  created_by?: string;
  claimed_by?: string;
  claimed_at?: string;
  claim_reason?: string;
  completed_by?: string;
  completed_at?: string;
  summary?: string;
  evidence?: SwarmTaskEvidence;
  blocked_reason?: string;
  blocked_by?: string;
  attempt_count: number;
  channel?: string;
  archived_at?: string;
  progress_log?: Array<{ timestamp: string; agent: string; message: string }>;
  proposals?: TaskProposalRecord[];
  challenges?: TaskChallengeRecord[];

  // Module 3 & 4 additions
  verify_command?: string;
  lease_ttl?: number; // Lease duration in seconds (default 300)
  lease_expires_at?: string; // ISO timestamp
  verification?: SwarmTaskVerification;
  dead_ends?: SwarmTaskDeadEndRecord[];
  dead_end_reason?: string;
  dead_end_at?: string;
  /** Root task id of this hypothesis's Alternative Group. Absent on the root itself. */
  alternative_of?: string;
  verification_attempts?: number;
  last_verification_failure?: {
    timestamp: string;
    agent: string;
    command: string;
    exitCode: number;
    output: string;
  };
}

export interface SwarmTaskCreateInput {
  title: string;
  content?: string;
  dependsOn?: string[];
  createdBy?: string;
  channel?: string;
  verifyCommand?: string;
  leaseTtl?: number;
  /** Join this task's Alternative Group. A member pointer is stored as the group root. */
  alternativeOf?: string;
}

export interface SwarmSummary {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  blocked: number;
  staked?: number;
  verified?: number;
  dead_end?: number;
}

export interface SpawnRequest {
  model?: string;
  role?: string;
  persona?: string;
  objective?: string;
  message?: string; // Alias for objective
  context?: string;
  taskId?: string;
  name?: string;
  agentFile?: string; // Path to markdown file (with YAML frontmatter) to use as system prompt
  /** Peers launched together. When >= 2, the system prompt names the other partners. */
  cohort?: number;
}

export interface SpawnedAgent {
  id: string;
  cwd: string;
  name: string;
  role: string;
  model?: string;
  persona?: string;
  objective: string;
  context?: string;
  taskId?: string;
  systemPrompt?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  /** Last tool start or finish. Idle recovery uses this, not process age. */
  lastActiveAt?: string;
  /** A tool call is in flight, so a long evaluation is not idle. */
  toolBusy?: boolean;
  endedAt?: string;
  exitCode?: number;
  error?: string;
  sessionId?: string;
  pid?: number;
  worktreePath?: string;
  baseCommit?: string;
  stopRequested?: boolean;
  /** Candidate preservation failed, so the Sandbox was kept for repair. */
  sandboxRetained?: boolean;
  port?: number;
  testPort?: number;
}
