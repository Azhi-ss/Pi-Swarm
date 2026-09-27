import type { SwarmTask } from '../types.js';

export interface WatchdogConfig {
  pollIntervalMs?: number; // default: 5000ms
  leaseTtlSeconds?: number; // default: 300s
  maxVerificationAttempts?: number; // default: 3
}

export interface ReclaimResult {
  reclaimedCount: number;
  reclaimedTasks: string[];
}

export interface AllDeadStatus {
  isAllDead: boolean;
  deadEndTasks: SwarmTask[];
  runningWorkerCount: number;
  fallbackTriggered: boolean;
  briefMarkdown?: string;
}

export type SteerSender = (payload: {
  customType: string;
  content: string;
  display?: boolean;
  details?: unknown;
}) => void | Promise<void>;
