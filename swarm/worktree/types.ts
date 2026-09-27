export interface WorktreeInfo {
  agentId: string;
  agentName?: string;
  worktreePath: string;
  slot: number;
  port: number;
  testPort: number;
  tmpDir: string;
  isGitWorktree: boolean;
}

export interface WorktreeManager {
  allocate(projectRoot: string, agentId: string): Promise<WorktreeInfo> | WorktreeInfo;
  release(projectRoot: string, info: WorktreeInfo | string): Promise<void> | void;
  prune(projectRoot: string): void;
}

export interface PortSlot {
  slot: number;
  port: number;
  testPort: number;
}
