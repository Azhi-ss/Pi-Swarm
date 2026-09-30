/**
 * Overall Goal Acceptance archives a Swarm Run through the CLI and service.
 * The acceptance command is a real process; local tests are not a scientific score.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-goal-acceptance-'));
const packageCheckout = path.join(root, 'package-checkout');
const agentDir = path.join(root, 'pi-agent');
let wrapper = '';
let port = 0;
let env: NodeJS.ProcessEnv;

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

function messageFiles(project: string, text: string) {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl') && fs.readFileSync(full, 'utf8').includes(text))
        found.push(full);
    }
  };
  walk(path.join(project, '.pi', 'messenger'));
  return found;
}

function taskLog(project: string, runId: string) {
  return path.join(project, '.pi', 'messenger', 'tasks', `${runId}.jsonl`);
}

async function verifyTask(project: string, id: string, summary: string) {
  await invoke(project, ['task', 'claim', id], as('Delegator'));
  await invoke(
    project,
    ['task', 'done', id, summary, '--verify', 'node -e "process.exit(0)"'],
    as('Delegator')
  );
}

async function prepare(project: string, files: Record<string, string> = {}) {
  fs.writeFileSync(path.join(project, '.gitignore'), '.pi/\n.swarm/\nBLACKBOARD.md\n');
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(project, name), body);
  await git(project, ['add', '.gitignore', ...Object.keys(files)]);
  await git(project, ['commit', '-m', 'baseline']);
}

beforeAll(async () => {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  env = {
    ...process.env,
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
  if (wrapper) await invoke(packageCheckout, ['--stop']).catch(() => {});
  try {
    fs.unlinkSync(path.join(packageCheckout, 'node_modules'));
  } catch {
    // The symlink is removed with the temporary root when it is already gone.
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('leaves a verified task awaiting handoff when no overall evaluator was configured', async () => {
  const project = await initRepo(path.join(root, 'no-evaluator'));
  await prepare(project);
  const started = JSON.parse(
    (
      await invoke(
        project,
        ['run', 'start', '--goal', 'Work before an evaluator exists'],
        as('Delegator')
      )
    ).stdout
  );
  expect(started.acceptanceCommand).toBeUndefined();
  await invoke(project, ['run', 'join'], as('Delegator'));
  await invoke(project, ['task', 'create', '--title', 'Partial solution'], as('Delegator'));
  await verifyTask(project, 'task-1', 'One verified task');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(
    JSON.parse((await invoke(project, ['run', 'status'], as('Delegator'))).stdout)
  ).toMatchObject({
    id: started.id,
    status: 'active',
    phase: 'Awaiting Handoff',
    livePeers: 0,
  });
  await expect(
    invoke(project, ['run', 'start', '--goal', 'Overlapping objective'], as('Delegator'))
  ).rejects.toMatchObject({ stderr: expect.stringContaining('A Swarm Run is already active') });
}, 30_000);

it('does not archive when acceptance evidence is missing or the check fails', async () => {
  const project = await initRepo(path.join(root, 'failed-check'));
  await prepare(project, {
    'accept.cjs':
      "const fs=require('fs'); fs.mkdirSync('.pi',{recursive:true}); fs.appendFileSync('.pi/acceptance-runs','x\\n'); const ok=fs.existsSync('evidence.txt')&&fs.readFileSync('evidence.txt','utf8').trim()==='accepted'; process.exit(ok?0:2);\n",
  });
  const started = JSON.parse(
    (
      await invoke(
        project,
        ['run', 'start', '--goal', 'Need external evidence', '--verify', 'node accept.cjs'],
        as('Delegator')
      )
    ).stdout
  );
  await invoke(project, ['run', 'join'], as('Delegator'));
  await invoke(project, ['task', 'create', '--title', 'Still open'], as('Delegator'));
  await invoke(project, ['task', 'create', '--title', 'Verified alone'], as('Delegator'));
  await verifyTask(project, 'task-2', 'Individual verification');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const open = JSON.parse((await invoke(project, ['run', 'status'], as('Delegator'))).stdout);
  expect(open).toMatchObject({
    id: started.id,
    status: 'active',
    phase: 'Awaiting Handoff',
    livePeers: 0,
  });
  expect(fs.existsSync(path.join(project, '.pi', 'acceptance-runs'))).toBe(false);

  await verifyTask(project, 'task-1', 'Evidence still absent');
  await vi.waitFor(
    async () => {
      const observed = JSON.parse(
        (await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout
      );
      expect(observed.acceptance.exitCode).toBe(2);
      expect(observed.status).toBe('active');
    },
    { timeout: 10_000, interval: 200 }
  );
  const checkedAt = JSON.parse(
    (await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout
  ).acceptance.checkedAt;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const repeated = JSON.parse((await invoke(project, ['run', 'status'], as('Delegator'))).stdout);
  expect(repeated).toMatchObject({ id: started.id, status: 'active', phase: 'Awaiting Handoff' });
  expect(
    JSON.parse((await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout)
      .acceptance.checkedAt
  ).toBe(checkedAt);
  expect(
    fs
      .readFileSync(path.join(project, '.pi', 'acceptance-runs'), 'utf8')
      .trim()
      .split('\n')
  ).toEqual(['x']);
  await expect(
    invoke(project, ['run', 'start', '--goal', 'Must not overlap a failed run'], as('Delegator'))
  ).rejects.toMatchObject({ stderr: expect.stringContaining('A Swarm Run is already active') });
}, 40_000);

it('archives a satisfied run once, then a later run cannot see or extend its evidence', async () => {
  const project = await initRepo(path.join(root, 'archive'));
  await prepare(project, {
    'accept.cjs':
      "const fs=require('fs'); if(!fs.existsSync('evidence.txt')||fs.readFileSync('evidence.txt','utf8').trim()!=='accepted') process.exit(2);\n",
  });
  const started = JSON.parse(
    (
      await invoke(
        project,
        ['run', 'start', '--goal', 'Ship the accepted objective', '--verify', 'node accept.cjs'],
        as('Delegator')
      )
    ).stdout
  );
  await invoke(project, ['run', 'join'], as('Delegator'));
  await invoke(project, ['task', 'create', '--title', 'Pruned alternative'], as('Delegator'));
  await invoke(project, ['task', 'create', '--title', 'Accepted solution'], as('Delegator'));
  await invoke(project, ['task', 'claim', 'task-1'], as('Delegator'));
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(
      invoke(
        project,
        ['task', 'done', 'task-1', 'fails', '--verify', 'node -e "process.exit(7)"'],
        as('Delegator')
      )
    ).rejects.toMatchObject({ code: 1 });
  await verifyTask(project, 'task-2', 'Machine verified');
  await invoke(project, ['send', 'Delegator', 'Historical instruction'], as('Delegator'));
  await vi.waitFor(
    async () => {
      const observed = JSON.parse(
        (await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout
      );
      expect(observed.status).toBe('active');
      expect(observed.acceptance.exitCode).toBe(2);
    },
    { timeout: 10_000, interval: 200 }
  );
  fs.writeFileSync(path.join(project, 'evidence.txt'), 'accepted\n');

  await vi.waitFor(
    async () => {
      const observed = JSON.parse(
        (await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout
      );
      expect(observed.status).toBe('completed');
      expect(observed.acceptance.exitCode).toBe(0);
    },
    { timeout: 15_000, interval: 200 }
  );
  expect(JSON.parse((await invoke(project, ['run', 'status'], as('Delegator'))).stdout).phase).toBe(
    'No active run'
  );
  const archivedBoard = fs.readFileSync(
    path.join(project, '.pi', 'messenger', 'run-history', `${started.id}.md`),
    'utf8'
  );
  expect(archivedBoard).toContain('Accepted solution');
  expect(archivedBoard).toContain(started.id);
  const before = fs.readFileSync(taskLog(project, started.id), 'utf8');
  await expect(
    invoke(
      project,
      ['task', 'create', '--title', 'Late work'],
      as('Delegator', { PI_SWARM_RUN_ID: started.id })
    )
  ).rejects.toMatchObject({ stderr: expect.stringContaining('no longer active') });
  await expect(
    invoke(
      project,
      ['send', 'Delegator', 'Late instruction'],
      as('Delegator', { PI_SWARM_RUN_ID: started.id })
    )
  ).rejects.toMatchObject({ stderr: expect.stringContaining('no longer active') });
  expect(fs.readFileSync(taskLog(project, started.id), 'utf8')).toBe(before);
  expect(messageFiles(project, 'Late instruction')).toEqual([]);

  const later = JSON.parse(
    (await invoke(project, ['run', 'start', '--goal', 'Next objective'], as('Delegator'))).stdout
  );
  expect(later.id).not.toBe(started.id);
  await invoke(project, ['run', 'join'], as('Delegator'));
  const tasks = await invoke(project, ['task', 'list'], as('Delegator'));
  expect(tasks.stdout).not.toContain('Accepted solution');
  expect(tasks.stdout).not.toContain('Pruned alternative');
  expect((await invoke(project, ['inbox'], as('Delegator'))).stdout).not.toContain(
    'Historical instruction'
  );
  const history = messageFiles(project, 'Historical instruction');
  expect(history.length).toBeGreaterThan(0);
  for (const file of history) {
    expect(file).toContain(started.id);
    expect(file).not.toContain(later.id);
  }
  expect(
    JSON.parse((await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout)
  ).toMatchObject({
    id: started.id,
    status: 'completed',
    goal: 'Ship the accepted objective',
    acceptance: { exitCode: 0, command: 'node accept.cjs' },
  });
}, 45_000);

it('rechecks acceptance after in-flight work changes the run, without completing twice', async () => {
  const project = await initRepo(path.join(root, 'inflight'));
  await prepare(project, {
    'accept.cjs':
      "const fs=require('fs'); fs.mkdirSync('.pi',{recursive:true}); fs.appendFileSync('.pi/acceptance-runs','x\\n'); setTimeout(()=>process.exit(0),3000);\n",
  });
  const started = JSON.parse(
    (
      await invoke(
        project,
        ['run', 'start', '--goal', 'Hold archival for new work', '--verify', 'node accept.cjs'],
        as('Delegator')
      )
    ).stdout
  );
  await invoke(project, ['run', 'join'], as('Delegator'));
  await invoke(project, ['task', 'create', '--title', 'First solution'], as('Delegator'));
  await verifyTask(project, 'task-1', 'Verified before the check returns');
  await vi.waitFor(
    () => expect(fs.existsSync(path.join(project, '.pi', 'acceptance-runs'))).toBe(true),
    {
      timeout: 10_000,
      interval: 50,
    }
  );
  await expect(invoke(project, ['run', 'accept'], as('Delegator'))).rejects.toMatchObject({
    stderr: expect.stringContaining('already running'),
  });
  await invoke(
    project,
    ['task', 'create', '--title', 'Arrived during acceptance'],
    as('Delegator')
  );
  await vi.waitFor(
    async () => {
      const observed = JSON.parse(
        (await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout
      );
      expect(observed.acceptance.exitCode).toBe(0);
      expect(observed.status).toBe('active');
    },
    { timeout: 10_000, interval: 200 }
  );
  expect((await invoke(project, ['task', 'list'], as('Delegator'))).stdout).toContain(
    'Arrived during acceptance'
  );
  await verifyTask(project, 'task-2', 'Verified after the interrupted check');
  await vi.waitFor(
    async () =>
      expect(
        JSON.parse((await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout)
          .status
      ).toBe('completed'),
    { timeout: 15_000, interval: 200 }
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(
    fs
      .readFileSync(path.join(project, '.pi', 'acceptance-runs'), 'utf8')
      .trim()
      .split('\n')
  ).toEqual(['x', 'x']);
  expect(JSON.parse((await invoke(project, ['run', 'status'], as('Delegator'))).stdout).phase).toBe(
    'No active run'
  );
  const later = JSON.parse(
    (await invoke(project, ['run', 'start', '--goal', 'After the archived run'], as('Delegator')))
      .stdout
  );
  expect(later.id).not.toBe(started.id);
  expect(
    JSON.parse((await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout)
      .acceptance.exitCode
  ).toBe(0);
}, 45_000);
