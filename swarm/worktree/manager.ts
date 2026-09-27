import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import type { WorktreeInfo } from './types.js';
import { portSlotManager } from './ports.js';

const activeWorktrees = new Map<string, WorktreeInfo>();
const nameToId = new Map<string, string>();

/**
 * Safely retrieves spawnSync even if node:child_process was partially mocked in test environments.
 */
function getSpawnSync(): typeof cp.spawnSync | null {
  try {
    const fn = (cp as any).spawnSync;
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

/**
 * Checks whether the given directory is inside a valid git repository with a resolvable HEAD.
 */
export function isGitRepo(projectRoot: string): boolean {
  const spawnSync = getSpawnSync();
  if (!spawnSync) return false;

  try {
    const checkTree = spawnSync('git rev-parse --is-inside-work-tree', {
      cwd: projectRoot,
      shell: true,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (checkTree.status !== 0 || checkTree.stdout.trim() !== 'true') {
      return false;
    }

    const checkHead = spawnSync('git rev-parse --verify HEAD', {
      cwd: projectRoot,
      shell: true,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return checkHead.status === 0;
  } catch {
    return false;
  }
}

/**
 * Creates an isolated physical git detached worktree sandbox for an agent.
 * Gracefully degrades to projectRoot if git is not available or directory is not a git repo.
 */
export function createWorktree(
  projectRoot: string,
  agentId: string,
  agentName?: string
): WorktreeInfo {
  const slotInfo = portSlotManager.allocate(agentId);
  const tmpDir = path.join(os.tmpdir(), `agent-${agentId}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // Best effort
  }

  if (agentName) {
    nameToId.set(agentName, agentId);
  }

  const spawnSync = getSpawnSync();
  if (!spawnSync || !isGitRepo(projectRoot)) {
    const fallbackInfo: WorktreeInfo = {
      agentId,
      agentName,
      worktreePath: projectRoot,
      slot: slotInfo.slot,
      port: slotInfo.port,
      testPort: slotInfo.testPort,
      tmpDir,
      isGitWorktree: false,
    };
    activeWorktrees.set(agentId, fallbackInfo);
    return fallbackInfo;
  }

  const workspacesDir = path.join(projectRoot, '.swarm', 'workspaces');
  const targetPath = path.join(workspacesDir, `worker-${agentId}`);

  try {
    fs.mkdirSync(workspacesDir, { recursive: true });

    // Clean up any stale registration or path if it already exists
    if (fs.existsSync(targetPath)) {
      try {
        spawnSync(`git worktree remove --force "${targetPath}"`, {
          cwd: projectRoot,
          shell: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        // Ignore
      }
      try {
        spawnSync('git worktree prune', {
          cwd: projectRoot,
          shell: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        // Ignore
      }
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
    }

    // Allocate detached worktree at HEAD
    const addRes = spawnSync(`git worktree add --detach "${targetPath}" HEAD`, {
      cwd: projectRoot,
      shell: true,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (addRes.status !== 0) {
      // If worktree creation failed, prune and fallback
      pruneWorktrees(projectRoot);
      const fallbackInfo: WorktreeInfo = {
        agentId,
        agentName,
        worktreePath: projectRoot,
        slot: slotInfo.slot,
        port: slotInfo.port,
        testPort: slotInfo.testPort,
        tmpDir,
        isGitWorktree: false,
      };
      activeWorktrees.set(agentId, fallbackInfo);
      return fallbackInfo;
    }

    // Symlink host node_modules using relative path to avoid file duplication
    const hostNodeModules = path.join(projectRoot, 'node_modules');
    const targetNodeModules = path.join(targetPath, 'node_modules');

    if (fs.existsSync(hostNodeModules)) {
      try {
        const relPath = path.relative(targetPath, hostNodeModules);
        fs.symlinkSync(
          relPath,
          targetNodeModules,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      } catch {
        // Non-fatal if symlink fails
      }
    }

    const info: WorktreeInfo = {
      agentId,
      agentName,
      worktreePath: targetPath,
      slot: slotInfo.slot,
      port: slotInfo.port,
      testPort: slotInfo.testPort,
      tmpDir,
      isGitWorktree: true,
    };

    activeWorktrees.set(agentId, info);
    return info;
  } catch {
    const fallbackInfo: WorktreeInfo = {
      agentId,
      agentName,
      worktreePath: projectRoot,
      slot: slotInfo.slot,
      port: slotInfo.port,
      testPort: slotInfo.testPort,
      tmpDir,
      isGitWorktree: false,
    };
    activeWorktrees.set(agentId, fallbackInfo);
    return fallbackInfo;
  }
}

/**
 * Removes an agent's worktree sandbox, safely unlinking node_modules,
 * executing git worktree remove --force, and cleaning up isolated TMPDIR and port slot.
 */
export function removeWorktree(projectRoot: string, infoOrAgentId: WorktreeInfo | string): void {
  let info: WorktreeInfo | undefined;
  let agentId: string;

  if (typeof infoOrAgentId === 'string') {
    agentId = infoOrAgentId;
    info = activeWorktrees.get(agentId);
  } else {
    info = infoOrAgentId;
    agentId = info.agentId;
  }

  const worktreePath =
    info?.worktreePath || path.join(projectRoot, '.swarm', 'workspaces', `worker-${agentId}`);
  const tmpDir = info?.tmpDir || path.join(os.tmpdir(), `agent-${agentId}`);
  const slot = info?.slot ?? portSlotManager.getSlot(agentId) ?? -1;
  const isGit = info?.isGitWorktree ?? fs.existsSync(path.join(worktreePath, '.git'));
  const spawnSync = getSpawnSync();

  // 1. Safely unlink node_modules (must never delete target host node_modules!)
  const targetNodeModules = path.join(worktreePath, 'node_modules');
  try {
    if (fs.existsSync(targetNodeModules)) {
      const stat = fs.lstatSync(targetNodeModules);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(targetNodeModules);
      }
    }
  } catch {
    // Ignore
  }

  // 2. Remove git worktree if applicable
  if (isGit && spawnSync) {
    try {
      spawnSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectRoot,
        shell: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // Ignore
    }
  }

  // 3. Clean up tmpDir
  try {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }

  // 4. Release port slot
  if (slot >= 0) {
    portSlotManager.release(slot);
  } else {
    portSlotManager.release(agentId);
  }

  // 5. If directory still exists and is NOT projectRoot, remove it
  try {
    if (worktreePath !== projectRoot && fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }

  if (info?.agentName) {
    nameToId.delete(info.agentName);
  }
  if (nameToId.has(agentId)) {
    nameToId.delete(agentId);
  }
  activeWorktrees.delete(agentId);
}

/**
 * Runs git worktree prune to clear stale registrations.
 */
export function pruneWorktrees(projectRoot: string): void {
  const spawnSync = getSpawnSync();
  if (!spawnSync) return;

  try {
    spawnSync('git worktree prune', {
      cwd: projectRoot,
      shell: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // Ignore
  }
}

export function getWorktreeInfo(idOrName: string): WorktreeInfo | undefined {
  const direct = activeWorktrees.get(idOrName);
  if (direct) return direct;
  const mappedId = nameToId.get(idOrName);
  if (mappedId) return activeWorktrees.get(mappedId);
  return undefined;
}

export function listActiveWorktrees(): WorktreeInfo[] {
  return Array.from(activeWorktrees.values());
}

export function clearAllWorktrees(): void {
  activeWorktrees.clear();
  nameToId.clear();
  portSlotManager.clear();
}
