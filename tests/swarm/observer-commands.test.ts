import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAction } from '../../router.js';
import * as taskStore from '../../swarm/task-store.js';
import { processManager, forceKillProcessGroup } from '../../swarm/process-manager.js';
import { circuitBreaker } from '../../swarm/circuit-breaker/index.js';
import {
  createContext,
  createMessengerFixture,
  createState,
  writeRegistration,
} from '../helpers/messenger-fixtures.js';
import { createTestGitRepo } from '../helpers/git-fixtures.js';
import { createWorktree, listActiveWorktrees } from '../../swarm/worktree/index.js';

const sessionId = 'observer-session';

function observer(cwd: string, contextSessionId = sessionId) {
  const state = createState('Observer', { contextSessionId });
  const dirs = {
    base: path.join(cwd, '.pi/messenger'),
    registry: path.join(cwd, '.pi/messenger/registry'),
  };
  return (action: string) =>
    executeAction(
      action,
      { action },
      state,
      dirs,
      createContext(cwd, sessionId),
      () => {},
      () => {}
    );
}

function populate(cwd: string) {
  taskStore.createTask(cwd, sessionId, { title: 'Ship parser' }, 'test-channel');
  const active = taskStore.createTask(cwd, sessionId, { title: 'Explore caching' }, 'test-channel');
  taskStore.stakeTask(cwd, sessionId, active.id, 'PeerA', { reason: 'Try bounded cache' });
  const verified = taskStore.createTask(cwd, sessionId, { title: 'Parse JSON' }, 'test-channel');
  taskStore.stakeTask(cwd, sessionId, verified.id, 'PeerB');
  expect(
    taskStore.verifyTask(cwd, sessionId, verified.id, 'PeerB', {
      command: 'npm test',
      exitCode: 0,
      summary: 'Parser passed',
      patch: 'parser.patch',
    })?.status
  ).toBe('verified');
  const dead = taskStore.createTask(cwd, sessionId, { title: 'Unbounded cache' }, 'test-channel');
  taskStore.deadEndTask(cwd, sessionId, dead.id, 'PeerC', {
    agent: 'PeerC',
    reason: 'Memory exhausted',
    attempts: 3,
  });
  return taskStore.writeBlackboard(cwd, sessionId);
}

afterEach(() => {
  processManager.clear();
  circuitBreaker.reset();
});

describe('observer commands', () => {
  it('preserves the displayed verified facts when a human abort has no session identity', async () => {
    const { cwd } = createMessengerFixture('observer-no-session-');
    populate(cwd);
    await observer(cwd, '')('abort');
    const brief = (await observer(cwd, '')('explain')).content[0].text;
    expect(brief).toMatch(/Completed milestones[\s\S]*Parse JSON[\s\S]*Active hypotheses/);
    expect(brief).toContain('LOCKED');
    expect(
      fs.readFileSync(path.join(cwd, '.pi/messenger/tasks', `${sessionId}.jsonl`), 'utf8')
    ).toContain('swarm.abort');
  });

  it('shows live project registry peers even when they were not spawned by the harness', async () => {
    const { cwd, dirs } = createMessengerFixture('observer-registry-');
    const { cwd: unrelated } = createMessengerFixture('observer-unrelated-');
    writeRegistration(dirs, {
      name: 'Observer',
      cwd: path.join(cwd, '.swarm/workspaces/worker-independent'),
      pid: process.pid,
    });
    writeRegistration(dirs, { name: 'UnrelatedPeer', cwd: unrelated, pid: process.pid });
    writeRegistration(dirs, { name: 'Human', cwd, pid: process.pid, isHuman: true });
    writeRegistration(dirs, { name: 'ExitedPeer', cwd, pid: 2147483647 });
    const res = await observer(cwd)('status');
    expect(res.content[0].text).toContain(`Observer · PID ${process.pid}`);
    expect(res.content[0].text).not.toContain('UnrelatedPeer');
    expect(res.content[0].text).not.toContain('Human');
    expect(res.content[0].text).not.toContain('ExitedPeer');
    expect(fs.existsSync(path.join(dirs.registry, 'ExitedPeer.json'))).toBe(true);
  });

  it('runs all three CLI commands without joining and cleans a peer recovered after a harness restart', async () => {
    const run = promisify(execFile);
    const { cwd: buildDir } = createMessengerFixture('observer-build-');
    const root = path.resolve(import.meta.dirname, '../..');
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(buildDir, 'node_modules'), 'dir');
    fs.copyFileSync(path.join(root, 'package.json'), path.join(buildDir, 'package.json'));
    await run(process.execPath, [
      createRequire(import.meta.url).resolve('typescript/bin/tsc'),
      '-p',
      path.join(root, 'tsconfig.build.json'),
      '--outDir',
      path.join(buildDir, 'dist'),
    ]);
    const repo = createTestGitRepo();
    const sandbox = repo.allocateSandbox('recovered-peer', 'RecoveredPeer');
    populate(repo.gitDir);
    const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: sandbox.worktreePath,
      detached: true,
      stdio: 'ignore',
    });
    const peerClosed = once(peer, 'exit');
    const agentsDir = path.join(repo.gitDir, '.pi/messenger/agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(repo.gitDir, '.pi/messenger/session-id'), sessionId);
    fs.writeFileSync(
      path.join(agentsDir, `${sessionId}.jsonl`),
      JSON.stringify({
        id: sandbox.agentId,
        type: 'spawned',
        timestamp: new Date().toISOString(),
        agent: {
          id: sandbox.agentId,
          name: 'RecoveredPeer',
          pid: peer.pid,
          cwd: repo.gitDir,
          sessionId,
          status: 'running',
          startedAt: new Date().toISOString(),
          worktreePath: sandbox.worktreePath,
        },
      }) + '\n'
    );
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const env = {
      ...process.env,
      PI_SWARM_PROJECT_ROOT: '',
      PI_AGENT_NAME: '',
      PI_AGENT_SESSION_ID: '',
      PI_MESSENGER_CHANNEL: '',
      PI_MESSENGER_PORT: String(port),
      PI_MESSENGER_CWD: repo.gitDir,
      PI_MESSENGER_DIR: '',
      PI_MESSENGER_GLOBAL: '0',
      PI_MESSENGER_LOG: path.join(buildDir, 'server.log'),
    };
    const server = spawn(process.execPath, [path.join(buildDir, 'dist/harness/server.js')], {
      cwd: repo.gitDir,
      env,
      stdio: 'ignore',
    });
    const serverClosed = once(server, 'exit');
    const cli = (...args: string[]) =>
      run(process.execPath, [path.join(buildDir, 'dist/harness/cli.js'), ...args], {
        cwd: repo.gitDir,
        env,
        timeout: 10_000,
      });
    try {
      await vi.waitFor(
        async () => expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true),
        { timeout: 10_000, interval: 50 }
      );
      expect((await cli('status')).stdout).toContain(`PID ${peer.pid}`);
      expect((await cli('explain')).stdout).toMatch(
        /Completed milestones[\s\S]*Parse JSON[\s\S]*Active hypotheses/
      );
      expect((await cli('abort', '--reason', 'Human stop')).stdout).toContain(
        'Swarm aborted: Human stop'
      );
      expect(await peerClosed).toEqual([null, 'SIGKILL']);
      expect(fs.existsSync(sandbox.worktreePath)).toBe(false);
      expect((await cli('status')).stdout).not.toContain(`PID ${peer.pid}`);
      expect((await cli('explain')).stdout).toContain('LOCKED');
      expect(fs.readdirSync(path.join(repo.gitDir, '.pi/messenger/registry'))).toEqual([]);
    } finally {
      forceKillProcessGroup(peer.pid!);
      server.kill('SIGTERM');
      await Promise.all([peerClosed, serverClosed]);
    }
  }, 30_000);

  it('admits less than 1000 bytes across all four zones even for oversized multilingual snapshots', async () => {
    const { cwd } = createMessengerFixture('observer-budget-');
    const markdown =
      '# Blackboard\n' +
      ['Goal', 'Soft Staking', 'Verified', 'Graveyard']
        .map(
          (name, index) =>
            `## Zone ${index + 1}: ${name}\n- ${name} ${'多字节证据🧪'.repeat(2000)}\n`
        )
        .join('\n');
    fs.writeFileSync(path.join(cwd, 'BLACKBOARD.md'), markdown);
    const res = await observer(cwd)('explain');
    const admitted = String(res.details.snapshot);
    expect(Buffer.byteLength(admitted)).toBeLessThan(1000);
    for (const name of ['Goal', 'Soft Staking', 'Verified', 'Graveyard'])
      expect(admitted).toContain(name);
    expect(admitted).toContain('[truncated]');
    expect(admitted).not.toContain('\ufffd');
    expect(res.content[0].text.length).toBeLessThan(2000);
    expect(fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf8')).toBe(markdown);
  });

  it('reports missing evidence without inventing progress or creating a blackboard', async () => {
    const { cwd } = createMessengerFixture('observer-empty-');
    for (const command of ['status', 'explain']) {
      const res = await observer(cwd)(command);
      expect(res.details.available).toBe(false);
      expect(res.content[0].text).toContain('progress cannot be confirmed');
    }
    expect(fs.existsSync(path.join(cwd, 'BLACKBOARD.md'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.pi/messenger/tasks'))).toBe(false);
  });

  it('preserves host dependency symlinks when aborting a non-Git fallback sandbox', async () => {
    const { cwd } = createMessengerFixture('observer-fallback-');
    const { cwd: dependencies } = createMessengerFixture('observer-dependencies-');
    fs.writeFileSync(path.join(dependencies, 'keep.txt'), 'shared dependency');
    const nodeModules = path.join(cwd, 'node_modules');
    fs.symlinkSync(dependencies, nodeModules, 'dir');
    const fallback = createWorktree(cwd, 'fallback-peer');
    expect(fallback.isGitWorktree).toBe(false);
    await observer(cwd)('abort');
    expect(fs.lstatSync(nodeModules).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(nodeModules, 'keep.txt'), 'utf8')).toBe('shared dependency');
    expect(fs.existsSync(cwd)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'aborts a project’s real process groups and worktrees while preserving other projects and verified facts',
    async () => {
      const repo = createTestGitRepo();
      const other = createTestGitRepo();
      const deps = path.join(repo.gitDir, 'node_modules');
      fs.mkdirSync(deps);
      fs.writeFileSync(path.join(deps, 'keep.txt'), 'host dependency');
      const sandbox = repo.allocateSandbox('abort-peer', 'PeerA');
      const otherSandbox = other.allocateSandbox('other-peer', 'OtherPeer');
      populate(repo.gitDir);
      const peer = spawn(
        process.execPath,
        [
          '-e',
          `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'}); console.log(child.pid); setInterval(() => {}, 1000);`,
        ],
        { cwd: sandbox.worktreePath, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: otherSandbox.worktreePath,
        detached: true,
        stdio: 'ignore',
      });
      const closed = once(peer, 'exit');
      const foreignClosed = once(foreign, 'exit');
      try {
        const [childPidText] = await once(peer.stdout!, 'data');
        const childPid = Number(String(childPidText).trim());
        expect(childPid).toBeGreaterThan(1);
        for (const [proc, project, allocation, name] of [
          [peer, repo, sandbox, 'PeerA'],
          [foreign, other, otherSandbox, 'OtherPeer'],
        ] as const) {
          processManager.register(
            {
              id: allocation.agentId,
              name,
              agentName: name,
              pid: proc.pid!,
              cwd: project.gitDir,
              worktreePath: allocation.worktreePath,
              status: 'running',
              startedAt: new Date().toISOString(),
              timeoutMs: 600_000,
            },
            proc
          );
        }
        const res = await observer(repo.gitDir)('abort');
        expect(res.details).toMatchObject({ mode: 'swarm.abort', aborted: true });
        expect(await closed).toEqual([null, 'SIGKILL']);
        await vi.waitFor(() => {
          const state = spawnSync('ps', ['-o', 'stat=', '-p', String(childPid)], {
            encoding: 'utf8',
          }).stdout.trim();
          expect(state === '' || state.startsWith('Z')).toBe(true);
        });
        expect(fs.existsSync(sandbox.worktreePath)).toBe(false);
        expect(repo.runGit(['worktree', 'list', '--porcelain']).stdout).not.toContain(
          sandbox.worktreePath
        );
        expect(fs.readFileSync(path.join(deps, 'keep.txt'), 'utf8')).toBe('host dependency');
        expect(fs.existsSync(otherSandbox.worktreePath)).toBe(true);
        expect(processManager.get('other-peer')?.status).toBe('running');
        expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
        expect(listActiveWorktrees().map((wt) => wt.agentId)).toContain('other-peer');
        expect(
          fs.readFileSync(path.join(repo.gitDir, '.pi/messenger/channels/all.jsonl'), 'utf8')
        ).toContain('swarm.abort');
        expect(
          fs.readFileSync(
            path.join(repo.gitDir, '.pi/messenger/tasks', `${sessionId}.jsonl`),
            'utf8'
          )
        ).toContain('swarm.abort');
        const brief = (await observer(repo.gitDir)('explain')).content[0].text;
        expect(brief).toMatch(/Completed milestones[\s\S]*Parse JSON[\s\S]*Active hypotheses/);
        expect(brief).toContain('LOCKED');
        expect((await observer(repo.gitDir)('abort')).details.aborted).toBe(true);
      } finally {
        forceKillProcessGroup(peer.pid!);
        forceKillProcessGroup(foreign.pid!);
        await Promise.all([closed, foreignClosed]);
      }
    }
  );

  it('explains only recorded milestones, hypotheses and dead ends from the snapshot', async () => {
    const { cwd } = createMessengerFixture('observer-explain-');
    const snapshot = populate(cwd);
    // A later event is deliberately absent from the projection being admitted.
    taskStore.appendTaskEvent(cwd, sessionId, {
      taskId: 'hidden',
      type: 'created',
      timestamp: new Date().toISOString(),
      agent: 'PeerA',
      payload: { title: 'UNPROJECTED_SECRET' },
    });
    const res = await observer(cwd)('explain');
    expect(res.details.mode).toBe('explain');
    const text = res.content[0].text;
    for (const phrase of [
      'Completed milestones',
      'Active hypotheses',
      'Disproved dead ends',
      'Parse JSON',
      'Try bounded cache',
      'Memory exhausted',
    ])
      expect(text).toContain(phrase);
    expect(text).toContain('snapshot');
    expect(text).not.toContain('UNPROJECTED_SECRET');
    expect(text).not.toContain('\x1b');
    expect(Buffer.byteLength(String(res.details.snapshot))).toBeLessThan(1000);
    expect(fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf8')).toBe(snapshot);
  });

  it('shows a read-only four-zone ANSI card and live project PIDs without requiring registration', async () => {
    const { cwd } = createMessengerFixture('observer-');
    const snapshot = populate(cwd);
    const eventsPath = path.join(cwd, '.pi/messenger/tasks', `${sessionId}.jsonl`);
    const events = fs.readFileSync(eventsPath, 'utf8');
    const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const closed = once(peer, 'exit');
    try {
      await once(peer, 'spawn');
      processManager.register(
        {
          id: 'observer-peer',
          name: 'PeerA',
          agentName: 'PeerA',
          pid: peer.pid!,
          cwd,
          status: 'running',
          startedAt: new Date().toISOString(),
          timeoutMs: 600_000,
        },
        peer
      );
      const res = await observer(cwd)('status');
      const text = res.content[0].text;
      expect(res.details.mode).toBe('status');
      expect(text).toMatch(/\x1b\[\d+m/);
      for (const label of [
        'Goal',
        'Soft Staking',
        'Verified',
        'Graveyard',
        'Ship parser',
        'Explore caching',
        'Parse JSON',
        'Unbounded cache',
        `PID ${peer.pid}`,
      ])
        expect(text).toContain(label);
      expect(fs.readFileSync(path.join(cwd, 'BLACKBOARD.md'), 'utf8')).toBe(snapshot);
      expect(fs.readFileSync(eventsPath, 'utf8')).toBe(events);
    } finally {
      peer.kill('SIGKILL');
      await closed;
    }
  });
});
