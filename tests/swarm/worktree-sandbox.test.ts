import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorktree,
  removeWorktree,
  pruneWorktrees,
  isGitRepo,
  getWorktreeInfo,
  clearAllWorktrees,
} from '../../swarm/worktree/manager.js';
import { portSlotManager } from '../../swarm/worktree/ports.js';
import { taskDone } from '../../swarm/handlers/task-lifecycle.js';
import * as taskStore from '../../swarm/task-store.js';
import { startRun } from '../../swarm/run-store.js';
import { resolveProjectContext } from '../../project.js';

const tempDirs = new Set<string>();

function createTempDir(prefix: string = 'worktree-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  cp.spawnSync('git init -b main', { cwd: dir, shell: true });
  cp.spawnSync('git config user.name "Test User"', { cwd: dir, shell: true });
  cp.spawnSync('git config user.email "test@example.com"', { cwd: dir, shell: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Project\n', 'utf-8');
  cp.spawnSync('git add .', { cwd: dir, shell: true });
  cp.spawnSync('git commit -m "initial commit"', { cwd: dir, shell: true });
}

describe('Module 7: Dedicated Worktree Sandbox', () => {
  beforeEach(() => {
    clearAllWorktrees();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        pruneWorktrees(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    tempDirs.clear();
    clearAllWorktrees();
  });

  it('detects git repositories accurately', () => {
    const gitDir = createTempDir('git-repo-');
    initGitRepo(gitDir);
    expect(isGitRepo(gitDir)).toBe(true);

    const nonGitDir = createTempDir('non-git-');
    expect(isGitRepo(nonGitDir)).toBe(false);
  });

  it('allocates detached worktree without creating any new git branches', () => {
    const gitDir = createTempDir('worktree-alloc-');
    initGitRepo(gitDir);

    const branchesBefore = cp
      .spawnSync('git branch', { cwd: gitDir, shell: true, encoding: 'utf-8' })
      .stdout.trim()
      .split('\n')
      .map((b) => b.trim());

    const agentId = 'worker-1';
    const agentName = 'AgentOne';
    const info = createWorktree(gitDir, agentId, agentName);

    expect(info.isGitWorktree).toBe(true);
    expect(info.worktreePath).toBe(path.join(gitDir, '.swarm', 'workspaces', `worker-${agentId}`));
    expect(fs.existsSync(info.worktreePath)).toBe(true);
    expect(info.slot).toBe(0);
    expect(info.port).toBe(3100);
    expect(info.testPort).toBe(3200);

    // Verify lookup by id or name
    expect(getWorktreeInfo(agentId)?.worktreePath).toBe(info.worktreePath);
    expect(getWorktreeInfo(agentName)?.worktreePath).toBe(info.worktreePath);

    // Verify 0 branch pollution (branches must remain identical)
    const branchesAfter = cp
      .spawnSync('git branch', { cwd: gitDir, shell: true, encoding: 'utf-8' })
      .stdout.trim()
      .split('\n')
      .map((b) => b.trim());

    expect(branchesAfter).toEqual(branchesBefore);

    // Clean up
    removeWorktree(gitDir, agentId);
    expect(fs.existsSync(info.worktreePath)).toBe(false);
    expect(getWorktreeInfo(agentId)).toBeUndefined();
  });

  it('creates symlink for node_modules and cleans up without deleting host node_modules', () => {
    const gitDir = createTempDir('worktree-symlink-');
    initGitRepo(gitDir);

    // Create host dummy node_modules
    const hostNodeModules = path.join(gitDir, 'node_modules');
    fs.mkdirSync(hostNodeModules, { recursive: true });
    fs.writeFileSync(path.join(hostNodeModules, 'dummy-pkg.txt'), 'host package content', 'utf-8');

    const agentId = 'worker-symlink';
    const info = createWorktree(gitDir, agentId);

    const worktreeNodeModules = path.join(info.worktreePath, 'node_modules');
    expect(fs.existsSync(worktreeNodeModules)).toBe(true);
    const lstat = fs.lstatSync(worktreeNodeModules);
    expect(lstat.isSymbolicLink()).toBe(true);

    // Read through symlink
    expect(fs.readFileSync(path.join(worktreeNodeModules, 'dummy-pkg.txt'), 'utf-8')).toBe(
      'host package content'
    );

    // Remove worktree
    removeWorktree(gitDir, agentId);

    // Verify host node_modules was NEVER deleted
    expect(fs.existsSync(hostNodeModules)).toBe(true);
    expect(fs.existsSync(path.join(hostNodeModules, 'dummy-pkg.txt'))).toBe(true);
  });

  it('isolates concurrent workers in separate worktrees with separate ports and files', () => {
    const gitDir = createTempDir('worktree-concurrency-');
    initGitRepo(gitDir);

    const infoA = createWorktree(gitDir, 'worker-a', 'AgentA');
    const infoB = createWorktree(gitDir, 'worker-b', 'AgentB');

    expect(infoA.worktreePath).not.toBe(infoB.worktreePath);
    expect(infoA.port).not.toBe(infoB.port);
    expect(infoA.testPort).not.toBe(infoB.testPort);
    expect(infoA.tmpDir).not.toBe(infoB.tmpDir);

    // Worker A creates a file
    fs.writeFileSync(path.join(infoA.worktreePath, 'worker-a-secret.txt'), 'hello a', 'utf-8');

    // Worker B and host should not see worker A's file
    expect(fs.existsSync(path.join(infoB.worktreePath, 'worker-a-secret.txt'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'worker-a-secret.txt'))).toBe(false);

    // Clean up both
    removeWorktree(gitDir, infoA);
    removeWorktree(gitDir, infoB);
  });

  it('gracefully degrades to projectRoot in non-git environments', () => {
    const nonGitDir = createTempDir('non-git-fallback-');
    const agentId = 'worker-fallback';
    const info = createWorktree(nonGitDir, agentId);

    expect(info.isGitWorktree).toBe(false);
    expect(info.worktreePath).toBe(nonGitDir);
    expect(info.port).toBe(3100);

    // Release works without error
    expect(() => removeWorktree(nonGitDir, agentId)).not.toThrow();

    fs.mkdirSync(path.join(nonGitDir, '.pi'));
    expect(resolveProjectContext({ cwd: nonGitDir })).toBe(fs.realpathSync(nonGitDir));
    expect(fs.existsSync(path.join(nonGitDir, '.git'))).toBe(false);
  });

  it('integrates with taskDone: executes verification and extracts diff patch from worktree', () => {
    const gitDir = createTempDir('worktree-verifier-');
    initGitRepo(gitDir);

    const sessionId = 'test-session-worktree-verifier';
    const agentName = 'VerifiedAgent';
    const agentId = 'worker-verif-1';

    // Set up package.json with a test script in repo
    fs.writeFileSync(
      path.join(gitDir, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'utf-8'
    );
    cp.spawnSync('git add .', { cwd: gitDir, shell: true });
    cp.spawnSync('git commit -m "add package.json"', { cwd: gitDir, shell: true });

    // Allocate worktree for agent
    const worktreeInfo = createWorktree(gitDir, agentId, agentName);

    // Create a task on blackboard
    const task = taskStore.createTask(
      gitDir,
      sessionId,
      { title: 'Fix issue in sandbox' },
      'default'
    );
    taskStore.claimTask(gitDir, sessionId, task.id, agentName);

    // Agent modifies a file inside its worktree sandbox
    fs.writeFileSync(
      path.join(worktreeInfo.worktreePath, 'feature.js'),
      'module.exports = 42;\n',
      'utf-8'
    );

    // Host workspace should remain untouched
    expect(fs.existsSync(path.join(gitDir, 'feature.js'))).toBe(false);

    // Agent calls task done
    const res = taskDone(
      { id: task.id, summary: 'Fixed in worktree' } as any,
      { agentName } as any,
      gitDir,
      'default',
      sessionId
    );

    expect(res.details.verified).toBe(true);
    expect(res.details.patch).toBeDefined();

    // Verify patch was created in host artifacts directory
    const hostPatchPath = path.join(gitDir, res.details.patch as string);
    expect(fs.existsSync(hostPatchPath)).toBe(true);
    const patchContent = fs.readFileSync(hostPatchPath, 'utf-8');
    expect(patchContent).toContain('feature.js');

    // Clean up
    removeWorktree(gitDir, agentId);
  });

  function git(cwd: string, args: string): string {
    return cp.execSync(`git ${args}`, { cwd, encoding: 'utf-8' });
  }

  function hostChanges(cwd: string): string[] {
    return git(cwd, 'status --porcelain --untracked-files=all').split('\n').filter(Boolean);
  }

  it('keeps Sandboxes and runtime data out of the host Git status', () => {
    const repo = createTempDir('worktree-host-clean-');
    initGitRepo(repo);
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'test-pkg', scripts: { test: 'node -e "process.exit(0)"' } })
    );
    fs.mkdirSync(path.join(repo, '.pi'));
    fs.writeFileSync(path.join(repo, '.pi', 'pi-messenger.json'), '{}\n');
    git(repo, 'add .');
    git(repo, 'commit -m "add package.json"');
    // A subdirectory Project and a template-less repo exercise anchoring and a missing info/exclude.
    fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Edited by the human\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'mine\n');
    fs.writeFileSync(path.join(repo, '.pi', 'pi-messenger.json'), '{ "edited": true }\n');
    const nested = path.join(repo, 'packages', 'app');
    fs.mkdirSync(path.join(nested, '.pi'), { recursive: true });
    const userChanges = [' M .pi/pi-messenger.json', ' M README.md', '?? notes.txt'];

    const project = resolveProjectContext({ cwd: repo });
    const sessionId = startRun(project, { goal: 'keep host clean', delegator: 'Delegator' }).id;
    const info = createWorktree(project, 'worker-clean', 'CleanAgent');
    const task = taskStore.createTask(project, sessionId, { title: 'Sandbox work' }, 'default');
    taskStore.claimTask(project, sessionId, task.id, 'CleanAgent');
    expect(hostChanges(repo)).toEqual(userChanges);

    fs.writeFileSync(path.join(info.worktreePath, 'feature.js'), 'module.exports = 42;\n');
    const res = taskDone(
      { id: task.id, summary: 'Done in sandbox' } as any,
      { agentName: 'CleanAgent' } as any,
      project,
      'default',
      sessionId
    );
    expect(res.details.verified).toBe(true);
    expect(fs.existsSync(path.join(project, res.details.patch as string))).toBe(true);
    expect(fs.existsSync(path.join(project, 'BLACKBOARD.md'))).toBe(true);
    expect(hostChanges(repo)).toEqual(userChanges);

    const nestedProject = resolveProjectContext({ cwd: nested });
    resolveProjectContext({ cwd: nested });
    startRun(nestedProject, { goal: 'nested', delegator: 'Delegator' });
    fs.writeFileSync(path.join(nested, 'BLACKBOARD.md'), '# board\n');
    fs.writeFileSync(path.join(nested, '.pi', 'pi-messenger.json'), '{}\n');
    expect(hostChanges(repo)).toEqual([...userChanges, '?? packages/app/.pi/pi-messenger.json']);

    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude.split('\n').filter((line) => line.includes('.swarm/'))).toHaveLength(2);

    git(repo, 'add -A');
    expect(git(repo, 'diff --cached --name-only').split('\n').filter(Boolean)).toEqual([
      '.pi/pi-messenger.json',
      'README.md',
      'notes.txt',
      'packages/app/.pi/pi-messenger.json',
    ]);

    removeWorktree(project, info);
  });
});
