import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAction } from '../../router.js';
import * as taskStore from '../../swarm/task-store.js';
import { createWorktree, removeWorktree, type WorktreeInfo } from '../../swarm/worktree/index.js';
import { createTestGitRepo } from '../helpers/git-fixtures.js';
import { reservePort } from '../helpers/ports.js';
import {
  createContext,
  createMessengerFixture,
  createState,
  writeRegistration,
} from '../helpers/messenger-fixtures.js';

const sessionId = 'peer-toolbox-session';

function persistPeer(cwd: string, name: string, sandbox: WorktreeInfo) {
  const dir = path.join(cwd, '.pi/messenger/agents');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.appendFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    JSON.stringify({
      id: sandbox.agentId,
      type: 'spawned',
      timestamp: now,
      agent: {
        id: sandbox.agentId,
        name,
        cwd,
        sessionId,
        startedAt: now,
        status: 'running',
        worktreePath: sandbox.worktreePath,
        port: sandbox.port,
        testPort: sandbox.testPort,
      },
    }) + '\n'
  );
}

function fixture() {
  const { cwd, dirs } = createMessengerFixture('peer-toolbox-');
  const state = createState('PeerA', { registered: true, contextSessionId: sessionId });
  const ctx = createContext(cwd, sessionId);
  const action = (params: Parameters<typeof executeAction>[1]) =>
    executeAction(
      params.action!,
      params,
      state,
      dirs,
      ctx,
      () => {},
      () => {}
    );
  return { cwd, dirs, state, action };
}

afterEach(() => vi.useRealTimers());

describe('peer toolbox', () => {
  it('reports the caller sandbox, lease countdown and verification budget as JSON', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
    const { cwd, action } = fixture();
    const sandbox = createWorktree(cwd, 'peer-a', 'PeerA');
    try {
      const task = taskStore.createTask(
        cwd,
        sessionId,
        { title: 'Coordinate API' },
        'test-channel'
      );
      taskStore.stakeTask(cwd, sessionId, task.id, 'PeerA', { ttl: 300 });
      vi.setSystemTime(new Date('2026-09-29T00:00:12Z'));

      const res = await action({ action: 'status', self: true });
      expect(JSON.parse(res.content[0].text)).toMatchObject({
        agentId: 'peer-a',
        agentName: 'PeerA',
        sandboxPath: sandbox.worktreePath,
        currentTask: {
          id: task.id,
          status: 'staked',
          leaseExpiresIn: 288,
          verificationAttempts: 0,
          remainingRetries: 3,
          lastError: null,
        },
        runtime: { port: sandbox.port, testPort: sandbox.testPort },
      });
    } finally {
      removeWorktree(cwd, sandbox);
    }
  });

  it('discovers live peers and filters their current staked tasks', async () => {
    const { cwd, dirs, action } = fixture();
    for (const name of ['PeerA', 'PeerB', 'PeerC']) {
      writeRegistration(dirs, {
        name,
        cwd: name === 'PeerC' ? path.join(cwd, '.swarm/workspaces/worker-c') : cwd,
        sessionId,
      });
    }
    writeRegistration(dirs, { name: 'ExitedPeer', cwd, pid: 2147483647 });
    writeRegistration(dirs, { name: 'Human', cwd, isHuman: true });
    const { cwd: otherProject } = createMessengerFixture('peer-other-project-');
    writeRegistration(dirs, { name: 'UnrelatedPeer', cwd: otherProject, sessionId });
    fs.writeFileSync(path.join(dirs.registry, 'broken.json'), '{');
    const task = taskStore.createTask(cwd, sessionId, { title: 'API contract' }, 'test-channel');
    taskStore.stakeTask(cwd, sessionId, task.id, 'PeerB');

    const all = JSON.parse((await action({ action: 'peers' })).content[0].text);
    expect(all.map((peer: { name: string }) => peer.name)).toEqual(['PeerB', 'PeerC']);
    expect(all[0].tasks).toEqual([expect.objectContaining({ id: task.id, status: 'staked' })]);
    expect(all[1].tasks).toEqual([]);
    const filtered = await action({ action: 'peers', taskId: task.id });
    expect(JSON.parse(filtered.content[0].text).map((peer: { name: string }) => peer.name)).toEqual(
      ['PeerB']
    );
    expect(
      JSON.parse((await action({ action: 'peers', taskId: 'missing' })).content[0].text)
    ).toEqual([]);
  });

  it('delivers ordered messages only to the named recipient inbox', async () => {
    const { cwd, dirs, action } = fixture();
    writeRegistration(dirs, { name: 'PeerB', cwd });
    writeRegistration(dirs, { name: 'PeerC', cwd });
    await action({ action: 'send', to: 'PeerB', message: 'Use /v1/items\nReturn JSON' });
    await action({ action: 'send', to: 'PeerB', message: 'Agreed', replyTo: 'contract-1' });
    const messages = fs
      .readFileSync(path.join(dirs.base, 'inbox', 'PeerB.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(messages).toEqual([
      expect.objectContaining({
        from: 'PeerA',
        to: 'PeerB',
        text: 'Use /v1/items\nReturn JSON',
        replyTo: null,
      }),
      expect.objectContaining({
        from: 'PeerA',
        to: 'PeerB',
        text: 'Agreed',
        replyTo: 'contract-1',
      }),
    ]);
    expect(messages[0].id).not.toBe(messages[1].id);
    expect(fs.existsSync(path.join(dirs.base, 'inbox', 'PeerC.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dirs.base, 'channels', 'test-channel.jsonl'))).toBe(false);
    await action({ action: 'send', to: '#memory', message: 'Shared note' });
    expect(fs.readdirSync(path.join(dirs.base, 'inbox'))).toEqual(['PeerB.jsonl']);
  });

  it('excludes exited peers immediately after an observer status request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
    const { cwd, dirs, action } = fixture();
    writeRegistration(dirs, { name: 'PeerB', cwd, sessionId });
    writeRegistration(dirs, { name: 'ExitedPeer', cwd, pid: 2147483647 });

    const observed = await action({ action: 'status' });
    expect(observed.content[0].text).not.toContain('ExitedPeer');
    expect(fs.existsSync(path.join(dirs.registry, 'ExitedPeer.json'))).toBe(true);

    const peers = JSON.parse((await action({ action: 'peers' })).content[0].text);
    expect(peers.map((peer: { name: string }) => peer.name)).toEqual(['PeerB']);
  });

  it('keeps expired self leases inspectable and reports the latest verifier error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
    const { cwd, action } = fixture();
    const task = taskStore.createTask(cwd, sessionId, { title: 'Retry API' }, 'test-channel');
    taskStore.stakeTask(cwd, sessionId, task.id, 'PeerA', { ttl: 1 });
    taskStore.recordVerificationFailed(cwd, sessionId, task.id, 'PeerA', {
      agent: 'PeerA',
      attempt: 2,
      maxAttempts: 3,
      command: 'npm test',
      exitCode: 1,
      output: 'Expected HTTP 200, received 500',
    });
    vi.setSystemTime(new Date('2026-09-29T00:01:00Z'));
    const status = JSON.parse((await action({ action: 'status', self: true })).content[0].text);
    expect(status.currentTask).toMatchObject({
      id: task.id,
      leaseExpiresIn: 0,
      verificationAttempts: 2,
      remainingRetries: 1,
      lastError: 'Expected HTTP 200, received 500',
    });
    expect(taskStore.getTask(cwd, sessionId, task.id)?.status).toBe('staked');
  });

  it('reports idle peers without inventing a sandbox or port slots', async () => {
    const { action } = fixture();
    expect(JSON.parse((await action({ action: 'status', self: true })).content[0].text)).toEqual({
      agentId: 'PeerA',
      agentName: 'PeerA',
      sandboxPath: null,
      currentTask: null,
      runtime: { port: null, testPort: null },
    });
    expect((await action({ action: 'status' })).details.mode).toBe('status');
  });

  it('rejects unsafe recipients before writing any inbox and deduplicates recipient lists', async () => {
    const { dirs, action } = fixture();
    for (const to of ['../escape', '/tmp/escape', ['PeerB', '../escape'], ['PeerB', '']]) {
      expect((await action({ action: 'send', to, message: 'contract' })).details.error).toBe(
        'invalid_recipient'
      );
    }
    expect(fs.existsSync(path.join(dirs.base, 'inbox'))).toBe(false);
    await action({ action: 'send', to: ['PeerB', 'PeerC', 'PeerB'], message: 'contract' });
    for (const name of ['PeerB', 'PeerC']) {
      const lines = fs
        .readFileSync(path.join(dirs.base, 'inbox', `${name}.jsonl`), 'utf8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ to: name, text: 'contract' });
    }
  });

  it('excludes expired claims from peer discovery without releasing them', async () => {
    const { cwd, dirs, action } = fixture();
    writeRegistration(dirs, { name: 'PeerB', cwd, sessionId });
    const task = taskStore.createTask(cwd, sessionId, { title: 'Expired' }, 'test-channel');
    taskStore.stakeTask(cwd, sessionId, task.id, 'PeerB', { ttl: -1 });
    expect(
      JSON.parse((await action({ action: 'peers', taskId: task.id })).content[0].text)
    ).toEqual([]);
    expect(taskStore.getTask(cwd, sessionId, task.id)?.status).toBe('staked');
  });

  it('requires registration for self inspection, peer discovery and messaging', async () => {
    const { state, action } = fixture();
    state.registered = false;
    for (const params of [
      { action: 'status', self: true },
      { action: 'peers' },
      { action: 'send', to: 'PeerB', message: 'Hello' },
    ]) {
      expect((await action(params)).details.error).toBe('not_registered');
    }
  });
});

describe('peer project isolation', () => {
  it('does not borrow sandbox metadata from a same-named peer in another project', async () => {
    const { action } = fixture();
    const { cwd: otherProject } = createMessengerFixture('peer-other-project-');
    const otherSandbox = createWorktree(otherProject, 'other-a', 'PeerA');
    try {
      const status = JSON.parse((await action({ action: 'status', self: true })).content[0].text);
      expect(status.sandboxPath).toBeNull();
      expect(status.runtime).toEqual({ port: null, testPort: null });
    } finally {
      removeWorktree(otherProject, otherSandbox);
    }
  });
});

describe('peer toolbox CLI integration', () => {
  it('coordinates through the shared mesh when invoked inside a detached sandbox', async () => {
    const run = promisify(execFile);
    const { cwd: buildDir } = createMessengerFixture('peer-toolbox-build-');
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
    const sandbox = repo.allocateSandbox('cli-a', 'PeerA');
    const peerSandbox = repo.allocateSandbox('cli-b', 'PeerB');
    persistPeer(repo.gitDir, 'PeerA', sandbox);
    persistPeer(repo.gitDir, 'PeerB', peerSandbox);
    const nested = path.join(sandbox.worktreePath, 'src');
    fs.mkdirSync(nested);
    const dirs = {
      base: path.join(repo.gitDir, '.pi/messenger'),
      registry: path.join(repo.gitDir, '.pi/messenger/registry'),
    };
    for (const name of ['PeerA', 'PeerB'])
      writeRegistration(dirs, {
        name,
        cwd: repo.gitDir,
        sessionId,
        currentChannel: 'test-channel',
        sessionChannel: 'test-channel',
      });
    fs.writeFileSync(path.join(dirs.base, 'session-id'), sessionId);
    const task = taskStore.createTask(
      repo.gitDir,
      sessionId,
      { title: 'CLI contract' },
      'test-channel'
    );
    taskStore.stakeTask(repo.gitDir, sessionId, task.id, 'PeerB');

    const port = await reservePort();
    const env = {
      ...process.env,
      PI_SWARM_PROJECT_ROOT: '',
      PI_MESSENGER_PORT: String(port),
      PI_MESSENGER_CWD: repo.gitDir,
      PI_MESSENGER_DIR: '',
      PI_MESSENGER_GLOBAL: '0',
      PI_MESSENGER_CHANNEL: 'test-channel',
      PI_AGENT_NAME: 'PeerA',
    };
    const server = spawn(process.execPath, [path.join(buildDir, 'dist/harness/server.js')], {
      cwd: buildDir,
      env: {
        ...env,
        PI_MESSENGER_CWD: buildDir,
        PI_MESSENGER_LOG: path.join(buildDir, 'server.log'),
      },
      stdio: 'pipe',
    });
    const stopped = once(server, 'exit');
    let output = '';
    server.stdout.on('data', (chunk) => {
      output += chunk;
    });
    server.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const cli = (...args: string[]) =>
      run(process.execPath, [path.join(buildDir, 'dist/harness/cli.js'), ...args], {
        cwd: nested,
        env,
        timeout: 10_000,
      });
    try {
      await vi.waitFor(
        async () => {
          if (server.exitCode !== null) throw new Error(output);
          expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
        },
        { timeout: 10_000, interval: 50 }
      );
      const peers = JSON.parse((await cli('peers', '--task', task.id)).stdout);
      expect(peers.map((peer: { name: string }) => peer.name)).toEqual(['PeerB']);
      const status = JSON.parse((await cli('status', '--self')).stdout);
      expect(status).toMatchObject({
        agentId: 'cli-a',
        agentName: 'PeerA',
        currentTask: null,
        sandboxPath: sandbox.worktreePath,
        runtime: { port: sandbox.port, testPort: sandbox.testPort },
      });
      await cli('send', 'cli-b', 'Use /v1/items');
      expect(
        JSON.parse(fs.readFileSync(path.join(dirs.base, 'inbox/PeerB.jsonl'), 'utf8'))
      ).toMatchObject({ from: 'PeerA', to: 'PeerB', text: 'Use /v1/items' });
      expect(fs.existsSync(path.join(dirs.base, 'inbox/cli-b.jsonl'))).toBe(false);
      await expect(cli('send', '../escape', 'Invalid target')).rejects.toMatchObject({ code: 1 });
      expect(fs.existsSync(path.join(sandbox.worktreePath, '.pi/messenger/registry'))).toBe(false);

      // A .git file can also point to separate metadata, without being a linked sandbox.
      const separateRepo = createTestGitRepo();
      const metadata = path.join(buildDir, 'separate-git-metadata');
      await run('git', ['init', '--separate-git-dir', metadata], { cwd: separateRepo.gitDir });
      const separateDirs = {
        base: path.join(separateRepo.gitDir, '.pi/messenger'),
        registry: path.join(separateRepo.gitDir, '.pi/messenger/registry'),
      };
      writeRegistration(separateDirs, {
        name: 'PeerA',
        cwd: separateRepo.gitDir,
        sessionId,
        currentChannel: 'test-channel',
        sessionChannel: 'test-channel',
      });
      const separateStatus = await run(
        process.execPath,
        [path.join(buildDir, 'dist/harness/cli.js'), 'status', '--self'],
        { cwd: separateRepo.gitDir, env, timeout: 10_000 }
      );
      expect(JSON.parse(separateStatus.stdout)).toMatchObject({
        agentName: 'PeerA',
        currentTask: null,
      });
    } finally {
      server.kill('SIGTERM');
      await stopped;
    }
  }, 90_000);
});
