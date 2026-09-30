/**
 * One active Swarm Run per Project. Additional Interaction Sessions observe or
 * join that run through the CLI and service, against real Git repositories.
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-active-run-'));
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

function plantForeignSession(project: string, runId: string) {
  const event = JSON.stringify({
    taskId: 'task-9',
    type: 'created',
    timestamp: new Date().toISOString(),
    channel: 'foreign',
    agent: 'Foreign',
    payload: { title: 'Foreign session task', dependsOn: [], createdBy: 'Foreign' },
  });
  const tasksDir = path.join(project, '.pi', 'messenger', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'foreign-session.jsonl'), event + '\n');
  fs.writeFileSync(path.join(project, '.pi', 'messenger', 'session-id'), 'foreign-session');
  const runDir = path.join(project, '.pi', 'messenger', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'session-id'), 'foreign-session');
}

function registrations(project: string, storage: string | undefined, name: string) {
  const roots = [path.join(project, '.pi', 'messenger')];
  if (storage) roots.push(storage);
  const found: Array<{ file: string; body: { sessionId?: string; cwd?: string } }> = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === `${name}.json` && full.includes(`${path.sep}registry${path.sep}`))
        found.push({ file: full, body: JSON.parse(fs.readFileSync(full, 'utf8')) });
    }
  };
  for (const start of roots) walk(start);
  return found;
}

function messageFiles(project: string, storage: string | undefined, text: string) {
  const roots = [path.join(project, '.pi', 'messenger')];
  if (storage) roots.push(storage);
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
  for (const start of roots) walk(start);
  return found;
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

it('admits one run and shows that run to a joined session and an observer', async () => {
  const project = await initRepo(path.join(root, 'admit'));
  const starts = await Promise.allSettled([
    invoke(project, ['run', 'start', '--goal', 'Objective A'], as('Delegator')),
    invoke(project, ['run', 'start', '--goal', 'Objective B'], as('OtherDelegator')),
  ]);
  const admitted = starts.filter(
    (result): result is PromiseFulfilledResult<{ stdout: string }> => result.status === 'fulfilled'
  );
  const rejected = starts.filter((result) => result.status === 'rejected');
  expect(admitted).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const rejection = rejected[0] as PromiseRejectedResult;
  expect(String((rejection.reason as { stderr?: string }).stderr)).toContain(
    'A Swarm Run is already active'
  );
  const run = JSON.parse(admitted[0].value.stdout);
  expect(run.project).toBe(project);
  expect(['Objective A', 'Objective B']).toContain(run.goal);
  const otherGoal = run.goal === 'Objective A' ? 'Objective B' : 'Objective A';

  await invoke(project, ['run', 'join'], as('Delegator'));
  await invoke(project, ['task', 'create', '--title', 'Shared run task'], as('Delegator'));
  plantForeignSession(project, run.id);

  const joined = await invoke(project, ['run', 'join'], as('NewSession'));
  expect(joined.stdout).toContain(run.id);
  expect(joined.stdout).toContain('Delegator');
  const tasks = await invoke(project, ['task', 'list'], as('NewSession'));
  expect(tasks.stdout).toContain('Shared run task');
  expect(tasks.stdout).toContain(`Project: ${project}`);
  expect(tasks.stdout).toContain(`Run: ${run.id}`);
  expect(tasks.stdout).not.toContain('Foreign session task');
  expect(tasks.stdout).not.toContain(otherGoal);

  const observed = await invoke(project, ['status'], as('Observer'));
  const explained = await invoke(project, ['explain'], as('Observer'));
  const board = fs.readFileSync(path.join(project, 'BLACKBOARD.md'), 'utf8');
  for (const output of [observed.stdout, explained.stdout, board]) {
    expect(output).toContain('Shared run task');
    expect(output).toContain(project);
    expect(output).toContain(run.id);
    expect(output).not.toContain('Foreign session task');
    expect(output).not.toContain(otherGoal);
  }
  expect(observed.stdout).toContain('Delegator');
  expect(explained.stdout).toContain(`Run: ${run.id}`);

  const registered = registrations(project, undefined, 'NewSession');
  expect(registered.map((entry) => entry.body.sessionId)).toEqual([run.id]);
  expect(registered.map((entry) => entry.body.cwd)).toEqual([project]);

  await invoke(project, ['send', 'NewSession', 'Run local instruction'], as('Delegator'));
  const inbox = await invoke(project, ['inbox'], as('NewSession'));
  expect(inbox.stdout).toContain('Run local instruction');
  const stored = messageFiles(project, undefined, 'Run local instruction');
  expect(stored.length).toBeGreaterThan(0);
  for (const file of stored) {
    expect(file).toContain(run.id);
    const message = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)!);
    expect(message).toMatchObject({ project, runId: run.id, text: 'Run local instruction' });
  }
}, 60_000);

it('lets two projects keep separate active runs in one messaging store', async () => {
  const shared = path.join(root, 'shared-store');
  const left = await initRepo(path.join(root, 'left'));
  const right = await initRepo(path.join(root, 'right'));
  const storage = { PI_MESSENGER_DIR: shared };
  const leftRun = JSON.parse(
    (await invoke(left, ['run', 'start', '--goal', 'Left goal'], as('Same', storage))).stdout
  );
  const rightRun = JSON.parse(
    (await invoke(right, ['run', 'start', '--goal', 'Right goal'], as('Same', storage))).stdout
  );
  expect(leftRun.id).not.toBe(rightRun.id);
  expect(leftRun.project).toBe(left);
  expect(rightRun.project).toBe(right);
  await invoke(left, ['run', 'join'], as('Same', storage));
  await invoke(right, ['run', 'join'], as('Same', storage));
  await invoke(left, ['task', 'create', '--title', 'Left task'], as('Same', storage));
  await invoke(left, ['send', 'Same', 'Left only instruction'], as('Same', storage));
  expect((await invoke(right, ['task', 'list'], as('Same', storage))).stdout).not.toContain(
    'Left task'
  );
  expect((await invoke(right, ['inbox'], as('Same', storage))).stdout).not.toContain(
    'Left only instruction'
  );
  expect((await invoke(left, ['run', 'status'], as('Same', storage))).stdout).toContain(leftRun.id);
  expect((await invoke(right, ['run', 'status'], as('Same', storage))).stdout).toContain(
    rightRun.id
  );
  const board = fs.readFileSync(path.join(right, 'BLACKBOARD.md'), 'utf8');
  expect(board).toContain(right);
  expect(board).toContain(rightRun.id);
  expect(board).not.toContain('Left task');
}, 60_000);

it('keeps an unfinished run after one task finishes and a service restart', async () => {
  const project = await initRepo(path.join(root, 'handoff'));
  const started = JSON.parse(
    (await invoke(project, ['run', 'start', '--goal', 'Stay unfinished'], as('Delegator'))).stdout
  );
  await invoke(project, ['run', 'join'], as('Delegator'));
  await invoke(project, ['task', 'create', '--title', 'Partial task'], as('Delegator'));
  await invoke(project, ['task', 'claim', 'task-1'], as('Delegator'));
  expect(
    (await invoke(project, ['task', 'done', 'task-1', 'One task is not the run'], as('Delegator')))
      .stdout
  ).toContain('Completed task-1');
  const before = JSON.parse((await invoke(project, ['run', 'status'], as('Delegator'))).stdout);
  expect(before).toMatchObject({
    id: started.id,
    project,
    status: 'active',
    phase: 'Awaiting Handoff',
  });
  plantForeignSession(project, started.id);

  await invoke(project, ['--stop']);
  await vi.waitFor(
    async () => {
      await expect(invoke(project, ['--status'])).rejects.toThrow();
    },
    { timeout: 5_000 }
  );
  await invoke(project, ['--start']);
  const after = JSON.parse((await invoke(project, ['run', 'status'], as('Delegator'))).stdout);
  expect(after).toMatchObject({ id: started.id, project, status: 'active' });
  const tasks = await invoke(project, ['task', 'list'], as('Delegator'));
  expect(tasks.stdout).toContain('Partial task');
  expect(tasks.stdout).not.toContain('Foreign session task');
  await expect(
    invoke(project, ['run', 'start', '--goal', 'Second objective'], as('Delegator'))
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('A Swarm Run is already active'),
  });
}, 60_000);

it('aborts the selected run and keeps its evidence out of the next run', async () => {
  const project = await initRepo(path.join(root, 'abort'));
  const started = JSON.parse(
    (await invoke(project, ['run', 'start', '--goal', 'Stop this objective'], as('Same'))).stdout
  );
  await invoke(project, ['run', 'join'], as('Same'));
  await invoke(project, ['task', 'create', '--title', 'Old run task'], as('Same'));
  await invoke(project, ['send', 'Same', 'Old run instruction'], as('Same'));
  await invoke(project, ['abort'], as('Delegator'));

  const archived = JSON.parse(
    (await invoke(project, ['run', 'show', started.id], as('Delegator'))).stdout
  );
  expect(archived).toMatchObject({
    id: started.id,
    project,
    status: 'aborted',
    goal: 'Stop this objective',
  });
  expect(JSON.parse((await invoke(project, ['run', 'status'], as('Delegator'))).stdout).phase).toBe(
    'No active run'
  );
  await expect(
    invoke(project, ['run', 'join'], as('Same', { PI_SWARM_RUN_ID: started.id }))
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('no longer active'),
  });

  const later = JSON.parse(
    (await invoke(project, ['run', 'start', '--goal', 'Next objective'], as('Same'))).stdout
  );
  expect(later.id).not.toBe(started.id);
  await invoke(project, ['run', 'join'], as('Same'));
  const tasks = await invoke(project, ['task', 'list'], as('Same'));
  expect(tasks.stdout).not.toContain('Old run task');
  expect((await invoke(project, ['inbox'], as('Same'))).stdout).not.toContain(
    'Old run instruction'
  );
  const history = messageFiles(project, undefined, 'Old run instruction');
  expect(history.length).toBeGreaterThan(0);
  for (const file of history) {
    expect(file).toContain(started.id);
    expect(file).not.toContain(later.id);
  }
  expect(
    JSON.parse((await invoke(project, ['run', 'show', started.id], as('Same'))).stdout).goal
  ).toBe('Stop this objective');
}, 60_000);
