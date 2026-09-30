import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:net';

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
  fs.mkdirSync(project);
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
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
  await run('git', ['init'], project);
  await run(
    'git',
    [
      '-c',
      'user.email=test@example.test',
      '-c',
      'user.name=Test',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ],
    project
  );
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
    if (targetProject !== project) {
      fs.mkdirSync(targetProject);
      await run('git', ['init'], targetProject);
    }
    const other = path.join(root, storageMode === 'custom' ? 'other' : 'global-other');
    fs.mkdirSync(other);
    await run('git', ['init'], other);
    await run(
      'git',
      [
        '-c',
        'user.email=test@example.test',
        '-c',
        'user.name=Test',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      other
    );
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
    if (rejectIncident && raw.includes('[Verification Failed]')) {
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
    const pauseForIncident =
      raw.includes('pause for critical regression') && !raw.includes('[Verification Failed]');
    const content = raw.includes('All-Dead Attribution Brief')
      ? 'HANDLED_ALL_DEAD'
      : raw.includes('[Verification Failed]')
        ? 'HANDLED_VERIFICATION'
        : 'READY';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [
      {
        delta: pauseForIncident
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'pause',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: JSON.stringify({ command: 'sleep 3', timeout: 10 }),
                  },
                },
              ],
            }
          : { role: 'assistant', content },
        finish_reason: null,
      },
      { delta: {}, finish_reason: pauseForIncident ? 'tool_calls' : 'stop' },
    ]) {
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
    }
    res.end('data: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  fs.mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 1024 }],
        },
      },
    })
  );
  const host = spawn(
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
    { cwd: project, env: { ...env, PI_AGENT_NAME: 'Receiver' }, stdio: 'pipe' }
  );
  let output = '';
  host.stdout.on('data', (c) => (output += c));
  host.stderr.on('data', (c) => (output += c));
  const exited = once(host, 'exit');
  const peer = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...env, PI_AGENT_NAME: 'Receiver', PI_SWARM_PEER_PID: String(host.pid) },
      timeout: 15_000,
    });
  try {
    host.stdin.write(JSON.stringify({ type: 'prompt', message: 'ready' }) + '\n');
    await vi.waitFor(() => expect(output.includes('READY'), output.slice(-2500)).toBe(true), {
      timeout: 15_000,
    });
    await peer('run', 'join');
    const beforeRestart = JSON.parse((await command('run', 'status')).stdout);
    await coldRestart();
    expect(JSON.parse((await command('run', 'status')).stdout)).toMatchObject({
      id: beforeRestart.id,
      consumedSteps: beforeRestart.consumedSteps,
    });
    const calls = requests.length;
    await command('send', 'Receiver', 'ordinary contract');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(requests).toHaveLength(calls);
    await peer('task', 'create', '--title', 'Verify critical delivery');
    await peer('task', 'claim', 'task-1');
    const priorOutput = output.length;
    host.stdin.write(
      JSON.stringify({ type: 'prompt', message: 'pause for critical regression' }) + '\n'
    );
    await vi.waitFor(() => expect(output.slice(priorOutput)).toContain('tool_execution_start'), {
      timeout: 10_000,
    });
    await expect(
      peer('task', 'done', 'task-1', 'test', '--verify', 'node -e "process.exit(7)"')
    ).rejects.toMatchObject({ code: 1 });
    await vi.waitFor(
      () => {
        expect(sawRejectedIncident).toBe(true);
        expect(output.slice(priorOutput)).toContain('agent_end');
      },
      { timeout: 10_000 }
    );
    expect(JSON.parse((await peer('notifications')).stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'Receiver', taskId: 'task-1', status: 'enqueued' }),
      ])
    );
    rejectIncident = false;
    host.stdin.write(
      JSON.stringify({ type: 'prompt', message: 'retry the pending critical incident' }) + '\n'
    );
    await vi.waitFor(
      () => expect(output.includes('HANDLED_VERIFICATION'), output.slice(-2500)).toBe(true),
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
    const handledOnce = requests.length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(requests.length).toBe(handledOnce);
    expect(
      JSON.parse((await peer('notifications')).stdout).filter(
        (n: { id: string }) => n.id === 'verif-task-1-1'
      )
    ).toHaveLength(1);
    const delegator = spawn(
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
      { cwd: project, env, stdio: 'pipe' }
    );
    let handled = '';
    delegator.stdout.on('data', (c) => (handled += c));
    delegator.stderr.on('data', (c) => (handled += c));
    const delegatorExit = once(delegator, 'exit');
    try {
      delegator.stdin.write(JSON.stringify({ type: 'prompt', message: 'ready' }) + '\n');
      await vi.waitFor(() => expect(handled.includes('READY'), handled.slice(-1000)).toBe(true), {
        timeout: 15_000,
      });
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(
          peer('task', 'done', 'task-1', 'test', '--verify', 'node -e "process.exit(7)"')
        ).rejects.toMatchObject({ code: 1 });
      await vi.waitFor(
        () => expect(handled.includes('HANDLED_ALL_DEAD'), handled.slice(-1500)).toBe(true),
        { timeout: 15_000 }
      );
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
      delegator.kill('SIGTERM');
      await delegatorExit;
    }
  } finally {
    host.kill('SIGTERM');
    await exited;
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 60_000);

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
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = shell
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${requests}`,
              type: 'function',
              function: {
                name: 'bash',
                arguments: JSON.stringify({ command: shell, timeout: 20 }),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'Recovery finished' };
    for (const choice of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: shell ? 'tool_calls' : 'stop' },
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'recovery',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, ...choice }],
          }) +
          '\n\n'
      );
    res.end('data: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 2048 }],
        },
      },
    })
  );
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
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call_${Date.now()}`,
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: 'true', timeout: 5 }) },
        },
      ],
    };
    for (const choice of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: 'tool_calls' },
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'budget',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, ...choice }],
          }) +
          '\n\n'
      );
    res.end('data: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 2048 }],
        },
      },
    })
  );
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
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const secondPort = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const second = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], {
      cwd: project,
      env: {
        ...env,
        PI_MESSENGER_PORT: String(secondPort),
        PI_MESSENGER_LOG: path.join(root, 'second.log'),
      },
      timeout: 20_000,
    });
  // Hold model requests so accepted peers remain alive during both admissions.
  const provider = createHttpServer(async (req, _res) => {
    for await (const _chunk of req) {
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 1024 }],
        },
      },
    })
  );
  await second('--start');
  try {
    await command('run', 'start', '--goal', 'Cross-process admission', '--concurrency', '1');
    await Promise.all([command('run', 'join'), second('run', 'join')]);
    const admissions = await Promise.allSettled([
      command('spawn', '--model', 'fixture/fixture', 'Hold first worker'),
      second('spawn', '--model', 'fixture/fixture', 'Hold second worker'),
    ]);
    expect(admissions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (admissions.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.stderr
    ).toContain('concurrency');

    await command('abort');
    const recoveryRun = JSON.parse(
      (await command('run', 'start', '--goal', 'Bound duplicate recovery', '--concurrency', '3'))
        .stdout
    );
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
    const eventsFile = path.join(project, '.pi/messenger/agents', `${recoveryRun.id}.jsonl`);
    const events = () =>
      fs
        .readFileSync(eventsFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const originalPids = events()
      .filter((event) => event.agent.pid)
      .map((event) => event.agent.pid);
    expect(originalPids).toHaveLength(2);
    fs.writeFileSync(
      path.join(project, '.pi/pi-messenger.json'),
      JSON.stringify({ maxConcurrentSpawns: 1 })
    );
    for (const pid of originalPids) process.kill(pid, 'SIGKILL');
    await vi.waitFor(
      () => expect(events().filter((event) => event.type === 'spawned')).toHaveLength(3),
      { timeout: 12_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(events().filter((event) => event.type === 'spawned')).toHaveLength(3);
    const handoffs = JSON.parse((await command('run', 'status')).stdout).handoffs;
    expect(Object.values(handoffs).filter((h: any) => h.successor)).toHaveLength(1);
    expect(Object.values(handoffs).every((h: any) => h.failures === 0)).toBe(true);
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
  const requests: string[] = [];
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(raw);
    const conflict = raw.includes('Incident: conflict-task-1-1');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const deltas = conflict
      ? [
          { role: 'assistant', content: 'HANDLED_CONFLICT' },
          {
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({ command: 'sleep 25', timeout: 40 }),
                },
              },
            ],
          },
        ]
      : [
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: 'pi-messenger-swarm run join && echo READY && sleep 12',
                    timeout: 30,
                  }),
                },
              },
            ],
          },
        ];
    for (const choice of [
      ...deltas.map((delta) => ({ delta, finish_reason: null })),
      { delta: {}, finish_reason: 'tool_calls' as const },
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'conflict',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, ...choice }],
          }) +
          '\n\n'
      );
    res.end('data: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 2048 }],
        },
      },
    })
  );
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
    await vi.waitFor(
      async () => expect((await command('ps', 'logs', id!)).stdout).toContain('HANDLED_CONFLICT'),
      { timeout: 30_000 }
    );
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
    const seen = requests.filter((raw) => raw.includes('Incident: conflict-task-1-1')).length;
    expect(seen).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(requests.filter((raw) => raw.includes('Incident: conflict-task-1-1')).length).toBe(1);
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
  for (const dir of [alpha, side]) {
    await run('git', ['init'], dir);
    await run(
      'git',
      [
        '-c',
        'user.email=test@example.test',
        '-c',
        'user.name=Test',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ],
      dir
    );
  }
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
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [
      { delta: { role: 'assistant', content: 'READY' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'isolate',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, ...choice }],
          }) +
          '\n\n'
      );
    res.end('data: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  fs.writeFileSync(
    path.join(env.PI_CODING_AGENT_DIR!, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 1024 }],
        },
      },
    })
  );
  const other = spawn(
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
    { cwd: side, env: { ...sideEnv, PI_AGENT_NAME: 'Twin' }, stdio: 'pipe' }
  );
  let output = '';
  other.stdout.on('data', (c) => (output += c));
  other.stderr.on('data', (c) => (output += c));
  const exited = once(other, 'exit');
  try {
    await sideCmd('run', 'start', '--goal', 'Other project');
    await sideCmd('run', 'join');
    other.stdin.write(JSON.stringify({ type: 'prompt', message: 'ready' }) + '\n');
    await vi.waitFor(() => expect(output.includes('READY'), output.slice(-1500)).toBe(true), {
      timeout: 15_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(output).not.toContain('Incident: verif-task-1-1');
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
    other.kill('SIGTERM');
    await exited;
    await homeCmd('abort');
    const later = JSON.parse(
      (await homeCmd('run', 'start', '--goal', 'Later run same peer')).stdout
    );
    await homeCmd('run', 'join');
    const again = spawn(
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
      {
        cwd: alpha,
        env: alphaEnv,
        stdio: 'pipe',
      }
    );
    let laterOut = '';
    again.stdout.on('data', (c) => (laterOut += c));
    again.stderr.on('data', (c) => (laterOut += c));
    const againExit = once(again, 'exit');
    try {
      again.stdin.write(JSON.stringify({ type: 'prompt', message: 'ready later' }) + '\n');
      await vi.waitFor(() => expect(laterOut.includes('READY'), laterOut.slice(-1500)).toBe(true), {
        timeout: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(laterOut).not.toContain('Incident: verif-task-1-1');
      expect(JSON.parse((await homeCmd('notifications')).stdout)).toEqual([]);
      expect(JSON.parse((await homeCmd('notifications', '--run', first.id)).stdout)[0].status).toBe(
        'pending'
      );
      expect(later.id).not.toBe(first.id);
    } finally {
      again.kill('SIGTERM');
      await againExit;
    }
  } finally {
    other.kill('SIGTERM');
    await exited.catch(() => {});
    await homeCmd('abort').catch(() => {});
    await sideCmd('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 60_000);

function writeToolTurn(res: import('node:http').ServerResponse, id: string, shell: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = {
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id,
        type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: shell, timeout: 60 }) },
      },
    ],
  };
  for (const choice of [
    { delta, finish_reason: null },
    { delta: {}, finish_reason: 'tool_calls' as const },
  ])
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'candidate',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, ...choice }],
        }) +
        '\n\n'
    );
  res.end('data: [DONE]\n\n');
}

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
  fs.mkdirSync(beta);
  await run('git', ['init'], beta);
  await run(
    'git',
    [
      '-c',
      'user.email=test@example.test',
      '-c',
      'user.name=Test',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ],
    beta
  );
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
    await command('abort');
    await betaCmd('abort');
  } finally {
    await command('abort').catch(() => {});
    await betaCmd('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 70_000);

it('keeps the sandbox when preservation fails and does not save a candidate on abort', async () => {
  await command('abort').catch(() => {});
  fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(project, 'node_modules', 'keep.txt'), 'host dependency\n');
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
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
      (await command('run', 'start', '--goal', 'Fail preservation', '--max-steps', '10')).stdout
    );
    await command('run', 'join');
    await command('task', 'create', '--title', 'Broken sandbox');
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
    const pid = Number(
      (await command('ps')).stdout
        .split('\n')
        .find((line) => line.includes(`worker-${brokenId}`))!
        .split('|')[4]
        .trim()
    );
    process.kill(pid, 'SIGKILL');
    await vi.waitFor(
      async () =>
        expect((await command('spawn', 'history')).stdout).toContain(
          'Candidate preservation failed; Sandbox retained'
        ),
      { timeout: 10_000 }
    );
    expect(fs.existsSync(sandbox)).toBe(true);
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
    const suspended = raw.includes('Automatic Handoff suspended');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [
      {
        delta: { role: 'assistant', content: suspended ? 'HANDLED_SUSPENSION' : 'READY' },
        finish_reason: null,
      },
      { delta: {}, finish_reason: 'stop' as const },
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'suspend',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, ...choice }],
          }) +
          '\n\n'
      );
    res.end('data: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  useFixture((provider.address() as { port: number }).port);
  const delegator = spawn(
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
    { cwd: project, env, stdio: 'pipe' }
  );
  let output = '';
  delegator.stdout.on('data', (c) => (output += c));
  delegator.stderr.on('data', (c) => (output += c));
  const exited = once(delegator, 'exit');
  const other = path.join(root, 'handoff-other');
  fs.mkdirSync(other, { recursive: true });
  await run('git', ['init'], other);
  await run(
    'git',
    [
      '-c',
      'user.email=test@example.test',
      '-c',
      'user.name=Test',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ],
    other
  );
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
    delegator.stdin.write(JSON.stringify({ type: 'prompt', message: 'ready' }) + '\n');
    await vi.waitFor(() => expect(output.includes('READY'), output.slice(-1500)).toBe(true), {
      timeout: 15_000,
    });
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
    await vi.waitFor(
      () => expect(output.includes('HANDLED_SUSPENSION'), output.slice(-2000)).toBe(true),
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
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await asDelegator('spawn', 'history')).stdout).toBe(history);
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
    const spawnLog = path.join(project, '.pi', 'messenger', 'agents', `${active.id}.jsonl`);
    const spawnedIds = (text: string) =>
      text
        .split('\n')
        .filter((line) => line.includes('"type":"spawned"'))
        .map((line) => JSON.parse(line).id);
    const beforeAbort = spawnedIds(fs.readFileSync(spawnLog, 'utf8'));
    await asDelegator('abort');
    expect(JSON.parse((await asDelegator('run', 'show', active.id)).stdout).status).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(spawnedIds(fs.readFileSync(spawnLog, 'utf8'))).toEqual(beforeAbort);
    await otherCmd('abort');
  } finally {
    delegator.kill('SIGTERM');
    await exited.catch(() => {});
    await command('abort').catch(() => {});
    await otherCmd('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 70_000);

it('does not replace a task that a live peer still holds', async () => {
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
    expect((await command('spawn', 'list')).stdout).not.toContain('Successor');
    const names = (await command('spawn', 'history')).stdout;
    expect(names).toContain('Holder');
    expect((names.match(/^- /gm) || []).length).toBe((before.match(/^- /gm) || []).length + 1);
  } finally {
    await command('abort').catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 40_000);
