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
const command = (...args: string[]) => run(process.execPath, [cli, ...args]);
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
    JSON.stringify({ private: true, type: 'module' })
  );
  await run(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', path.join(root, packed.filename)],
    install
  );
  cli = path.join(install, 'node_modules/pi-messenger-swarm/dist/harness/cli.js');
}, 180_000);

afterAll(async () => {
  if (cli) await command('--stop').catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

it('loads the production extension and starts its installed service in a separate project', async () => {
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('./node_modules/pi-messenger-swarm/dist/index.js')",
    ],
    install
  );
  expect((await command('--start')).stdout).toContain('"ok":true');
  expect((await command('join')).stdout).toContain('Delegator');
  expect((await command('status')).stdout).toContain('Goal');
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

it('keeps same-name peers and their tasks separate in shared storage', async () => {
  const other = path.join(root, 'other');
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
      env: { ...env, PI_MESSENGER_DIR: shared, PI_AGENT_NAME: name },
      timeout: 15_000,
    });
  await scoped(project, 'Same', 'run', 'start', '--goal', 'Storage project A');
  await scoped(project, 'Same', 'join');
  await scoped(project, 'Same', 'task', 'create', '--title', 'Only project A');
  await scoped(other, 'Same', 'run', 'start', '--goal', 'Storage project B');
  await scoped(other, 'Same', 'join');
  expect((await scoped(other, 'Same', 'task', 'list')).stdout).not.toContain('Only project A');
  await scoped(project, 'Receiver', 'join');
  await scoped(project, 'Same', 'send', 'Receiver', 'private contract A');
  expect((await scoped(project, 'Receiver', 'inbox')).stdout).toContain('private contract A');
  expect((await scoped(other, 'Same', 'inbox')).stdout).not.toContain('private contract A');
  expect((await scoped(project, 'Same', 'task', 'list')).stdout).toContain('Only project A');
  await scoped(project, 'Same', 'abort');
  await scoped(other, 'Same', 'abort');
});

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
  const provider = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(raw);
    const content = raw.includes('All-Dead Attribution Brief')
      ? 'HANDLED_ALL_DEAD'
      : raw.includes('[Verification Failed]')
        ? 'HANDLED_VERIFICATION'
        : 'READY';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [
      { delta: { role: 'assistant', content }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
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
    await expect(
      peer('task', 'done', 'task-1', 'test', '--verify', 'node -e "process.exit(7)"')
    ).rejects.toMatchObject({ code: 1 });
    await vi.waitFor(
      () => expect(output.includes('HANDLED_VERIFICATION'), output.slice(-2500)).toBe(true),
      { timeout: 15_000 }
    );
    await vi.waitFor(
      async () =>
        expect(JSON.parse((await peer('notifications')).stdout)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ to: 'Receiver', taskId: 'task-1', status: 'handled' }),
          ])
        ),
      { timeout: 10_000 }
    );
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
      expect(state.consumedSteps).toBe(0);
    },
    { timeout: 35_000, interval: 500 }
  );
  const history = (await command('spawn', 'history')).stdout;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect((await command('spawn', 'history')).stdout).toBe(history);
  expect((await command('task', 'show', 'task-1')).stdout).not.toContain('dead_end');
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
