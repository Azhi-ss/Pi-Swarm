/**
 * Budget, supervision, and emergency stop follow the selected Project's Swarm Run.
 * The CLI and service drive real process groups; tool steps use the same breaker
 * the Pi host records on tool activity.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { getCircuitBreaker } from '../../swarm/circuit-breaker/index.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-run-controls-'));
const packageCheckout = path.join(root, 'package-checkout');
const agentDir = path.join(root, 'pi-agent');
const stubDir = path.join(root, 'bin');
let wrapper = '';
let port = 0;
let env: NodeJS.ProcessEnv;
const childPids: number[] = [];

function git(cwd: string, args: string[]) {
  return exec('git', args, { cwd, env });
}

async function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']).catch(async () => {
    await git(dir, ['init']);
    await git(dir, ['checkout', '-b', 'main']);
  });
  await git(dir, ['config', 'user.email', 'test@example.test']);
  await git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Project\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'initial']);
  return fs.realpathSync(dir);
}

function invoke(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return exec(wrapper, args, {
    cwd,
    env: { ...env, ...extra },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
}

function as(name: string, extra: NodeJS.ProcessEnv = {}) {
  return { ...extra, PI_AGENT_NAME: name, PI_SWARM_RUN_ID: extra.PI_SWARM_RUN_ID ?? '' };
}

function processGone(pid: number) {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
  }).stdout.trim();
  return state === '' || state.startsWith('Z');
}

beforeAll(async () => {
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, 'pi'),
    `#!/bin/sh
node -e 'setInterval(() => {}, 500)' &
echo $! > "$PI_SWARM_PROJECT_ROOT/.pi/stub-child.pid"
wait
`
  );
  fs.chmodSync(path.join(stubDir, 'pi'), 0o755);
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  env = {
    ...process.env,
    PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
    PI_SWARM_PROJECT_ROOT: '',
    PI_SWARM_RUN_ID: '',
    PI_AGENT_NAME: 'Delegator',
    PI_MESSENGER_DIR: '',
    PI_MESSENGER_GLOBAL: '0',
    PI_MESSENGER_CWD: '',
    PI_MESSENGER_CHANNEL: '',
    PI_MESSENGER_PORT: String(port),
    PI_MESSENGER_LOG: path.join(root, 'service.log'),
    PI_CODING_AGENT_DIR: agentDir,
    NODE_PATH: '',
    NODE_OPTIONS: '',
  };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  await initRepo(packageCheckout);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  pkg.type = 'module';
  fs.writeFileSync(path.join(packageCheckout, 'package.json'), JSON.stringify(pkg));
  fs.symlinkSync(
    path.join(repoRoot, 'node_modules'),
    path.join(packageCheckout, 'node_modules'),
    'dir'
  );
  await exec(
    process.execPath,
    [
      createRequire(import.meta.url).resolve('typescript/bin/tsc'),
      '-p',
      path.join(repoRoot, 'tsconfig.build.json'),
      '--outDir',
      path.join(packageCheckout, 'dist'),
    ],
    { cwd: repoRoot, env }
  );
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const { installShellAlias } = await import(process.argv[1]); installShellAlias();',
      pathToFileURL(path.join(packageCheckout, 'dist/extension/harness.js')).href,
    ],
    { cwd: packageCheckout, env }
  );
  wrapper = path.join(agentDir, 'bin', 'pi-messenger-swarm');
  env.PI_MESSENGER_CWD = fs.realpathSync(packageCheckout);
}, 120_000);

afterAll(async () => {
  for (const pid of childPids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  if (wrapper) await invoke(packageCheckout, ['--stop']).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('scopes budget, emergency stop, and supervision to the owning run', async () => {
  const projectA = await initRepo(path.join(root, 'project-a'));
  const projectB = await initRepo(path.join(root, 'project-b'));
  fs.writeFileSync(
    path.join(projectA, '.gitignore'),
    '.pi/\n.swarm/\nnode_modules/\nBLACKBOARD.md\n'
  );
  await git(projectA, ['add', '.gitignore']);
  await git(projectA, ['commit', '-m', 'ignore runtime files']);
  fs.mkdirSync(path.join(projectA, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(projectA, 'node_modules', 'keep.txt'), 'host dependency');

  const runA = JSON.parse(
    (
      await invoke(
        projectA,
        ['run', 'start', '--goal', 'Bound project A', '--max-steps', '4', '--concurrency', '1'],
        as('Delegator')
      )
    ).stdout
  );
  const runB = JSON.parse(
    (
      await invoke(
        projectB,
        ['run', 'start', '--goal', 'Bound project B', '--max-steps', '4', '--concurrency', '1'],
        as('Delegator')
      )
    ).stdout
  );
  await invoke(projectA, ['run', 'join'], as('Delegator'));
  await invoke(projectB, ['run', 'join'], as('Delegator'));
  await invoke(projectA, ['task', 'create', '--title', 'Keep verified'], as('Delegator'));
  await invoke(projectA, ['task', 'claim', 'task-1'], as('Delegator'));
  expect(
    (
      await invoke(
        projectA,
        ['task', 'done', 'task-1', 'Verified parser fact', '--verify', 'node -e "process.exit(0)"'],
        as('Delegator')
      )
    ).stdout
  ).toContain('Verified parser fact');
  const patch = path.join(projectA, '.pi', 'messenger', 'artifacts', 'task-1.patch');
  const hadPatch = fs.existsSync(patch);

  const spawnedA = await invoke(
    projectA,
    ['spawn', '--name', 'PeerA', 'Work in A'],
    as('Delegator')
  );
  const spawnedB = await invoke(
    projectB,
    ['spawn', '--name', 'PeerB', 'Work in B'],
    as('Delegator')
  );
  expect(spawnedA.stdout).toContain('Spawned');
  expect(spawnedB.stdout).toContain('Spawned');
  const sandboxA = spawnedA.stdout.match(/\(([0-9a-f]{8})\)/)?.[1];
  const sandboxB = spawnedB.stdout.match(/\(([0-9a-f]{8})\)/)?.[1];
  expect(sandboxA).toBeTruthy();
  expect(sandboxB).toBeTruthy();
  const worktreeA = path.join(projectA, '.swarm', 'workspaces', `worker-${sandboxA}`);
  const worktreeB = path.join(projectB, '.swarm', 'workspaces', `worker-${sandboxB}`);
  await vi.waitFor(() => {
    expect(fs.existsSync(path.join(projectA, '.pi', 'stub-child.pid'))).toBe(true);
    expect(fs.existsSync(path.join(projectB, '.pi', 'stub-child.pid'))).toBe(true);
  });
  const childA = Number(fs.readFileSync(path.join(projectA, '.pi', 'stub-child.pid'), 'utf8'));
  const childB = Number(fs.readFileSync(path.join(projectB, '.pi', 'stub-child.pid'), 'utf8'));
  childPids.push(childA, childB);
  expect(processGone(childA)).toBe(false);
  expect(processGone(childB)).toBe(false);
  expect(fs.existsSync(worktreeA)).toBe(true);
  expect(fs.existsSync(worktreeB)).toBe(true);

  const breakerA = getCircuitBreaker(projectA, runA.id);
  breakerA.recordStep('PeerA', 'bash', { cwd: projectA, sessionId: runA.id });
  breakerA.recordStep('PeerA', 'bash', { cwd: projectA, sessionId: runA.id });
  const statusBefore = (await invoke(projectA, ['status'], as('Observer'))).stdout;
  const explainBefore = (await invoke(projectA, ['explain'], as('Observer'))).stdout;
  const leaderA = Number(statusBefore.match(/PeerA · PID (\d+)/)?.[1]);
  expect(leaderA).toBeGreaterThan(1);
  childPids.push(leaderA);
  for (const output of [statusBefore, explainBefore]) {
    expect(output).toContain('Budget: 2/4 steps remaining');
    expect(output).toContain('Keep verified');
    expect(output).toContain(`PID ${leaderA}`);
    expect(output).not.toContain('PeerB');
    expect(output).not.toContain(`PID ${childB}`);
  }
  expect(
    JSON.parse((await invoke(projectA, ['run', 'status'], as('Observer'))).stdout)
  ).toMatchObject({
    id: runA.id,
    consumedSteps: 2,
    maxSteps: 4,
  });
  expect((await invoke(projectB, ['status'], as('Observer'))).stdout).toContain(
    'Budget: 4/4 steps remaining'
  );
  expect(
    JSON.parse((await invoke(projectB, ['run', 'status'], as('Observer'))).stdout).consumedSteps
  ).toBe(0);

  await invoke(projectA, ['run', 'join'], as('OtherSession'));
  expect(
    JSON.parse((await invoke(projectA, ['run', 'status'], as('OtherSession'))).stdout).consumedSteps
  ).toBe(2);
  await expect(invoke(projectA, ['spawn', 'extra peer'], as('Delegator'))).rejects.toMatchObject({
    stderr: expect.stringContaining('concurrency'),
  });
  expect(
    JSON.parse((await invoke(projectA, ['run', 'status'], as('Delegator'))).stdout).consumedSteps
  ).toBe(2);

  breakerA.recordStep('PeerA', 'bash', { cwd: projectA, sessionId: runA.id });
  breakerA.recordStep('PeerA', 'bash', { cwd: projectA, sessionId: runA.id });
  await vi.waitFor(
    () => {
      expect(processGone(childA)).toBe(true);
      expect(processGone(leaderA)).toBe(true);
    },
    { timeout: 10_000 }
  );
  expect(processGone(childB)).toBe(false);
  expect(fs.existsSync(worktreeA)).toBe(false);
  expect(fs.existsSync(worktreeB)).toBe(true);
  expect(fs.readFileSync(path.join(projectA, 'node_modules', 'keep.txt'), 'utf8')).toBe(
    'host dependency'
  );
  if (hadPatch) expect(fs.readFileSync(patch, 'utf8').length).toBeGreaterThan(0);

  for (const command of ['status', 'explain'] as const) {
    const output = (await invoke(projectA, [command], as('Observer'))).stdout;
    expect(output).toContain('Budget: 0/4 steps remaining');
    expect(output).toContain('Stop reason: Global step budget exceeded (4/4 steps)');
    expect(output).toContain('Verified parser fact');
    expect(output).not.toContain(`PID ${leaderA}`);
    expect(output).not.toContain(`PID ${childA}`);
    expect(output).not.toContain(`PID ${childB}`);
  }
  await expect(
    invoke(projectA, ['task', 'claim', 'task-1'], as('Delegator', { PI_SWARM_RUN_ID: runA.id }))
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('no longer active'),
  });
  await expect(
    invoke(projectA, ['run', 'join'], as('Delegator', { PI_SWARM_RUN_ID: runA.id }))
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('no longer active'),
  });

  await invoke(projectB, ['task', 'create', '--title', 'Still admissible'], as('Delegator'));
  expect((await invoke(projectB, ['task', 'claim', 'task-1'], as('Delegator'))).stdout).toContain(
    'task-1'
  );
  expect(
    JSON.parse((await invoke(projectB, ['run', 'status'], as('Delegator'))).stdout)
  ).toMatchObject({
    id: runB.id,
    consumedSteps: 0,
    status: 'active',
  });

  expect(
    (await invoke(projectB, ['abort', '--reason', 'Stop project B only'], as('Observer'))).stdout
  ).toContain('Stop project B only');
  await vi.waitFor(() => expect(processGone(childB)).toBe(true), { timeout: 10_000 });
  expect(fs.existsSync(worktreeB)).toBe(false);
  expect((await invoke(projectB, ['explain'], as('Observer'))).stdout).toContain(
    'Stop reason: Stop project B only'
  );
  expect(
    JSON.parse((await invoke(projectA, ['run', 'show', runA.id], as('Observer'))).stdout)
  ).toMatchObject({
    status: 'aborted',
    consumedSteps: 4,
    stopReason: 'Global step budget exceeded (4/4 steps)',
  });

  await invoke(projectA, ['--stop']);
  await vi.waitFor(async () => expect(invoke(projectA, ['--status'])).rejects.toThrow(), {
    timeout: 10_000,
  });
  await invoke(projectA, ['--start']);
  expect(
    JSON.parse((await invoke(projectA, ['run', 'show', runA.id], as('Later'))).stdout)
  ).toMatchObject({
    id: runA.id,
    status: 'aborted',
    consumedSteps: 4,
    stopReason: 'Global step budget exceeded (4/4 steps)',
  });
  expect((await invoke(projectA, ['status'], as('Later'))).stdout).toContain(
    'Stop reason: Global step budget exceeded (4/4 steps)'
  );
  await expect(invoke(projectA, ['spawn', 'revived peer'], as('Later'))).rejects.toMatchObject({
    stderr: expect.stringContaining('No active Swarm Run'),
  });
}, 120_000);
