import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { reservePort } from '../helpers/ports.js';

const exec = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-installed-'));
const install = path.join(root, 'install');
const project = path.join(root, 'project');
let port: number;
let cli: string;
let env: NodeJS.ProcessEnv;
const run = (file: string, args: string[], cwd = project) =>
  exec(file, args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
const command = (...args: string[]) => run(cli, args);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Delta = Record<string, unknown>;
const say = (content: string): Delta => ({ content });
const bash = (id: string, shell: string, timeout = 60): Delta => ({
  tool_calls: [
    {
      index: 0,
      id,
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: shell, timeout }) },
    },
  ],
});
function writeTurn(res: ServerResponse, deltas: Delta[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const finish = deltas.some((delta) => delta.tool_calls) ? 'tool_calls' : 'stop';
  for (const choice of [
    ...deltas.map((delta, i) => ({
      delta: i ? delta : { role: 'assistant', ...delta },
      finish_reason: null,
    })),
    { delta: {}, finish_reason: finish },
  ])
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, ...choice }],
        }) +
        '\n\n'
    );
  res.end('data: [DONE]\n\n');
}
function writeToolTurn(res: ServerResponse, id: string, shell: string) {
  writeTurn(res, [bash(id, shell)]);
}

type Message = { role: string; content?: unknown };
/** An incident arrived after the recipient's last reply that handled it. */
function unanswered(messages: Message[], incident: string, reply: string) {
  const text = (m: Message) => JSON.stringify(m.content ?? '');
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && text(m).includes(reply)) last = i;
  });
  return messages.slice(last + 1).some((m) => m.role !== 'assistant' && text(m).includes(incident));
}

const textOf = (m: Message) =>
  typeof m.content === 'string'
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((part: { text?: string }) => part.text ?? '').join('')
      : '';

/** Completed assistant messages a real Pi process emitted containing `marker`. */
function replies(output: string, marker: string) {
  return output.split('\n').filter((line) => {
    try {
      const event = JSON.parse(line);
      return (
        event.type === 'message_end' &&
        event.message?.role === 'assistant' &&
        JSON.stringify(event.message.content).includes(marker)
      );
    } catch {
      return false;
    }
  }).length;
}

function startPi(cwd: string, piEnv: NodeJS.ProcessEnv) {
  const proc = spawn(
    path.join(install, 'node_modules/.bin/pi'),
    [
      '--mode',
      'rpc',
      '--no-session',
      '--no-skills',
      '--extension',
      path.join(install, 'node_modules/pi-messenger-swarm/dist/index.js'),
      '--provider',
      'fixture',
      '--model',
      'fixture',
    ],
    { cwd, env: piEnv, stdio: 'pipe' }
  );
  const pi = {
    pid: proc.pid!,
    output: '',
    exited: once(proc, 'exit'),
    prompt: (message: string) =>
      proc.stdin.write(JSON.stringify({ type: 'prompt', message }) + '\n'),
    async stop() {
      proc.kill('SIGTERM');
      await pi.exited.catch(() => {});
    },
  };
  proc.stdout.on('data', (c) => (pi.output += c));
  proc.stderr.on('data', (c) => (pi.output += c));
  return pi;
}

async function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  await run('git', ['init'], dir);
  await run('git', ['config', 'user.name', 'Test'], dir);
  await run('git', ['config', 'user.email', 'test@example.test'], dir);
  await run('git', ['commit', '--allow-empty', '-m', 'initial'], dir);
}

/** An independent installed service process on its own port and log. */
async function secondService(cwd = project, extra: NodeJS.ProcessEnv = {}) {
  const secondPort = await reservePort();
  return (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...env,
        ...extra,
        PI_MESSENGER_PORT: String(secondPort),
        PI_MESSENGER_LOG: path.join(root, `second-${secondPort}.log`),
      },
      timeout: 20_000,
    });
}

/** PID of a spawned peer, from the public process table. */
async function peerPid(cmd: (...args: string[]) => Promise<{ stdout: string }>, id: string) {
  return Number(
    (await cmd('ps')).stdout
      .split('\n')
      .find((line) => line.includes(`worker-${id}`))!
      .split('|')[4]
      .trim()
  );
}
const spawnedId = (listing: string, name: string) =>
  listing.match(new RegExp(`^- (\\w+): ${name} `, 'm'))?.[1];
const historyCount = (history: string) => (history.match(/^- /gm) || []).length;
async function coldRestart() {
  const previous = JSON.parse((await command('--status')).stdout).pid;
  process.kill(previous, 'SIGTERM');
  await vi.waitFor(
    async () => {
      const up = await fetch(`http://127.0.0.1:${port}/health`)
        .then((r) => r.ok)
        .catch(() => false);
      expect(up).toBe(false);
    },
    { timeout: 5000 }
  );
  await command('--start');
  expect(JSON.parse((await command('--status')).stdout).pid).not.toBe(previous);
}

beforeAll(async () => {
  fs.mkdirSync(install);
  port = await reservePort();
  env = {
    ...process.env,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    PI_SWARM_PROJECT_ROOT: '',
    PI_SWARM_RUN_ID: '',
    PI_AGENT_NAME: 'Delegator',
    PI_MESSENGER_DIR: '',
    PI_MESSENGER_GLOBAL: '0',
    PI_MESSENGER_CWD: '',
    PI_MESSENGER_PORT: String(port),
    PI_CODING_AGENT_DIR: path.join(root, 'pi'),
    PATH: path.join(install, 'node_modules/.bin') + path.delimiter + process.env.PATH,
    PI_MESSENGER_LOG: path.join(root, 'service.log'),
    // Exclude module search paths/loaders inherited from the developer shell.
    NODE_PATH: '',
    NODE_OPTIONS: '',
  };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  await initRepo(project);
  await run('npm', ['run', 'build'], process.cwd());
  await run('npm', ['pack', '--json', '--pack-destination', root], process.cwd());
  const packed = { filename: fs.readdirSync(root).find((name) => name.endsWith('.tgz'))! };
  fs.writeFileSync(
    path.join(install, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@earendil-works/pi-coding-agent': '0.87.0',
        '@earendil-works/pi-tui': '0.87.0',
      },
    })
  );
  // Supply the supported host before adding the release artifact.
  await run(
    'npm',
    ['install', '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund'],
    install
  );
  await run(
    'npm',
    [
      'install',
      '--omit=dev',
      '--ignore-scripts=false',
      '--no-audit',
      '--no-fund',
      path.join(root, packed.filename),
    ],
    install
  );
  cli = path.join(install, 'node_modules/.bin/pi-messenger-swarm');
}, 180_000);

afterAll(async () => {
  if (cli) await command('--stop').catch(() => {});
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('loads the production extension and starts its installed service in a separate project', async () => {
  const supplied = JSON.parse(fs.readFileSync(path.join(install, 'package.json'), 'utf8'));
  expect(supplied.dependencies).toMatchObject({
    '@earendil-works/pi-coding-agent': '0.87.0',
    '@earendil-works/pi-tui': '0.87.0',
  });
  // Let Pi discover the extension declared by the installed package manifest.
  fs.copyFileSync(
    path.join(import.meta.dirname, 'fixtures/inspect-installation.mjs'),
    path.join(install, 'inspect-installation.mjs')
  );
  const loaded = JSON.parse(
    (
      await run(process.execPath, [
        '--experimental-import-meta-resolve',
        path.join(install, 'inspect-installation.mjs'),
      ])
    ).stdout
  );
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toEqual([
    expect.objectContaining({
      path: path.join(install, 'node_modules/pi-messenger-swarm/dist/index.js'),
      commands: expect.arrayContaining(['messenger']),
    }),
  ]);
  for (const dependency of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
    expect(loaded.peers[dependency]).toMatchObject({
      version: '0.87.0',
      range: '0.87.x',
      hostVersion: '0.87.0',
      suppliedByInstallation: true,
    });
    expect(
      loaded.peers[dependency].resolved.startsWith(path.join(install, 'node_modules') + path.sep)
    ).toBe(true);
    expect(
      loaded.peers[dependency].hostResolved.startsWith(
        path.join(install, 'node_modules') + path.sep
      )
    ).toBe(true);
  }
  // Build tools must not be supplied by the production installation.
  for (const dependency of ['typescript', 'vitest', 'simple-git-hooks']) {
    expect(fs.existsSync(path.join(install, 'node_modules', dependency))).toBe(false);
  }
  expect((await command('--start')).stdout).toContain('"ok":true');
  const readiness = await fetch(`http://127.0.0.1:${port}/health`);
  expect(readiness.status).toBe(200);
  expect(await readiness.json()).toMatchObject({ ok: true, pid: expect.any(Number) });
  expect((await command('--project', project, 'join')).stdout).toContain('Delegator');
  expect((await command('--project', project, 'status')).stdout).toContain('Goal');
}, 30_000);

it('rejects a missing target even when another project has already used the service', async () => {
  await expect(run(process.execPath, [cli, 'status'], root)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Project Context'),
  });
  expect(fs.existsSync(path.join(root, '.pi'))).toBe(false);
  expect(
    (await run(process.execPath, [cli, '--project', project, 'status'], root)).stdout
  ).toContain('Goal');
});

it.each(['custom', 'global'])(
  'keeps same-name peers and their tasks separate in %s shared storage',
  async (storageMode) => {
    const targetProject = storageMode === 'custom' ? project : path.join(root, 'global-project');
    if (targetProject !== project) await initRepo(targetProject);
    const other = path.join(root, storageMode === 'custom' ? 'other' : 'global-other');
    await initRepo(other);
    const shared = path.join(root, 'shared');
    const scoped = (cwd: string, name: string, ...args: string[]) =>
      exec(process.execPath, [cli, ...args], {
        cwd,
        env: {
          ...env,
          PI_MESSENGER_DIR: storageMode === 'custom' ? shared : '',
          PI_MESSENGER_GLOBAL: storageMode === 'global' ? '1' : '0',
          PI_AGENT_NAME: name,
        },
        timeout: 15_000,
      });
    await scoped(targetProject, 'Same', 'run', 'start', '--goal', 'Storage project A');
    await scoped(targetProject, 'Same', 'join');
    await scoped(targetProject, 'Same', 'task', 'create', '--title', 'Only project A');
    await scoped(other, 'Same', 'run', 'start', '--goal', 'Storage project B');
    await scoped(other, 'Same', 'join');
    expect((await scoped(other, 'Same', 'task', 'list')).stdout).not.toContain('Only project A');
    await scoped(targetProject, 'Receiver', 'join');
    await scoped(targetProject, 'Same', 'send', 'Receiver', 'private contract A');
    expect((await scoped(targetProject, 'Receiver', 'inbox')).stdout).toContain(
      'private contract A'
    );
    expect((await scoped(other, 'Same', 'inbox')).stdout).not.toContain('private contract A');
    expect((await scoped(targetProject, 'Same', 'task', 'list')).stdout).toContain(
      'Only project A'
    );
    await scoped(targetProject, 'Same', 'abort');
    await scoped(other, 'Same', 'abort');
  }
);

it('admits one run, shares its tasks across sessions, and retains unfinished ownership after restart', async () => {
  const starts = await Promise.allSettled([
    command('run', 'start', '--goal', 'Objective A'),
    command('run', 'start', '--goal', 'Objective B'),
  ]);
  expect(starts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const started = JSON.parse(
    (starts.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ stdout: string }>)
      .value.stdout
  );
  expect(started.project).toBe(project);
  await command('run', 'join');
  await command('task', 'create', '--title', 'Shared run task');
  const newcomer = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...env, PI_AGENT_NAME: 'NewSession' },
      timeout: 15_000,
    });
  await newcomer('run', 'join');
  expect((await newcomer('task', 'list')).stdout).toContain('Shared run task');
  await coldRestart();
  const observed = JSON.parse((await command('run', 'status')).stdout);
  expect(observed).toMatchObject({ id: started.id, phase: 'Awaiting Handoff', consumedSteps: 0 });
  await expect(command('run', 'start', '--goal', 'Different objective')).rejects.toMatchObject({
    code: 1,
  });
  await command('abort');
  const later = JSON.parse((await command('run', 'start', '--goal', 'Later objective')).stdout);
  expect(later.id).not.toBe(started.id);
  await expect(
    exec(process.execPath, [cli, 'run', 'join'], {
      cwd: project,
      env: { ...env, PI_SWARM_RUN_ID: started.id },
      timeout: 15_000,
    })
  ).rejects.toMatchObject({ code: 1 });
});

it('actively delivers a verification failure to a real installed Pi host, while ordinary messages stay pull-based', async () => {
  await command('run', 'join');
  const requests: string[] = [];
  let rejectIncident = true;
  let sawRejectedIncident = false;
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(raw);
    const messages: Message[] = JSON.parse(raw).messages;
    const latest = JSON.stringify(messages.at(-1));
    if (rejectIncident && latest.includes('[Verification Failed]')) {
      sawRejectedIncident = true;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'deliberate model error after incident',
            type: 'invalid_request_error',
          },
        })
      );
      return;
    }
    // Each reply answers only incidents delivered after its previous handling.
    if (latest.includes('pause for critical regression'))
      return writeTurn(res, [bash('pause', 'sleep 3', 10)]);
    if (unanswered(messages, 'All-Dead Attribution Brief', 'HANDLED_ALL_DEAD'))
      return writeTurn(res, [say('HANDLED_ALL_DEAD')]);
    if (unanswered(messages, '[Verification Failed]', 'HANDLED_VERIFICATION'))
      return writeTurn(res, [say('HANDLED_VERIFICATION')]);
    writeTurn(res, [say('READY')]);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  const host = startPi(project, { ...env, PI_AGENT_NAME: 'Receiver' });
  const peer = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...env, PI_AGENT_NAME: 'Receiver', PI_SWARM_PEER_PID: String(host.pid) },
      timeout: 15_000,
    });
  try {
    host.prompt('ready');
    await vi.waitFor(
      () => expect(host.output.includes('READY'), host.output.slice(-2500)).toBe(true),
      { timeout: 15_000 }
    );
    await peer('run', 'join');
    const beforeRestart = JSON.parse((await command('run', 'status')).stdout);
    await coldRestart();
    expect(JSON.parse((await command('run', 'status')).stdout)).toMatchObject({
      id: beforeRestart.id,
      consumedSteps: beforeRestart.consumedSteps,
    });
    const turns = () => (host.output.match(/"type":"agent_start"/g) || []).length;
    const idleTurns = turns();
    await command('send', 'Receiver', 'ordinary contract');
    await sleep(500);
    expect(turns()).toBe(idleTurns);
    await peer('task', 'create', '--title', 'Verify critical delivery');
    await peer('task', 'claim', 'task-1');
    const priorOutput = host.output.length;
    host.prompt('pause for critical regression');
    await vi.waitFor(
      () => expect(host.output.slice(priorOutput)).toContain('tool_execution_start'),
      { timeout: 10_000 }
    );
    await expect(
      peer('task', 'done', 'task-1', 'test', '--verify', 'node -e "process.exit(7)"')
    ).rejects.toMatchObject({ code: 1 });
    await vi.waitFor(
      () => {
        expect(sawRejectedIncident).toBe(true);
        expect(host.output.slice(priorOutput)).toContain('agent_end');
      },
      { timeout: 10_000 }
    );
    expect(JSON.parse((await peer('notifications')).stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'Receiver', taskId: 'task-1', status: 'enqueued' }),
      ])
    );
    // The first arrival failed at the model; the incident arrives late on retry.
    rejectIncident = false;
    host.prompt('retry the pending critical incident');
    await vi.waitFor(
      () => expect(replies(host.output, 'HANDLED_VERIFICATION'), host.output.slice(-2500)).toBe(1),
      { timeout: 15_000 }
    );
    await vi.waitFor(
      async () =>
        expect(JSON.parse((await peer('notifications')).stdout)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 'verif-task-1-1',
              project,
              runId: beforeRestart.id,
              to: 'Receiver',
              taskId: 'task-1',
              status: 'handled',
            }),
          ])
        ),
      { timeout: 10_000 }
    );
    expect(
      requests.some(
        (raw) =>
          raw.includes('[Verification Failed]') &&
          raw.includes('Exit Code: 7') &&
          raw.includes(`Task: task-1`) &&
          raw.includes(`Run: ${beforeRestart.id}`) &&
          raw.includes(`Project: ${project}`) &&
          raw.includes('Incident: verif-task-1-1')
      )
    ).toBe(true);
    await sleep(800);
    expect(replies(host.output, 'HANDLED_VERIFICATION')).toBe(1);
    expect(
      JSON.parse((await peer('notifications')).stdout).filter(
        (n: { id: string }) => n.id === 'verif-task-1-1'
      )
    ).toHaveLength(1);
    const delegator = startPi(project, env);
    try {
      delegator.prompt('ready');
      await vi.waitFor(
        () => expect(delegator.output.includes('READY'), delegator.output.slice(-1000)).toBe(true),
        { timeout: 15_000 }
      );
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(
          peer('task', 'done', 'task-1', 'test', '--verify', 'node -e "process.exit(7)"')
        ).rejects.toMatchObject({ code: 1 });
      await vi.waitFor(
        () =>
          expect(replies(delegator.output, 'HANDLED_ALL_DEAD'), delegator.output.slice(-1500)).toBe(
            1
          ),
        { timeout: 15_000 }
      );
      // Every recovery tick enqueues the same all-dead incident again; a
      // service restart re-reads it. The wait outlasts the host watchdog's 5s
      // poll, the other all-dead path. The Delegator still handles it once.
      await coldRestart();
      await sleep(5500);
      expect(replies(delegator.output, 'HANDLED_ALL_DEAD'), delegator.output.slice(-1500)).toBe(1);
      expect(
        requests.some(
          (raw) =>
            raw.includes('All-Dead Attribution Brief') &&
            raw.includes(`Project: ${project}`) &&
            raw.includes(`Run: ${beforeRestart.id}`) &&
            raw.includes('Recipient: Delegator')
        )
      ).toBe(true);
      expect((await command('run', 'status')).stdout).toContain('Awaiting Handoff');
    } finally {
      await delegator.stop();
    }
  } finally {
    await host.stop();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 75_000);

it('suspends only the failing task after three actual replacement startup failures', async () => {
  await command('abort');
  await command('run', 'start', '--goal', 'Bound startup failures', '--max-steps', '20');
  await command('run', 'join');
  await command('task', 'create', '--title', 'Cannot start model');
  await command(
    'spawn',
    '--task-id',
    'task-1',
    '--model',
    'missing-provider/missing-model',
    'Attempt work'
  );
  await vi.waitFor(
    async () => {
      const state = JSON.parse((await command('run', 'status')).stdout);
      expect(state.handoffs['task-1']).toMatchObject({ failures: 3, suspended: true });
      expect(state.handoffs['task-1'].takenOver).not.toBe(true);
      expect(state.consumedSteps).toBe(0);
    },
    { timeout: 35_000, interval: 500 }
  );
  const history = (await command('spawn', 'history')).stdout;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect((await command('spawn', 'history')).stdout).toBe(history);
  expect((await command('task', 'show', 'task-1')).stdout).not.toContain('dead_end');
  expect((await command('task', 'show', 'task-1')).stdout).toContain('Verification attempts: 0');
  await command('task', 'create', '--title', 'Another usable task');
  await command('task', 'claim', 'task-2');
  expect(JSON.parse((await command('notifications')).stdout)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ to: 'Delegator', taskId: 'task-1', status: 'pending' }),
    ])
  );
}, 45_000);

it('recovers tracked and new source files through a real successor, reverifies, then archives overall acceptance', async () => {
  await command('abort');
  fs.writeFileSync(path.join(project, '.gitignore'), '.pi/\n.swarm/\nBLACKBOARD.md\n');
  fs.writeFileSync(path.join(project, 'tracked.txt'), 'original\n');
  fs.writeFileSync(
    path.join(project, 'accept.cjs'),
    "const f=require('fs');if(f.readFileSync('tracked.txt','utf8').trim()!=='recovered'||!f.existsSync('recovered.ts'))process.exit(1)\n"
  );
  await run('git', ['add', '.gitignore', 'tracked.txt', 'accept.cjs']);
  await run('git', [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'recovery baseline',
  ]);
  await run('git', ['config', 'user.name', 'Test']);
  await run('git', ['config', 'user.email', 'test@example.test']);
  const verify = 'node accept.cjs';
  const started = JSON.parse(
    (
      await command(
        'run',
        'start',
        '--goal',
        'Recover candidate',
        '--max-steps',
        '20',
        '--verify',
        verify
      )
    ).stdout
  );
  await command('run', 'join');
  await command('task', 'create', '--title', 'Recover source changes');
  let sawUnverified = false;
  let sawConflict = false;
  let hostEvolved = false;
  let requests = 0;
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    const recovering = raw.includes('Automatic Handoff for task-1');
    const failed = raw.includes('[Verification Failed]');
    const done = raw.includes('Verified recovery');
    let shell: string | undefined;
    if (!recovering)
      shell = `pi-messenger-swarm run join && pi-messenger-swarm task claim task-1 && printf 'recovered\\n' > tracked.txt && printf 'export const recovered = true;\\n' > recovered.ts && sleep 3 && kill -KILL "$PI_SWARM_PEER_PID"`;
    else if (!failed)
      shell = `pi-messenger-swarm run join && pi-messenger-swarm task claim task-1 && pi-messenger-swarm candidate show latest --task task-1 && pi-messenger-swarm candidate restore latest --task task-1 && pi-messenger-swarm task done task-1 'Unverified recovery' --verify 'node -e "process.exit(9)"'`;
    else if (
      raw.includes('Main branch evolved with conflicts.') &&
      !body.messages.some(
        (m: any) => m.role === 'tool' && String(m.content).includes('Summary: Verified recovery')
      )
    ) {
      sawConflict = true;
      shell = `git reset --soft "$(git -C "$PI_SWARM_PROJECT_ROOT" rev-parse HEAD)" && pi-messenger-swarm task done task-1 'Verified recovery' --verify '${verify}'`;
    } else if (!done) {
      sawUnverified =
        fs.readFileSync(path.join(project, 'tracked.txt'), 'utf8') === 'original\n' &&
        !fs.existsSync(path.join(project, 'recovered.ts'));
      if (!hostEvolved) {
        fs.writeFileSync(path.join(project, 'tracked.txt'), 'host evolved\n');
        await run('git', ['add', 'tracked.txt']);
        await run('git', ['commit', '-m', 'host evolves during recovery']);
        hostEvolved = true;
      }
      shell = `pi-messenger-swarm task done task-1 'Verified recovery' --verify '${verify}'`;
    }
    // Tool names/arguments in previous calls are history, not success evidence.
    if (
      body.messages.some(
        (m: any) =>
          m.role === 'tool' &&
          String(m.content).includes('Verified recovery') &&
          !String(m.content).includes('collision')
      )
    )
      shell = undefined;
    writeTurn(res, [shell ? bash(`call_${requests}`, shell, 20) : say('Recovery finished')]);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Original',
      '--model',
      'fixture/fixture',
      'Recover candidate'
    );
    await vi.waitFor(
      async () => expect((await command('task', 'show', 'task-1')).stdout).toContain('in_progress'),
      { timeout: 15_000 }
    );
    const beforeCrash = JSON.parse((await command('run', 'status')).stdout);
    expect(beforeCrash.consumedSteps).toBeGreaterThan(0);
    await coldRestart();
    expect(
      JSON.parse((await command('run', 'status')).stdout).consumedSteps
    ).toBeGreaterThanOrEqual(beforeCrash.consumedSteps);

    await vi.waitFor(
      async () => {
        const observed = JSON.parse((await command('run', 'show', started.id)).stdout);
        expect(observed.status, JSON.stringify(observed)).toBe('completed');
      },
      { timeout: 45_000, interval: 500 }
    );
    expect(sawUnverified).toBe(true);
    expect(sawConflict).toBe(true);
    expect(fs.readFileSync(path.join(project, 'tracked.txt'), 'utf8')).toBe('recovered\n');
    expect(fs.readFileSync(path.join(project, 'recovered.ts'), 'utf8')).toContain(
      'export const recovered'
    );
    const archived = JSON.parse((await command('run', 'show', started.id)).stdout);
    expect(archived.acceptance.exitCode).toBe(0);
    expect(archived.consumedSteps).toBeGreaterThan(0);
    expect(archived.consumedSteps).toBeLessThan(20);
    expect(JSON.parse((await command('run', 'status')).stdout).phase).toBe('No active run');
  } finally {
    await command('abort').catch(() => {});
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 60_000);

it('aborts one project without tripping another project sharing its service and storage', async () => {
  await command('run', 'start', '--goal', 'Abort only this project');
  await command('run', 'join');
  const other = path.join(root, 'other');
  const otherCommand = (...args: string[]) => run(process.execPath, [cli, ...args], other);
  const otherRun = JSON.parse(
    (await otherCommand('run', 'start', '--goal', 'Independent work')).stdout
  );
  await otherCommand('run', 'join');
  await otherCommand('task', 'create', '--title', 'Still usable');
  await command('abort');
  await otherCommand('task', 'claim', 'task-1');
  expect(JSON.parse((await otherCommand('run', 'status')).stdout)).toMatchObject({
    id: otherRun.id,
    consumedSteps: 0,
  });
  expect((await otherCommand('task', 'show', 'task-1')).stdout).toContain('in_progress');
  await otherCommand('abort');
});

it('persists an exhausted budget and physically stops peers without creating replacements', async () => {
  const started = JSON.parse(
    (await command('run', 'start', '--goal', 'Bound actual execution', '--max-steps', '3')).stdout
  );
  await command('run', 'join');
  await command('task', 'create', '--title', 'Consume bounded steps');
  const provider = createHttpServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Drain the model request. */
    }
    writeTurn(res, [bash(`call_${Date.now()}`, 'true', 5)]);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    await command('spawn', '--task-id', 'task-1', '--model', 'fixture/fixture', 'Consume steps');
    await vi.waitFor(
      async () =>
        expect(JSON.parse((await command('run', 'show', started.id)).stdout)).toMatchObject({
          status: 'aborted',
          consumedSteps: 3,
        }),
      { timeout: 15_000 }
    );
    await coldRestart();
    expect(JSON.parse((await command('run', 'show', started.id)).stdout)).toMatchObject({
      status: 'aborted',
      consumedSteps: 3,
      handoffs: {},
    });
    await vi.waitFor(
      async () => expect(JSON.parse((await command('--status')).stdout).runningSpawns).toBe(0),
      { timeout: 10_000 }
    );
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 35_000);

it('accepts a verified solution alongside a pruned hypothesis without blocking another project abort', async () => {
  const marker = path.join(project, '.pi', 'acceptance-started');
  const acceptance = `node -e "require('fs').writeFileSync('.pi/acceptance-started','yes'); setTimeout(()=>{},3500)"`;
  const started = JSON.parse(
    (
      await command(
        'run',
        'start',
        '--goal',
        'Alternative hypothesis succeeds',
        '--verify',
        acceptance
      )
    ).stdout
  );
  await command('run', 'join');
  await command('task', 'create', '--title', 'Pruned alternative');
  await command('task', 'claim', 'task-1');
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(
      command('task', 'done', 'task-1', 'fails', '--verify', 'node -e "process.exit(7)"')
    ).rejects.toMatchObject({ code: 1 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(fs.existsSync(marker)).toBe(false);
  expect(JSON.parse((await command('run', 'status')).stdout).status).toBe('active');
  await command('task', 'create', '--title', 'Successful alternative');
  await command('task', 'claim', 'task-2');
  await command('task', 'done', 'task-2', 'verified', '--verify', 'node -e "process.exit(0)"');
  const other = path.join(root, 'other');
  const otherCommand = (...args: string[]) => run(process.execPath, [cli, ...args], other);
  await otherCommand('run', 'start', '--goal', 'Emergency stop remains responsive');
  await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 10_000 });
  const before = Date.now();
  await otherCommand('abort');
  expect(Date.now() - before).toBeLessThan(2000);
  await vi.waitFor(
    async () =>
      expect(JSON.parse((await command('run', 'show', started.id)).stdout).status).toBe(
        'completed'
      ),
    { timeout: 12_000 }
  );
  expect(JSON.parse((await command('run', 'show', started.id)).stdout).acceptance.exitCode).toBe(0);
}, 30_000);

it('shares spawn admission between two installed service processes', async () => {
  const second = await secondService();
  // Hold model requests so accepted peers remain alive during both admissions.
  const provider = createHttpServer(async (req, _res) => {
    for await (const _chunk of req) {
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  await second('--start');
  try {
    await command('run', 'start', '--goal', 'Cross-process admission', '--concurrency', '1');
    // Two live callers cannot register one agent name at the same moment.
    await command('run', 'join');
    await second('run', 'join');
    const admissions = await Promise.allSettled([
      command('spawn', '--model', 'fixture/fixture', 'Hold first worker'),
      second('spawn', '--model', 'fixture/fixture', 'Hold second worker'),
    ]);
    expect(admissions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (admissions.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.stderr
    ).toContain('concurrency');

    await command('abort');
    await command('run', 'start', '--goal', 'Bound duplicate recovery', '--concurrency', '3');
    await command('run', 'join');
    await command('task', 'create', '--title', 'First recovery');
    await command('task', 'create', '--title', 'Second recovery');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--model',
      'fixture/fixture',
      'Wait for first recovery'
    );
    await second(
      'spawn',
      '--task-id',
      'task-2',
      '--model',
      'fixture/fixture',
      'Wait for second recovery'
    );
    const ids = [...(await command('spawn', 'list')).stdout.matchAll(/^- (\w+): /gm)].map(
      (m) => m[1]
    );
    expect(ids).toHaveLength(2);
    // Each service's process table lists the peer it started.
    const originalPids = await Promise.all(
      ids.map((id) => peerPid(command, id).catch(() => peerPid(second, id)))
    );
    fs.writeFileSync(
      path.join(project, '.pi/pi-messenger.json'),
      JSON.stringify({ maxConcurrentSpawns: 1 })
    );
    for (const pid of originalPids) process.kill(pid, 'SIGKILL');
    const spawned = async () => historyCount((await command('spawn', 'history')).stdout);
    await vi.waitFor(async () => expect(await spawned()).toBe(3), { timeout: 12_000 });
    await sleep(1200);
    expect(await spawned()).toBe(3);
    const handoffs = JSON.parse((await command('run', 'status')).stdout).handoffs;
    expect(Object.values(handoffs).filter((h: any) => h.successor)).toHaveLength(1);
    expect(
      Object.values(handoffs).every((h: any) => h.failures === 0),
      JSON.stringify(handoffs)
    ).toBe(true);
  } finally {
    await command('abort').catch(() => {});
    await second('--stop').catch(() => {});
    fs.rmSync(path.join(project, '.pi/pi-messenger.json'), { force: true });
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 30_000);

it('kills the selected run evaluator before a later run can be affected', async () => {
  const marker = path.join(project, '.pi', 'abort-acceptance-started');
  const late = path.join(project, 'late-evaluator-write.txt');
  const acceptance = `node -e "require('fs').writeFileSync('.pi/abort-acceptance-started','yes');setTimeout(()=>require('fs').writeFileSync('late-evaluator-write.txt','wrong run'),2200)"`;
  const started = JSON.parse(
    (await command('run', 'start', '--goal', 'Stop evaluator', '--verify', acceptance)).stdout
  );
  await command('run', 'join');
  await command('task', 'create', '--title', 'Verified prerequisite');
  await command('task', 'claim', 'task-1');
  await command('task', 'done', 'task-1', 'verified', '--verify', 'node -e "process.exit(0)"');
  await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), {
    timeout: 10_000,
    interval: 50,
  });
  await command('abort');
  const later = JSON.parse(
    (await command('run', 'start', '--goal', 'No writes from previous evaluator')).stdout
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(fs.existsSync(late)).toBe(false);
  expect(JSON.parse((await command('run', 'show', started.id)).stdout).status).toBe('aborted');
  expect(JSON.parse((await command('run', 'status')).stdout)).toMatchObject({
    id: later.id,
    status: 'active',
  });
  await command('abort');
}, 20_000);

it('keeps a verification failure pending when no Pi recipient is alive', async () => {
  await command('abort').catch(() => {});
  const started = JSON.parse(
    (await command('run', 'start', '--goal', 'Pending critical delivery')).stdout
  );
  await command('run', 'join');
  await command('task', 'create', '--title', 'Nobody is listening');
  await command('task', 'claim', 'task-1');
  const failed = await command(
    'task',
    'done',
    'task-1',
    'missing recipient',
    '--verify',
    'node -e "process.exit(7)"'
  ).then(
    () => {
      throw new Error('verification failure was reported as success');
    },
    (error: { code?: number; stderr?: string }) => error
  );
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain('exit code 7');
  const notes = JSON.parse((await command('notifications')).stdout);
  expect(notes).toEqual([
    expect.objectContaining({
      id: 'verif-task-1-1',
      project,
      runId: started.id,
      to: 'Delegator',
      taskId: 'task-1',
      status: 'pending',
    }),
  ]);
  expect(notes[0].text).toContain('Exit Code: 7');
  expect(notes[0].text).toContain(`Run: ${started.id}`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(JSON.parse((await command('notifications')).stdout)[0].status).toBe('pending');
  await command('abort');
});

it('delivers a merge conflict to the live peer and still rebases onto the evolved host', async () => {
  await command('abort').catch(() => {});
  await run('git', ['config', 'user.name', 'Test']);
  await run('git', ['config', 'user.email', 'test@example.test']);
  fs.writeFileSync(path.join(project, 'shared.txt'), 'base\n');
  await run('git', ['add', 'shared.txt']);
  await run('git', ['commit', '-m', 'shared base']);
  let calls = 0;
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const messages: Message[] = JSON.parse(raw).messages;
    // The incident arrives while the READY tool is still running.
    writeTurn(
      res,
      unanswered(messages, 'Incident: conflict-task-1-1', 'HANDLED_CONFLICT')
        ? [say('HANDLED_CONFLICT'), bash(`call_${++calls}`, 'sleep 25', 40)]
        : [bash(`call_${++calls}`, 'pi-messenger-swarm run join && echo READY && sleep 12', 30)]
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  const started = JSON.parse(
    (await command('run', 'start', '--goal', 'Deliver the merge conflict', '--max-steps', '20'))
      .stdout
  );
  await command('run', 'join');
  await command('task', 'create', '--title', 'Edit shared');
  const merger = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...env, PI_AGENT_NAME: 'Merger' },
      timeout: 20_000,
    });
  try {
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Merger',
      '--model',
      'fixture/fixture',
      'Hold for conflict'
    );
    const listed = (await command('spawn', 'list')).stdout;
    const id = listed.match(/^- (\w+): Merger /m)?.[1];
    expect(id, listed).toBeTruthy();
    const sandbox = path.join(project, '.swarm', 'workspaces', `worker-${id}`);
    await vi.waitFor(
      async () => expect((await command('ps', 'logs', id!)).stdout).toContain('READY'),
      {
        timeout: 15_000,
      }
    );
    fs.writeFileSync(path.join(sandbox, 'shared.txt'), 'sandbox\n');
    fs.writeFileSync(path.join(project, 'shared.txt'), 'host\n');
    await run('git', ['add', 'shared.txt']);
    await run('git', ['commit', '-m', 'host evolves shared']);
    await merger('task', 'claim', 'task-1');
    const collided = await merger(
      'task',
      'done',
      'task-1',
      'try merge',
      '--verify',
      'node -e "process.exit(0)"'
    ).then(
      () => {
        throw new Error('merge conflict was reported as success');
      },
      (error: { code?: number; stderr?: string }) => error
    );
    expect(collided.code).toBe(1);
    expect(collided.stderr).toContain(
      'Main branch evolved with conflicts. Rebase your sandbox onto latest HEAD and re-verify!'
    );
    const handled = async () =>
      replies((await command('ps', 'logs', id!)).stdout, 'HANDLED_CONFLICT');
    await vi.waitFor(async () => expect(await handled()).toBe(1), { timeout: 30_000 });
    const notes = JSON.parse((await merger('notifications')).stdout);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'conflict-task-1-1',
          project,
          runId: started.id,
          to: 'Merger',
          taskId: 'task-1',
          status: 'handled',
        }),
      ])
    );
    await sleep(700);
    expect(await handled()).toBe(1);
    const head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
    await run('git', ['reset', '--soft', head], sandbox);
    await merger('task', 'done', 'task-1', 'rebased', '--verify', 'node -e "process.exit(0)"');
    expect(fs.readFileSync(path.join(project, 'shared.txt'), 'utf8')).toBe('sandbox\n');
    expect((await run('git', ['status', '--porcelain'])).stdout).not.toContain('shared.txt');
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 70_000);

it('does not deliver a critical incident to the same peer name in another project or a later run', async () => {
  await command('abort').catch(() => {});
  const storage = path.join(root, 'shared-critical');
  fs.mkdirSync(storage, { recursive: true });
  const alpha = path.join(root, 'alpha-project');
  const side = path.join(root, 'side-project');
  fs.mkdirSync(alpha);
  fs.mkdirSync(side);
  const sideEnv = { ...env, PI_MESSENGER_DIR: storage };
  const alphaEnv = { ...env, PI_MESSENGER_DIR: storage, PI_AGENT_NAME: 'Twin' };
  const sideCmd = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { cwd: side, env: sideEnv, timeout: 20_000 });
  const homeCmd = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { cwd: alpha, env: alphaEnv, timeout: 20_000 });
  for (const dir of [alpha, side]) await initRepo(dir);
  const first = JSON.parse(
    (await homeCmd('run', 'start', '--goal', 'Isolate critical delivery')).stdout
  );
  await homeCmd('run', 'join');
  await homeCmd('task', 'create', '--title', 'Owned by Twin');
  await homeCmd('task', 'claim', 'task-1');
  await expect(
    homeCmd('task', 'done', 'task-1', 'fail', '--verify', 'node -e "process.exit(7)"')
  ).rejects.toMatchObject({ code: 1 });
  const requests: string[] = [];
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(raw);
    writeTurn(res, [say('READY')]);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  const other = startPi(side, { ...sideEnv, PI_AGENT_NAME: 'Twin' });
  try {
    await sideCmd('run', 'start', '--goal', 'Other project');
    await sideCmd('run', 'join');
    other.prompt('ready');
    await vi.waitFor(
      () => expect(other.output.includes('READY'), other.output.slice(-1500)).toBe(true),
      { timeout: 15_000 }
    );
    await sleep(800);
    expect(other.output).not.toContain('Incident: verif-task-1-1');
    expect(requests.some((raw) => raw.includes('Incident: verif-task-1-1'))).toBe(false);
    expect(JSON.parse((await sideCmd('notifications')).stdout)).toEqual([]);
    expect(JSON.parse((await homeCmd('notifications', '--run', first.id)).stdout)).toEqual([
      expect.objectContaining({
        id: 'verif-task-1-1',
        project: alpha,
        runId: first.id,
        status: 'pending',
      }),
    ]);
    await other.stop();
    await homeCmd('abort');
    const later = JSON.parse(
      (await homeCmd('run', 'start', '--goal', 'Later run same peer')).stdout
    );
    await homeCmd('run', 'join');
    const again = startPi(alpha, alphaEnv);
    try {
      again.prompt('ready later');
      await vi.waitFor(
        () => expect(again.output.includes('READY'), again.output.slice(-1500)).toBe(true),
        { timeout: 15_000 }
      );
      await sleep(800);
      expect(again.output).not.toContain('Incident: verif-task-1-1');
      expect(JSON.parse((await homeCmd('notifications')).stdout)).toEqual([]);
      expect(JSON.parse((await homeCmd('notifications', '--run', first.id)).stdout)[0].status).toBe(
        'pending'
      );
      expect(later.id).not.toBe(first.id);
    } finally {
      await again.stop();
    }
  } finally {
    await other.stop();
    await homeCmd('abort').catch(() => {});
    await sideCmd('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 60_000);

function useFixture(port: number) {
  fs.mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 2048 }],
        },
      },
    })
  );
}

it('preserves an unverified candidate and lets an explicit successor restore and reverify it', async () => {
  await command('abort').catch(() => {});
  await run('git', ['config', 'user.name', 'Test']);
  await run('git', ['config', 'user.email', 'test@example.test']);
  fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(project, 'node_modules', 'keep.txt'), 'host dependency\n');
  fs.writeFileSync(path.join(project, 'handoff-tracked.txt'), 'original\n');
  await run('git', ['add', 'handoff-tracked.txt']);
  await run('git', ['commit', '-m', 'handoff baseline']);
  let turns = 0;
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const shell = raw.includes('selective restore')
      ? 'pi-messenger-swarm run join && for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do pi-messenger-swarm task claim task-1 && break; sleep 1; done && pi-messenger-swarm candidate show latest --task task-1 && pi-messenger-swarm candidate restore latest --task task-1 --include handoff-created.ts && echo RESTORED_SELECTED && sleep 40'
      : "printf 'changed\\n' > handoff-tracked.txt && printf 'export const created = true;\\n' > handoff-created.ts && sleep 1 && kill -KILL \"$PI_SWARM_PEER_PID\"";
    writeToolTurn(res, `edit_${++turns}`, shell);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  const started = JSON.parse(
    (await command('run', 'start', '--goal', 'Preserve a handoff candidate', '--max-steps', '20'))
      .stdout
  );
  await command('run', 'join');
  await command('task', 'create', '--title', 'Unfinished source');
  await command('task', 'claim', 'task-1');
  const beta = path.join(root, 'beta-candidate');
  await initRepo(beta);
  const betaCmd = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { cwd: beta, env, timeout: 20_000 });
  const successor = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...env, PI_AGENT_NAME: 'Successor' },
      timeout: 20_000,
    });
  try {
    await betaCmd('run', 'start', '--goal', 'Other project candidates');
    await betaCmd('run', 'join');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Editor',
      '--model',
      'fixture/fixture',
      'leave a candidate'
    );
    const editorId = (await command('spawn', 'list')).stdout.match(/^- (\w+): Editor /m)?.[1];
    expect(editorId).toBeTruthy();
    const editorSandbox = path.join(project, '.swarm', 'workspaces', `worker-${editorId}`);
    await vi.waitFor(
      async () => {
        const listed = JSON.parse((await command('candidate', 'list', '--task', 'task-1')).stdout);
        expect(listed[0]).toMatchObject({
          project,
          runId: started.id,
          taskId: 'task-1',
          peer: 'Editor',
          status: 'unverified',
        });
      },
      { timeout: 15_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await command('spawn', 'list')).stdout).toContain('No spawned agents');
    expect(fs.existsSync(editorSandbox)).toBe(false);
    const shown = (await command('candidate', 'show', 'latest', '--task', 'task-1')).stdout;
    expect(shown).toContain('"status":"unverified"');
    expect(shown).toContain('handoff-tracked.txt');
    expect(shown).toContain('handoff-created.ts');
    expect(fs.readFileSync(path.join(project, 'handoff-tracked.txt'), 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(project, 'handoff-created.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(project, 'node_modules', 'keep.txt'), 'utf8')).toBe(
      'host dependency\n'
    );
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Verification attempts: 0');
    expect(JSON.parse((await betaCmd('candidate', 'list')).stdout)).toEqual([]);
    const candidateId = JSON.parse((await command('candidate', 'list')).stdout)[0].id;
    const outOfScope = { code: 1, stderr: expect.stringContaining('not found in this run') };
    await expect(betaCmd('candidate', 'show', candidateId)).rejects.toMatchObject(outOfScope);
    await expect(betaCmd('candidate', 'restore', candidateId)).rejects.toMatchObject(outOfScope);

    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Successor',
      '--model',
      'fixture/fixture',
      'selective restore'
    );
    await command('task', 'unclaim', 'task-1');
    const successorId = (await command('spawn', 'list')).stdout.match(/^- (\w+): Successor /m)?.[1];
    expect(successorId, (await command('spawn', 'list')).stdout).toBeTruthy();
    const sandbox = path.join(project, '.swarm', 'workspaces', `worker-${successorId}`);
    await vi.waitFor(
      async () =>
        expect((await command('ps', 'logs', successorId!)).stdout).toContain(
          'Candidate restored as UNVERIFIED'
        ),
      { timeout: 25_000 }
    );
    expect(fs.readFileSync(path.join(sandbox, 'handoff-created.ts'), 'utf8')).toContain(
      'export const created'
    );
    expect(fs.readFileSync(path.join(sandbox, 'handoff-tracked.txt'), 'utf8')).toBe('original\n');
    expect(fs.readFileSync(path.join(project, 'handoff-tracked.txt'), 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(project, 'handoff-created.ts'))).toBe(false);
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Status: in_progress');
    await expect(
      successor('task', 'done', 'task-1', 'not yet', '--verify', 'node -e "process.exit(9)"')
    ).rejects.toMatchObject({ code: 1 });
    expect(fs.existsSync(path.join(project, 'handoff-created.ts'))).toBe(false);
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Verification attempts: 1');
    await successor(
      'task',
      'done',
      'task-1',
      'reverified',
      '--verify',
      "node -e \"if(!require('fs').existsSync('handoff-created.ts'))process.exit(1)\""
    );
    expect(fs.readFileSync(path.join(project, 'handoff-created.ts'), 'utf8')).toContain(
      'export const created'
    );
    expect(fs.readFileSync(path.join(project, 'handoff-tracked.txt'), 'utf8')).toBe('original\n');
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Status: verified');
    expect((await run('git', ['status', '--porcelain'])).stdout).not.toContain(
      'handoff-created.ts'
    );
    await command('abort');
    const later = JSON.parse(
      (await command('run', 'start', '--goal', 'Later run candidates')).stdout
    );
    await command('run', 'join');
    expect(later.id).not.toBe(started.id);
    expect(JSON.parse((await command('candidate', 'list')).stdout)).toEqual([]);
    await expect(command('candidate', 'show', 'latest')).rejects.toMatchObject({ code: 1 });
    await expect(command('candidate', 'show', candidateId)).rejects.toMatchObject(outOfScope);
    await expect(command('candidate', 'restore', candidateId)).rejects.toMatchObject(outOfScope);
    await command('abort');
    await betaCmd('abort');
  } finally {
    await command('abort').catch(() => {});
    await betaCmd('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 70_000);

it('keeps the sandbox when preservation fails, still hands off another task, and saves no candidate on abort', async () => {
  await command('abort').catch(() => {});
  fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(project, 'node_modules', 'keep.txt'), 'host dependency\n');
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (raw.includes('Automatic Handoff for task-2'))
      return writeToolTurn(res, 'successor', 'echo SUCCESSOR_READY && sleep 30');
    if (raw.includes('exit for a successor'))
      return writeToolTurn(res, 'leave', 'sleep 1 && kill -KILL "$PI_SWARM_PEER_PID"');
    const shell = raw.includes('do not preserve on abort')
      ? "printf 'abort me\\n' > abort-note.txt && echo READY && sleep 30"
      : 'pi-messenger-swarm run join && echo READY && sleep 30';
    writeToolTurn(res, raw.includes('do not preserve on abort') ? 'abort' : 'broken', shell);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    const broken = JSON.parse(
      (
        await command(
          'run',
          'start',
          '--goal',
          'Fail preservation',
          '--max-steps',
          '20',
          '--concurrency',
          '3'
        )
      ).stdout
    );
    await command('run', 'join');
    await command('task', 'create', '--title', 'Broken sandbox');
    await command('task', 'create', '--title', 'Handed off despite the broken sandbox');
    await command('task', 'claim', 'task-1');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Broken',
      '--model',
      'fixture/fixture',
      'sleep until git is removed'
    );
    const brokenId = (await command('spawn', 'list')).stdout.match(/^- (\w+): Broken /m)?.[1];
    expect(brokenId).toBeTruthy();
    const sandbox = path.join(project, '.swarm', 'workspaces', `worker-${brokenId}`);
    await vi.waitFor(
      async () => expect((await command('ps', 'logs', brokenId!)).stdout).toContain('READY'),
      { timeout: 15_000 }
    );
    fs.rmSync(path.join(sandbox, '.git'), { force: true });
    process.kill(await peerPid(command, brokenId!), 'SIGKILL');
    await vi.waitFor(
      async () =>
        expect((await command('spawn', 'history')).stdout).toContain(
          'Candidate preservation failed; Sandbox retained'
        ),
      { timeout: 10_000 }
    );
    // Every later tick retries the broken Sandbox; another task still moves.
    await command(
      'spawn',
      '--task-id',
      'task-2',
      '--name',
      'Leaver',
      '--model',
      'fixture/fixture',
      'exit for a successor'
    );
    await vi.waitFor(
      async () => {
        const handoffs = JSON.parse((await command('run', 'status')).stdout).handoffs;
        expect(handoffs['task-2']?.successor).toBeTruthy();
        expect((await command('ps', 'logs', handoffs['task-2'].successor)).stdout).toContain(
          'SUCCESSOR_READY'
        );
      },
      { timeout: 20_000 }
    );
    expect(fs.existsSync(sandbox)).toBe(true);
    expect(JSON.parse((await command('run', 'status')).stdout).handoffs['task-1']).toBeUndefined();
    expect((await command('spawn', 'history')).stdout).toMatch(
      new RegExp(`${brokenId}: Broken .*Candidate preservation failed; Sandbox retained`)
    );
    expect(JSON.parse((await command('candidate', 'list')).stdout)).toEqual([]);
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Status: in_progress');
    await command('abort');
    expect(JSON.parse((await command('run', 'show', broken.id)).stdout).status).toBe('aborted');

    const aborted = JSON.parse(
      (await command('run', 'start', '--goal', 'Abort is not preservation', '--max-steps', '10'))
        .stdout
    );
    await command('run', 'join');
    await command('task', 'create', '--title', 'Live until abort');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Live',
      '--model',
      'fixture/fixture',
      'do not preserve on abort'
    );
    const liveId = (await command('spawn', 'list')).stdout.match(/^- (\w+): Live /m)?.[1];
    await vi.waitFor(
      async () => expect((await command('ps', 'logs', liveId!)).stdout).toContain('READY'),
      { timeout: 15_000 }
    );
    await command('abort');
    // candidate list only reads the active run; an aborted run has no public entry.
    const saved = path.join(project, '.pi', 'messenger', 'candidates', aborted.id);
    expect(
      fs.existsSync(saved) ? fs.readdirSync(saved).filter((name) => name.endsWith('.json')) : []
    ).toEqual([]);
    expect(JSON.parse((await command('run', 'show', aborted.id)).stdout).status).toBe('aborted');
    expect(fs.readFileSync(path.join(project, 'node_modules', 'keep.txt'), 'utf8')).toBe(
      'host dependency\n'
    );
    expect(fs.existsSync(path.join(project, 'abort-note.txt'))).toBe(false);
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 45_000);

it('keeps the sandbox of a peer adopted across a restart when its candidate cannot be saved', async () => {
  await command('abort').catch(() => {});
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    writeToolTurn(res, `adopted_${raw.length}`, 'echo READY && sleep 30');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    await command('run', 'start', '--goal', 'Reconcile an adopted peer', '--max-steps', '20');
    await command('run', 'join');
    await command('task', 'create', '--title', 'Adopted work');
    await command('task', 'claim', 'task-1');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Adopted',
      '--model',
      'fixture/fixture',
      'wait across a restart'
    );
    const adoptedId = spawnedId((await command('spawn', 'list')).stdout, 'Adopted');
    expect(adoptedId).toBeTruthy();
    const sandbox = path.join(project, '.swarm', 'workspaces', `worker-${adoptedId}`);
    await vi.waitFor(
      async () => expect((await command('ps', 'logs', adoptedId!)).stdout).toContain('READY'),
      { timeout: 15_000 }
    );
    const adoptedPid = await peerPid(command, adoptedId!);
    await coldRestart();
    expect(spawnedId((await command('spawn', 'list')).stdout, 'Adopted')).toBe(adoptedId);
    // A dangling gitdir stops git from falling back to the enclosing host repository.
    fs.writeFileSync(path.join(sandbox, '.git'), 'gitdir: /nonexistent\n');
    process.kill(-adoptedPid, 'SIGKILL');
    await vi.waitFor(() => expect(() => process.kill(adoptedPid, 0)).toThrow(), {
      timeout: 5000,
      interval: 10,
    });
    // spawn list reconciles the dead adopted peer itself, before any 5s liveness poll.
    expect((await command('spawn', 'list')).stdout).toContain('No spawned agents');
    expect((await command('spawn', 'history')).stdout).toMatch(
      new RegExp(`${adoptedId}: Adopted .*Candidate preservation failed; Sandbox retained`)
    );
    expect(fs.existsSync(sandbox)).toBe(true);
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 45_000);

it('does not let a saved candidate revive pruned work or reset its verification attempts', async () => {
  await command('abort').catch(() => {});
  const provider = createHttpServer(async (req, res) => {
    for await (const _chunk of req) {
      /* The peer only has to leave a file and exit. */
    }
    writeToolTurn(
      res,
      'prune',
      'printf \'draft\\n\' > pruned-note.txt && sleep 1 && kill -KILL "$PI_SWARM_PEER_PID"'
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    await command('run', 'start', '--goal', 'Pruned work stays pruned', '--max-steps', '10');
    await command('run', 'join');
    await command('task', 'create', '--title', 'Already disproved');
    await command('task', 'claim', 'task-1');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Draft',
      '--model',
      'fixture/fixture',
      'leave a pruned candidate'
    );
    await vi.waitFor(
      async () => {
        const listed = JSON.parse((await command('candidate', 'list', '--task', 'task-1')).stdout);
        expect(listed[0]).toMatchObject({ peer: 'Draft', status: 'unverified', taskId: 'task-1' });
      },
      { timeout: 15_000 }
    );
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(
        command('task', 'done', 'task-1', 'fails', '--verify', 'node -e "process.exit(7)"')
      ).rejects.toMatchObject({ code: 1 });
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Status: dead_end');
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Verification attempts: 3');
    await expect(
      command('candidate', 'restore', 'latest', '--task', 'task-1')
    ).rejects.toMatchObject({
      code: 1,
    });
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Status: dead_end');
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Verification attempts: 3');
    expect(
      JSON.parse((await command('candidate', 'list', '--task', 'task-1')).stdout)[0].status
    ).toBe('unverified');
    expect(fs.existsSync(path.join(project, 'pruned-note.txt'))).toBe(false);
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 30_000);

it('suspends automatic handoff after three startup failures and resumes only when asked', async () => {
  await command('abort').catch(() => {});
  const requests: string[] = [];
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(raw);
    const messages: Message[] = JSON.parse(raw).messages;
    writeTurn(res, [
      say(
        unanswered(messages, 'Automatic Handoff suspended', 'HANDLED_SUSPENSION')
          ? 'HANDLED_SUSPENSION'
          : 'READY'
      ),
    ]);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  const delegator = startPi(project, env);
  const other = path.join(root, 'handoff-other');
  await initRepo(other);
  const otherCmd = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd: other,
      env: { ...env, PI_AGENT_NAME: 'OtherPeer' },
      timeout: 20_000,
    });
  const asDelegator = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...env, PI_AGENT_NAME: 'Delegator', PI_SWARM_PEER_PID: String(process.pid) },
      timeout: 20_000,
    });
  try {
    delegator.prompt('ready');
    await vi.waitFor(
      () => expect(delegator.output.includes('READY'), delegator.output.slice(-1500)).toBe(true),
      { timeout: 15_000 }
    );
    await asDelegator('run', 'start', '--goal', 'Suspend then resume', '--max-steps', '100000');
    await asDelegator('run', 'join');
    await asDelegator('task', 'create', '--title', 'Cannot take over');
    await asDelegator('task', 'create', '--title', 'Still eligible');
    await asDelegator(
      'spawn',
      '--task-id',
      'task-1',
      '--model',
      'missing-provider/missing-model',
      'Attempt work'
    );
    await vi.waitFor(
      async () => {
        const state = JSON.parse((await asDelegator('run', 'status')).stdout);
        expect(state.handoffs['task-1']).toMatchObject({ failures: 3, suspended: true });
        expect(state.handoffs['task-1'].takenOver).not.toBe(true);
      },
      { timeout: 35_000, interval: 500 }
    );
    // Each tick re-enqueues the suspension; the Delegator handles it once.
    await vi.waitFor(
      () =>
        expect(replies(delegator.output, 'HANDLED_SUSPENSION'), delegator.output.slice(-2000)).toBe(
          1
        ),
      { timeout: 15_000 }
    );
    expect(
      requests.some(
        (raw) =>
          raw.includes('Automatic Handoff suspended') &&
          raw.includes('Verification attempts unchanged')
      )
    ).toBe(true);
    const notes = JSON.parse((await asDelegator('notifications')).stdout);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'Delegator', taskId: 'task-1', status: 'handled' }),
      ])
    );
    const history = (await asDelegator('spawn', 'history')).stdout;
    await sleep(1200);
    expect((await asDelegator('spawn', 'history')).stdout).toBe(history);
    expect(replies(delegator.output, 'HANDLED_SUSPENSION')).toBe(1);
    expect((await asDelegator('task', 'show', 'task-1')).stdout).toContain(
      'Verification attempts: 0'
    );
    await asDelegator('task', 'claim', 'task-2');
    expect((await asDelegator('task', 'show', 'task-2')).stdout).toContain('Status: in_progress');
    await otherCmd('run', 'start', '--goal', 'Other project during suspension');
    await otherCmd('run', 'join');
    await otherCmd('task', 'create', '--title', 'Independent');
    await otherCmd('task', 'claim', 'task-1');
    expect((await otherCmd('task', 'show', 'task-1')).stdout).toContain('Status: in_progress');
    await asDelegator('handoff', 'resume', 'task-1');
    const resumed = JSON.parse((await asDelegator('handoff', 'status')).stdout);
    expect(resumed['task-1'].suspended).toBe(false);
    expect(resumed['task-1'].failures).toBe(0);
    await vi.waitFor(
      async () => {
        const state = JSON.parse((await asDelegator('run', 'status')).stdout);
        expect(state.handoffs['task-1'].suspended).not.toBe(true);
        expect((await asDelegator('spawn', 'history')).stdout).not.toBe(history);
      },
      { timeout: 15_000 }
    );
    expect((await asDelegator('task', 'show', 'task-1')).stdout).toContain(
      'Verification attempts: 0'
    );
    expect((await asDelegator('task', 'show', 'task-1')).stdout).not.toContain('dead_end');
    const active = JSON.parse((await asDelegator('run', 'status')).stdout);
    await asDelegator('abort');
    // Every automatic spawn records its successor and start time in the run.
    const aborted = JSON.parse((await asDelegator('run', 'show', active.id)).stdout);
    expect(aborted.status).toBe('aborted');
    await sleep(1500);
    expect(JSON.parse((await asDelegator('run', 'show', active.id)).stdout).handoffs).toEqual(
      aborted.handoffs
    );
    await otherCmd('abort');
  } finally {
    await delegator.stop();
    await command('abort').catch(() => {});
    await otherCmd('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 70_000);

it('does not replace a task that a live peer still holds, and never merges a patch missing new files', async () => {
  await command('abort').catch(() => {});
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const shell = raw.includes('hold the lease')
      ? 'pi-messenger-swarm run join && pi-messenger-swarm task claim task-1 && echo HOLDING && sleep 25'
      : 'echo QUIT && kill -KILL "$PI_SWARM_PEER_PID"';
    writeToolTurn(res, raw.includes('hold the lease') ? 'hold' : 'quit', shell);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    await command(
      'run',
      'start',
      '--goal',
      'Respect a live lease',
      '--max-steps',
      '20',
      '--concurrency',
      '2'
    );
    await command('run', 'join');
    await command('task', 'create', '--title', 'Held by a live peer');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Holder',
      '--model',
      'fixture/fixture',
      'hold the lease'
    );
    const holderId = (await command('spawn', 'list')).stdout.match(/^- (\w+): Holder /m)?.[1];
    await vi.waitFor(
      async () => expect((await command('ps', 'logs', holderId!)).stdout).toContain('HOLDING'),
      { timeout: 15_000 }
    );
    const before = (await command('spawn', 'history')).stdout;
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Quitter',
      '--model',
      'fixture/fixture',
      'exit immediately'
    );
    await vi.waitFor(
      async () => expect((await command('spawn', 'history')).stdout).toContain('Quitter'),
      { timeout: 15_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Claimed by: Holder');
    expect((await command('spawn', 'list')).stdout).toContain('Holder');
    const names = (await command('spawn', 'history')).stdout;
    expect(names).toContain('Holder');
    expect(historyCount(names)).toBe(historyCount(before) + 1);

    // A failed intent-to-add must not verify and merge a patch lacking the new file.
    const sandbox = path.join(project, '.swarm', 'workspaces', `worker-${holderId}`);
    fs.writeFileSync(path.join(sandbox, 'held-new.ts'), 'export const held = true;\n');
    const gitDir = (await run('git', ['rev-parse', '--absolute-git-dir'], sandbox)).stdout.trim();
    fs.writeFileSync(path.join(gitDir, 'index.lock'), '');
    const holder = (...args: string[]) =>
      exec(process.execPath, [cli, ...args], {
        cwd: project,
        env: { ...env, PI_AGENT_NAME: 'Holder' },
        timeout: 20_000,
      });
    const verified = [
      'task',
      'done',
      'task-1',
      'new file',
      '--verify',
      'node -e "process.exit(0)"',
    ];
    await expect(holder(...verified)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Failed to generate patch'),
    });
    expect(fs.existsSync(path.join(project, 'held-new.ts'))).toBe(false);
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Status: in_progress');
    fs.rmSync(path.join(gitDir, 'index.lock'));
    await holder(...verified);
    expect(fs.readFileSync(path.join(project, 'held-new.ts'), 'utf8')).toContain('held');
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 40_000);

const as =
  (name: string, cwd = project, extra: NodeJS.ProcessEnv = {}) =>
  (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd,
      env: { ...env, ...extra, PI_AGENT_NAME: name },
      timeout: 20_000,
    });

it('creates no successor for pruned, finished or completed work, even after late exits and a restart', async () => {
  await command('abort').catch(() => {});
  const provider = createHttpServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Every peer only holds its Sandbox. */
    }
    writeToolTurn(res, 'hold', 'pi-messenger-swarm run join && echo HOLDING && sleep 60');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    const started = JSON.parse(
      (
        await command(
          'run',
          'start',
          '--goal',
          'Forbidden replacement',
          '--max-steps',
          '50',
          '--concurrency',
          '3',
          '--verify',
          'node -e "process.exit(0)"'
        )
      ).stdout
    );
    await command('run', 'join');
    await command('task', 'create', '--title', 'Pruned hypothesis');
    await command('task', 'create', '--title', 'Finished work');
    const ids: Record<string, string> = {};
    for (const [task, name] of [
      ['task-1', 'Pruned'],
      ['task-2', 'Finisher'],
    ]) {
      await command(
        'spawn',
        '--task-id',
        task,
        '--name',
        name,
        '--model',
        'fixture/fixture',
        'hold'
      );
      ids[name] = spawnedId((await command('spawn', 'list')).stdout, name)!;
      await vi.waitFor(
        async () => expect((await command('ps', 'logs', ids[name])).stdout).toContain('HOLDING'),
        { timeout: 15_000 }
      );
      await as(name)('task', 'claim', task);
    }
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(
        as('Pruned')('task', 'done', 'task-1', 'fails', '--verify', 'node -e "process.exit(7)"')
      ).rejects.toMatchObject({ code: 1 });
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Status: dead_end');

    // The pruned peer's exit only arrives after the hypothesis was pruned.
    const history = (await command('spawn', 'history')).stdout;
    process.kill(await peerPid(command, ids.Pruned), 'SIGKILL');
    await vi.waitFor(
      async () => expect((await command('spawn', 'list')).stdout).not.toContain('Pruned'),
      { timeout: 10_000 }
    );
    await sleep(1500);
    expect(historyCount((await command('spawn', 'history')).stdout)).toBe(historyCount(history));
    expect(JSON.parse((await command('run', 'show', started.id)).stdout).handoffs).toEqual({});
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Status: dead_end');

    // Finished work leaves nothing eligible, so its peer's exit completes the run.
    await as('Finisher')(
      'task',
      'done',
      'task-2',
      'finished',
      '--verify',
      'node -e "process.exit(0)"'
    );
    expect((await command('task', 'show', 'task-2')).stdout).toContain('Status: verified');
    process.kill(await peerPid(command, ids.Finisher), 'SIGKILL');
    await vi.waitFor(
      async () =>
        expect(JSON.parse((await command('run', 'show', started.id)).stdout).status).toBe(
          'completed'
        ),
      { timeout: 15_000, interval: 300 }
    );
    expect(JSON.parse((await command('run', 'show', started.id)).stdout).handoffs).toEqual({});

    // A restarted service re-reads both late exits of the archived run.
    await coldRestart();
    await sleep(1500);
    expect(JSON.parse((await command('run', 'show', started.id)).stdout)).toMatchObject({
      status: 'completed',
      handoffs: {},
    });
    expect(JSON.parse((await command('run', 'status')).stdout).phase).toBe('No active run');
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 70_000);

it('admits exactly one successor per handoff across two services and a restart, and continues its accounting', async () => {
  await command('abort').catch(() => {});
  const successorRequests: string[] = [];
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const handoff = raw.includes('Automatic Handoff for task-1');
    if (handoff) successorRequests.push(raw);
    const tools = (JSON.parse(raw).messages as Message[]).filter((m) => m.role === 'tool').length;
    // The shell expands the name, so the marker exists only in real tool output.
    if (!tools)
      return writeToolTurn(
        res,
        'claim',
        'pi-messenger-swarm run join && pi-messenger-swarm task claim task-1 && echo "CLAIMED_BY_$PI_AGENT_NAME"'
      );
    writeToolTurn(res, `hold_${tools}`, 'sleep 60');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  const second = await secondService();
  try {
    await second('--start');
    const started = JSON.parse(
      (
        await command(
          'run',
          'start',
          '--goal',
          'Exactly one successor',
          '--max-steps',
          '40',
          '--concurrency',
          '3'
        )
      ).stdout
    );
    // Two live callers cannot register one agent name at the same moment.
    await command('run', 'join');
    await second('run', 'join');
    await command('task', 'create', '--title', 'Hand off once');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Original',
      '--model',
      'fixture/fixture',
      'Hand off once'
    );
    const originalId = spawnedId((await command('spawn', 'list')).stdout, 'Original')!;
    await vi.waitFor(
      async () => {
        expect((await command('ps', 'logs', originalId)).stdout).toContain('CLAIMED_BY_Original');
        expect(JSON.parse((await command('run', 'show', started.id)).stdout).consumedSteps).toBe(2);
      },
      { timeout: 15_000 }
    );
    await expect(
      as('Original')(
        'task',
        'done',
        'task-1',
        'first attempt',
        '--verify',
        `node -e "console.error('ORIGINAL_FAILURE_EVIDENCE');process.exit(7)"`
      )
    ).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse((await command('run', 'show', started.id)).stdout)).toMatchObject({
      maxSteps: 40,
      consumedSteps: 2,
    });
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Verification attempts: 1');

    // Both services observe this one exit. Holding the real run lock across
    // two recovery ticks queues both admissions behind it, so whichever
    // enters second does so with a snapshot taken before the first spawned.
    const originalPid = await peerPid(command, originalId);
    const runLock = path.join(project, '.pi/messenger/run.lock');
    while (true) {
      try {
        fs.mkdirSync(runLock);
        break;
      } catch {
        await sleep(5);
      }
    }
    fs.writeFileSync(path.join(runLock, 'pid'), String(process.pid));
    process.kill(originalPid, 'SIGKILL');
    await sleep(1200);
    fs.rmSync(runLock, { recursive: true, force: true });
    let successorId = '';
    await vi.waitFor(
      async () => {
        const handoff = JSON.parse((await command('run', 'status')).stdout).handoffs['task-1'];
        expect(handoff?.takenOver).toBe(true);
        successorId = handoff.successor;
      },
      { timeout: 20_000, interval: 300 }
    );
    const history = (await command('spawn', 'history')).stdout;
    const successorName = history.match(new RegExp(`^- ${successorId}: (\\S+) `, 'm'))?.[1];
    expect(historyCount(history), history).toBe(2);
    const logs = async () =>
      (await command('ps', 'logs', successorId)).stdout +
      (await second('ps', 'logs', successorId)).stdout;
    expect(await logs()).toContain(`CLAIMED_BY_${successorName}`);
    expect((await command('task', 'show', 'task-1')).stdout).toContain(
      `Claimed by: ${successorName}`
    );

    // The successor's model saw the predecessor's failure and the remaining budget.
    const prompt = (JSON.parse(successorRequests[0]).messages as Message[]).map(textOf).join('\n');
    expect(prompt).toContain('Remaining budget: 38');
    expect(prompt).toMatch(/Verification history: \{[^\n]*"exitCode":7/);
    expect(prompt).toContain('ORIGINAL_FAILURE_EVIDENCE');
    await vi.waitFor(
      async () =>
        expect(JSON.parse((await command('run', 'show', started.id)).stdout)).toMatchObject({
          maxSteps: 40,
          consumedSteps: 4,
        }),
      { timeout: 10_000 }
    );
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Verification attempts: 1');

    // A restarted service re-observes the same exit without a second successor.
    await coldRestart();
    await sleep(1500);
    expect(historyCount((await command('spawn', 'history')).stdout)).toBe(2);
    expect((await command('spawn', 'list')).stdout).toContain(successorName);
    expect(JSON.parse((await command('run', 'status')).stdout).handoffs['task-1']).toMatchObject({
      successor: successorId,
      takenOver: true,
      failures: 0,
    });
  } finally {
    await command('abort').catch(() => {});
    await second('--stop').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 70_000);

it('counts a successor that does not claim within 30 seconds as one takeover failure', async () => {
  await command('abort').catch(() => {});
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (raw.includes('Automatic Handoff for task-1'))
      return writeToolTurn(res, 'idle', 'echo "IDLE_$PI_AGENT_NAME" && sleep 90');
    writeToolTurn(
      res,
      'quit',
      'pi-messenger-swarm run join && pi-messenger-swarm task claim task-1 && sleep 1 && kill -KILL "$PI_SWARM_PEER_PID"'
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    await command('run', 'start', '--goal', 'Takeover deadline', '--max-steps', '40');
    await command('run', 'join');
    await command('task', 'create', '--title', 'Never claimed by the successor');
    await command(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Quitter',
      '--model',
      'fixture/fixture',
      'exit after claiming'
    );
    let first = '';
    await vi.waitFor(
      async () => {
        first = JSON.parse((await command('run', 'status')).stdout).handoffs['task-1']?.successor;
        expect(first).toBeTruthy();
        expect((await command('ps', 'logs', first)).stdout).toMatch(/IDLE_\w/);
      },
      { timeout: 20_000 }
    );
    await vi.waitFor(
      async () => {
        const handoff = JSON.parse((await command('run', 'status')).stdout).handoffs['task-1'];
        expect(handoff.failures).toBe(1);
        expect(handoff.errors[0]).toContain('Takeover timed out');
      },
      { timeout: 45_000, interval: 500 }
    );
    const handoff = JSON.parse((await command('run', 'status')).stdout).handoffs['task-1'];
    expect(handoff.takenOver).not.toBe(true);
    expect(handoff.suspended).not.toBe(true);
    expect((await command('spawn', 'list')).stdout).not.toContain(`- ${first}:`);
    expect((await command('task', 'show', 'task-1')).stdout).toContain('Verification attempts: 0');
    expect((await command('task', 'show', 'task-1')).stdout).not.toContain('dead_end');
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 80_000);

it('runs the packaged journey from shared storage to archived acceptance and the next run', async () => {
  await command('abort').catch(() => {});
  const storage = path.join(root, 'journey-shared');
  const journey = path.join(root, 'journey-a');
  const neighbour = path.join(root, 'journey-b');
  for (const dir of [journey, neighbour]) await initRepo(dir);
  fs.writeFileSync(
    path.join(journey, '.gitignore'),
    '.pi/\n.swarm/\nBLACKBOARD.md\nnode_modules/\n'
  );
  fs.writeFileSync(path.join(journey, 'tracked.txt'), 'original\n');
  fs.writeFileSync(
    path.join(journey, 'accept.cjs'),
    "const f=require('fs');if(f.readFileSync('tracked.txt','utf8')!=='journey\\n'||!f.existsSync('journey.ts'))process.exit(1)\n"
  );
  await run('git', ['add', '.'], journey);
  await run('git', ['commit', '-m', 'journey baseline'], journey);
  fs.mkdirSync(path.join(journey, 'node_modules'));
  fs.writeFileSync(path.join(journey, 'node_modules', 'keep.txt'), 'host dependency\n');
  fs.writeFileSync(path.join(journey, 'unrelated.txt'), 'not owned by the run\n');
  const shared = { PI_MESSENGER_DIR: storage };
  const a = as('Delegator', journey, shared);
  const b = as('Delegator', neighbour, shared);
  const seen = { hostCleanAfterFailure: false, attempts: '', successorPrompt: '' };
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const messages: Message[] = JSON.parse(raw).messages;
    const tools = messages.filter((m) => m.role === 'tool').length;
    if (raw.includes('Hold in neighbour'))
      return writeToolTurn(
        res,
        'neighbour',
        'pi-messenger-swarm run join && pi-messenger-swarm task claim task-1 && echo "NEIGHBOUR_$PI_AGENT_NAME" && sleep 120'
      );
    if (raw.includes('Automatic Handoff for task-1')) {
      if (!tools) {
        seen.successorPrompt = messages.map(textOf).join('\n');
        return writeToolTurn(
          res,
          'restore',
          `pi-messenger-swarm run join && pi-messenger-swarm task claim task-1 && pi-messenger-swarm candidate restore latest --task task-1 && (pi-messenger-swarm task done task-1 'Unverified journey' --verify 'node -e "process.exit(9)"'; sleep 2)`
        );
      }
      if (unanswered(messages, 'Incident: verif-task-1-2', 'HANDLED_REVERIFY')) {
        seen.hostCleanAfterFailure =
          fs.readFileSync(path.join(journey, 'tracked.txt'), 'utf8') === 'original\n' &&
          !fs.existsSync(path.join(journey, 'journey.ts'));
        seen.attempts = (await a('task', 'show', 'task-1')).stdout;
        return writeTurn(res, [
          say('HANDLED_REVERIFY'),
          bash(
            'reverify',
            `pi-messenger-swarm task done task-1 'Verified journey' --verify 'node accept.cjs'`
          ),
        ]);
      }
      return writeTurn(res, [say('JOURNEY_STEP_DONE')]);
    }
    if (!tools)
      return writeToolTurn(
        res,
        'attempt',
        `pi-messenger-swarm run join && pi-messenger-swarm task claim task-1 && printf 'journey\\n' > tracked.txt && printf 'export const journey = true;\\n' > journey.ts && (pi-messenger-swarm task done task-1 'first attempt' --verify 'node -e "process.exit(7)"'; sleep 2)`
      );
    if (unanswered(messages, 'Incident: verif-task-1-1', 'HANDLED_VERIFICATION'))
      return writeTurn(res, [
        say('HANDLED_VERIFICATION'),
        bash('crash', 'sleep 4 && kill -KILL "$PI_SWARM_PEER_PID"'),
      ]);
    writeTurn(res, [say('WAITING')]);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  try {
    // Two Projects share messaging storage, each with a peer named Twin.
    const started = JSON.parse(
      (
        await a(
          'run',
          'start',
          '--goal',
          'Packaged journey',
          '--max-steps',
          '30',
          '--verify',
          'node accept.cjs'
        )
      ).stdout
    );
    await a('run', 'join');
    await a('task', 'create', '--title', 'Journey task');
    const neighbourRun = JSON.parse((await b('run', 'start', '--goal', 'Neighbour')).stdout);
    await b('run', 'join');
    await b('task', 'create', '--title', 'Neighbour task');
    await b(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Twin',
      '--model',
      'fixture/fixture',
      'Hold in neighbour'
    );
    const neighbourId = spawnedId((await b('spawn', 'list')).stdout, 'Twin')!;
    await vi.waitFor(
      async () => expect((await b('ps', 'logs', neighbourId)).stdout).toContain('NEIGHBOUR_Twin'),
      { timeout: 15_000 }
    );
    await a(
      'spawn',
      '--task-id',
      'task-1',
      '--name',
      'Twin',
      '--model',
      'fixture/fixture',
      'Begin journey'
    );
    const twinId = spawnedId((await a('spawn', 'list')).stdout, 'Twin')!;

    // A real critical failure reaches the live Twin in this Project only.
    await vi.waitFor(
      async () => {
        expect(replies((await a('ps', 'logs', twinId)).stdout, 'HANDLED_VERIFICATION')).toBe(1);
        expect(JSON.parse((await a('notifications')).stdout)).toEqual([
          expect.objectContaining({
            id: 'verif-task-1-1',
            project: journey,
            runId: started.id,
            to: 'Twin',
            taskId: 'task-1',
            status: 'handled',
          }),
        ]);
      },
      { timeout: 20_000, interval: 200 }
    );

    // The Twin then exits unexpectedly, leaving an unverified candidate.
    await vi.waitFor(
      async () =>
        expect(
          JSON.parse((await a('candidate', 'list', '--task', 'task-1')).stdout)[0]
        ).toMatchObject({
          project: journey,
          runId: started.id,
          peer: 'Twin',
          status: 'unverified',
        }),
      { timeout: 20_000 }
    );
    await vi.waitFor(
      async () =>
        expect(JSON.parse((await a('run', 'show', started.id)).stdout).status).toBe('completed'),
      { timeout: 60_000, interval: 500 }
    );

    // Unchanged accounting: two predecessor steps, then two successor steps.
    expect(seen.successorPrompt).toContain('Remaining budget: 28');
    expect(seen.successorPrompt).toMatch(/Verification history: \{[^\n]*"exitCode":7/);
    expect(seen.attempts).toContain('Verification attempts: 2');
    expect(seen.hostCleanAfterFailure).toBe(true);
    const archived = JSON.parse((await a('run', 'show', started.id)).stdout);
    expect(archived).toMatchObject({ maxSteps: 30, consumedSteps: 4 });
    expect(archived.acceptance.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(journey, 'tracked.txt'), 'utf8')).toBe('journey\n');
    expect(fs.readFileSync(path.join(journey, 'journey.ts'), 'utf8')).toContain('journey');
    expect((await run('git', ['status', '--porcelain'], journey)).stdout.trim()).toBe(
      '?? unrelated.txt'
    );
    const next = JSON.parse((await a('run', 'start', '--goal', 'Next journey')).stdout);
    expect(next.id).not.toBe(started.id);

    // The neighbour never saw the incident and its run is untouched.
    expect((await b('ps', 'logs', neighbourId)).stdout).not.toContain('verif-task-1');
    expect(JSON.parse((await b('notifications')).stdout)).toEqual([]);
    expect((await b('task', 'list')).stdout).not.toContain('Journey task');
    const neighbourPid = await peerPid(b, neighbourId);

    // Service recovery keeps host dependencies and resources this run does not own.
    await coldRestart();
    expect(fs.readFileSync(path.join(journey, 'node_modules', 'keep.txt'), 'utf8')).toBe(
      'host dependency\n'
    );
    expect(fs.readFileSync(path.join(journey, 'unrelated.txt'), 'utf8')).toBe(
      'not owned by the run\n'
    );
    expect(() => process.kill(neighbourPid, 0)).not.toThrow();
    expect(
      fs.existsSync(path.join(neighbour, '.swarm', 'workspaces', `worker-${neighbourId}`))
    ).toBe(true);
    expect(JSON.parse((await b('run', 'status')).stdout)).toMatchObject({
      id: neighbourRun.id,
      status: 'active',
      consumedSteps: 1,
    });
    expect(JSON.parse((await a('run', 'status')).stdout)).toMatchObject({ id: next.id });
  } finally {
    await a('abort').catch(() => {});
    await b('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
