import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { afterEach } from 'vitest';
import {
  createWorktree,
  removeWorktree,
  pruneWorktrees,
  clearAllWorktrees,
  isGitRepo,
} from '../../swarm/worktree/manager.js';
import type { WorktreeInfo } from '../../swarm/worktree/types.js';

export interface CreateTestGitRepoOptions {
  prefix?: string;
  userName?: string;
  userEmail?: string;
  initialCommitMessage?: string;
  withPackageJson?: boolean;
  testScript?: string;
  initialFiles?: Record<string, string>;
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
}

export interface ConflictScenarioResult {
  sandbox: WorktreeInfo;
  relPath: string;
  hostFile: string;
  sandboxFile: string;
  baseContent: string;
  hostContent: string;
  sandboxContent: string;
}

export interface TestGitRepo {
  gitDir: string;
  createFile: (relPath: string, content: string, commitMsg?: string) => string;
  allocateSandbox: (agentId: string, agentName?: string) => WorktreeInfo;
  writeSandboxFile: (sandbox: WorktreeInfo, relPath: string, content: string) => string;
  removeSandbox: (agentId: string) => void;
  createConflictScenario: (options: {
    relPath: string;
    baseContent: string;
    hostContent: string;
    sandboxContent: string;
    agentId?: string;
    agentName?: string;
  }) => ConflictScenarioResult;
  getLatestCommit: (cwd?: string) => CommitInfo;
  getCommitLog: (count?: number, cwd?: string) => CommitInfo[];
  isClean: (cwd?: string) => boolean;
  runGit: (
    cmdOrArgs: string | string[],
    cwd?: string
  ) => { status: number; stdout: string; stderr: string };
  cleanup: () => void;
}

const activeTestRepos = new Set<TestGitRepo>();
const activeNonGitDirs = new Set<string>();

/**
 * Creates an isolated, fully initialized real Git repository for testing.
 * Automatically cleans up sandboxes and temporary files after each test.
 */
export function createTestGitRepo(options: CreateTestGitRepoOptions = {}): TestGitRepo {
  const prefix = options.prefix ?? 'pi-swarm-git-test-';
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sandboxes: string[] = [];

  const userName = options.userName ?? 'Pi Tester';
  const userEmail = options.userEmail ?? 'tester@pi-swarm.local';
  const initialCommitMessage = options.initialCommitMessage ?? 'chore: initial commit';
  const withPackageJson = options.withPackageJson !== false;
  const testScript = options.testScript ?? 'node -e "process.exit(0)"';

  // 1. Initialize Git repository on main branch
  const initRes = cp.spawnSync('git init -b main', { cwd: gitDir, shell: true });
  if (initRes.status !== 0) {
    cp.spawnSync('git init', { cwd: gitDir, shell: true });
    cp.spawnSync('git checkout -b main', { cwd: gitDir, shell: true });
  }

  // 2. Set local user config so commits succeed regardless of global git config
  cp.spawnSync(`git config user.name "${userName}"`, { cwd: gitDir, shell: true });
  cp.spawnSync(`git config user.email "${userEmail}"`, { cwd: gitDir, shell: true });

  // 3. Write standard .gitignore to isolate .swarm and .pi/messenger artifacts
  const gitignorePath = path.join(gitDir, '.gitignore');
  fs.writeFileSync(
    gitignorePath,
    'node_modules/\n.pi/messenger/\n.swarm/workspaces/\n.swarm/patches/\n*.patch\n',
    'utf-8'
  );

  // 4. Write initial files
  if (options.initialFiles) {
    for (const [relPath, content] of Object.entries(options.initialFiles)) {
      const fullPath = path.join(gitDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
    }
  }

  if (withPackageJson) {
    const pkgPath = path.join(gitDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            name: 'test-project',
            version: '1.0.0',
            scripts: {
              test: testScript,
            },
          },
          null,
          2
        ),
        'utf-8'
      );
    }
  }

  const readmePath = path.join(gitDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, '# Test Swarm Project\n', 'utf-8');
  }

  // 5. Create initial commit to establish HEAD
  cp.spawnSync('git add .', { cwd: gitDir, shell: true });
  cp.spawnSync(`git commit -m "${initialCommitMessage}"`, { cwd: gitDir, shell: true });

  const createFile = (relPath: string, content: string, commitMsg?: string): string => {
    const fullPath = path.join(gitDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    if (commitMsg) {
      cp.spawnSync(`git add "${relPath}"`, { cwd: gitDir, shell: true });
      cp.spawnSync(`git commit -m "${commitMsg}"`, { cwd: gitDir, shell: true });
    }
    return fullPath;
  };

  const allocateSandbox = (agentId: string, agentName?: string): WorktreeInfo => {
    sandboxes.push(agentId);
    return createWorktree(gitDir, agentId, agentName);
  };

  const writeSandboxFile = (sandbox: WorktreeInfo, relPath: string, content: string): string => {
    const fullPath = path.join(sandbox.worktreePath, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return fullPath;
  };

  const removeSandbox = (agentId: string): void => {
    try {
      removeWorktree(gitDir, agentId);
    } catch {
      // Ignore
    }
    const idx = sandboxes.indexOf(agentId);
    if (idx !== -1) {
      sandboxes.splice(idx, 1);
    }
  };

  const createConflictScenario = (opts: {
    relPath: string;
    baseContent: string;
    hostContent: string;
    sandboxContent: string;
    agentId?: string;
    agentName?: string;
  }): ConflictScenarioResult => {
    const agentId = opts.agentId ?? 'worker-conflict';
    const agentName = opts.agentName ?? 'ConflictAgent';

    // 1. Establish base version on main
    createFile(opts.relPath, opts.baseContent, `chore: base ${opts.relPath}`);

    // 2. Allocate detached worktree sandbox at this base HEAD
    const sandbox = allocateSandbox(agentId, agentName);

    // 3. Evolve main on host with hostContent
    const hostFile = createFile(
      opts.relPath,
      opts.hostContent,
      `feat(host): modify ${opts.relPath}`
    );

    // 4. Modify same file differently in sandbox without committing
    const sandboxFile = writeSandboxFile(sandbox, opts.relPath, opts.sandboxContent);

    return {
      sandbox,
      relPath: opts.relPath,
      hostFile,
      sandboxFile,
      baseContent: opts.baseContent,
      hostContent: opts.hostContent,
      sandboxContent: opts.sandboxContent,
    };
  };

  const runGit = (
    cmdOrArgs: string | string[],
    cwd: string = gitDir
  ): { status: number; stdout: string; stderr: string } => {
    let res: cp.SpawnSyncReturns<string>;
    if (Array.isArray(cmdOrArgs)) {
      res = cp.spawnSync('git', cmdOrArgs, { cwd, encoding: 'utf-8' });
    } else {
      res = cp.spawnSync(`git ${cmdOrArgs}`, { cwd, shell: true, encoding: 'utf-8' });
    }
    return {
      status: res.status ?? (res.error ? 1 : 0),
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  };

  const getLatestCommit = (cwd: string = gitDir): CommitInfo => {
    // Format: Hash, AuthorName, AuthorEmail, AuthorDate(ISO), Body
    const sep = '---COMMITSPLIT---';
    const res = runGit(['log', '-1', `--pretty=format:%H${sep}%an${sep}%ae${sep}%aI${sep}%B`], cwd);
    const parts = res.stdout.split(sep);
    return {
      sha: parts[0]?.trim() ?? '',
      authorName: parts[1]?.trim() ?? '',
      authorEmail: parts[2]?.trim() ?? '',
      timestamp: parts[3]?.trim() ?? '',
      message: parts[4] ?? '',
    };
  };

  const getCommitLog = (count: number = 10, cwd: string = gitDir): CommitInfo[] => {
    const sep = '---COMMITSPLIT---';
    const entrySep = '---ENTRYEND---';
    const res = runGit(
      ['log', `-n`, `${count}`, `--pretty=format:%H${sep}%an${sep}%ae${sep}%aI${sep}%B${entrySep}`],
      cwd
    );
    const entries = res.stdout.split(entrySep).filter((e) => e.trim().length > 0);
    return entries.map((entry) => {
      const parts = entry.trim().split(sep);
      return {
        sha: parts[0]?.trim() ?? '',
        authorName: parts[1]?.trim() ?? '',
        authorEmail: parts[2]?.trim() ?? '',
        timestamp: parts[3]?.trim() ?? '',
        message: parts[4] ?? '',
      };
    });
  };

  const isClean = (cwd: string = gitDir): boolean => {
    const res = runGit(['status', '--porcelain'], cwd);
    return res.stdout.trim().length === 0;
  };

  const cleanup = (): void => {
    for (const id of sandboxes) {
      try {
        removeWorktree(gitDir, id);
      } catch {
        // Ignore
      }
    }
    sandboxes.length = 0;
    try {
      pruneWorktrees(gitDir);
    } catch {
      // Ignore
    }
    try {
      fs.rmSync(gitDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    activeTestRepos.delete(repo);
  };

  const repo: TestGitRepo = {
    gitDir,
    createFile,
    allocateSandbox,
    writeSandboxFile,
    removeSandbox,
    createConflictScenario,
    getLatestCommit,
    getCommitLog,
    isClean,
    runGit,
    cleanup,
  };

  activeTestRepos.add(repo);
  return repo;
}

/**
 * Creates an isolated non-git temporary directory for fallback and regression testing.
 */
export function createNonGitDir(prefix: string = 'pi-swarm-nongit-'): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  activeNonGitDirs.add(dir);
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    activeNonGitDirs.delete(dir);
  };
  return { dir, cleanup };
}

afterEach(() => {
  for (const repo of Array.from(activeTestRepos)) {
    try {
      repo.cleanup();
    } catch {
      // Ignore cleanup error
    }
  }
  activeTestRepos.clear();

  for (const dir of Array.from(activeNonGitDirs)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
  activeNonGitDirs.clear();
  clearAllWorktrees();
});
