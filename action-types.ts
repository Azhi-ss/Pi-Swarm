export interface TaskEvidence {
  commits?: string[];
  tests?: string[];
  prs?: string[];
}

export interface MessengerActionParams {
  // Action
  action?: string;
  goal?: string;
  runId?: string;
  maxSteps?: number;
  concurrency?: number;
  demandFill?: boolean;

  // Task IDs
  id?: string;
  taskId?: string;

  // Task creation & lifecycle
  title?: string;
  content?: string;
  dependsOn?: string[];
  alternativeOf?: string;
  summary?: string;
  evidence?: TaskEvidence;
  cascade?: boolean;
  verify?: string;
  ttl?: number;

  // Generic text payloads
  prompt?: string;
  message?: string;
  reason?: string;

  // Coordination
  self?: boolean;
  to?: string | string[];
  replyTo?: string;
  paths?: string[];
  name?: string;
  channel?: string;
  create?: boolean;
  limit?: number;
  autoRegisterPath?: 'add' | 'remove' | 'list';
  spec?: string; // Spec file path for join action

  // Channels
  showAll?: boolean;

  // Spawn
  role?: string;
  persona?: string;
  objective?: string;
  context?: string;
  model?: string;
  agentFile?: string;
  messageFile?: string;
  force?: boolean;

  // Process / Watchdog
  all?: boolean;
  workerId?: string;
  lines?: number;
}
