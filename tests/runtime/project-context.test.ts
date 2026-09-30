/**
 * Project Context at the generated command wrapper, CLI, and service boundary.
 * The known-good workspace Pi runtime is reused; clean package installation is #8.
 * Storage cases also cover sandbox task association and ordinary inbox delivery.
 */
import { execFile } from 'node:child_process';
import { reservePort } from '../helpers/ports.js';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorktree, removeWorktree } from '../../swarm/worktree/manager.js';

const exec = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-project-context-'));
const packageCheckout = path.join(root, 'package-checkout');
const target = path.join(root, 'target');
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
}

function invoke(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return exec(wrapper, args, {
    cwd,
    env: { ...env, ...extra },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
}

beforeAll(async () => {
  port = await reservePort();
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
  await initRepo(target);
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
}, 120_000);

afterAll(async () => {
  if (wrapper) await invoke(target, ['--stop']).catch(() => {});
  try {
    fs.unlinkSync(path.join(packageCheckout, 'node_modules'));
  } catch {
    // The symlink is removed with the temporary root when it is already gone.
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('addresses the caller project from the installed wrapper when the service started in the package checkout', async () => {
  const packageRoot = fs.realpathSync(packageCheckout);
  const targetRoot = fs.realpathSync(target);
  const leaked = { PI_MESSENGER_CWD: packageRoot };

  expect(
    (await invoke(packageCheckout, ['run', 'start', '--goal', 'Package checkout goal'])).stdout
  ).toContain('Package checkout goal');
  await invoke(packageCheckout, ['join']);
  expect(
    (await invoke(packageCheckout, ['task', 'create', '--title', 'Package local task'])).stdout
  ).toContain('Package local task');

  expect((await invoke(target, ['status'], leaked)).stdout).toContain(`Project: ${targetRoot}`);
  expect(
    (await invoke(target, ['run', 'start', '--goal', 'Caller project goal'], leaked)).stdout
  ).toContain('Caller project goal');
  await invoke(target, ['join'], leaked);
  expect(
    (await invoke(target, ['task', 'create', '--title', 'Caller project task'], leaked)).stdout
  ).toContain('Caller project task');
  expect((await invoke(target, ['task', 'list'], leaked)).stdout).toContain('Caller project task');
  expect((await invoke(packageCheckout, ['task', 'list'])).stdout).not.toContain(
    'Caller project task'
  );
  expect((await invoke(packageCheckout, ['status'])).stdout).toContain(`Project: ${packageRoot}`);
  expect((await invoke(packageCheckout, ['task', 'list'])).stdout).toContain('Package local task');
});

it('resolves a nested directory and an assigned detached sandbox to the owning project', async () => {
  const targetRoot = fs.realpathSync(target);
  const leaked = { PI_MESSENGER_CWD: fs.realpathSync(packageCheckout) };
  const nested = path.join(target, 'src', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const sandbox = createWorktree(target, 'caller', 'CallerPeer');
  expect(sandbox.isGitWorktree).toBe(true);
  expect(sandbox.worktreePath).toContain(
    `${path.sep}.swarm${path.sep}workspaces${path.sep}worker-caller`
  );
  expect(fs.realpathSync(sandbox.worktreePath)).not.toBe(targetRoot);
  const sandboxNested = path.join(sandbox.worktreePath, 'src');
  fs.mkdirSync(sandboxNested, { recursive: true });
  try {
    expect((await invoke(nested, ['status'], leaked)).stdout).toContain(`Project: ${targetRoot}`);
    expect(
      (await invoke(nested, ['task', 'create', '--title', 'Nested owned task'], leaked)).stdout
    ).toContain('Nested owned task');
    expect((await invoke(sandboxNested, ['status'], leaked)).stdout).toContain(
      `Project: ${targetRoot}`
    );
    expect(
      (
        await invoke(
          sandbox.worktreePath,
          ['task', 'create', '--title', 'Sandbox owned task'],
          leaked
        )
      ).stdout
    ).toContain('Sandbox owned task');
    const owned = await invoke(target, ['task', 'list']);
    expect(owned.stdout).toContain('Nested owned task');
    expect(owned.stdout).toContain('Sandbox owned task');
    expect((await invoke(packageCheckout, ['task', 'list'])).stdout).not.toContain(
      'Sandbox owned task'
    );
  } finally {
    removeWorktree(target, sandbox);
  }
});

it('accepts an explicit or peer-supplied project from outside that project', async () => {
  const targetRoot = fs.realpathSync(target);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const leaked = { PI_MESSENGER_CWD: fs.realpathSync(packageCheckout) };
  const explicit = await invoke(outside, ['--project', targetRoot, 'run', 'status'], leaked);
  expect(explicit.stdout).toContain('Caller project goal');
  expect(explicit.stdout).toContain(`"project":"${targetRoot}"`);
  const peer = await invoke(outside, ['task', 'list'], {
    ...leaked,
    PI_SWARM_PROJECT_ROOT: targetRoot,
  });
  expect(peer.stdout).toContain('Caller project task');
  expect(peer.stdout).toContain('Sandbox owned task');
});

it('reports a missing project and does not stop or change another project', async () => {
  const outside = path.join(root, 'unscoped');
  fs.mkdirSync(outside);
  const leaked = { PI_MESSENGER_CWD: fs.realpathSync(packageCheckout) };
  const before = await invoke(target, ['run', 'status']);
  await expect(invoke(outside, ['status'], leaked)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      'Missing Project Context: run inside a Project or use --project <path>.'
    ),
  });
  await expect(
    invoke(outside, ['task', 'create', '--title', 'Should not land'], leaked)
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Project Context'),
  });
  await expect(
    invoke(outside, ['--project', path.join(outside, 'missing'), 'status'])
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Project Context'),
  });
  await expect(
    invoke(outside, ['abort', '--reason', 'wrong project'], leaked)
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Project Context'),
  });
  expect(fs.existsSync(path.join(outside, '.pi'))).toBe(false);
  const after = await invoke(target, ['run', 'status']);
  expect(after.stdout).toContain('Caller project goal');
  expect(after.stdout).toContain('"status":"active"');
  expect(after.stdout).toBe(before.stdout);
  expect((await invoke(packageCheckout, ['run', 'status'])).stdout).toContain(
    'Package checkout goal'
  );
  expect((await invoke(target, ['task', 'list'])).stdout).not.toContain('Should not land');
});

it.each(['default', 'custom', 'global'] as const)(
  'a sandbox peer claims the originating task and reads its inbox under %s storage',
  async (storageMode) => {
    const project = path.join(root, `${storageMode}-project`);
    const other = path.join(root, `${storageMode}-other`);
    const shared = path.join(root, `${storageMode}-shared`);
    await initRepo(project);
    await initRepo(other);
    const packageRoot = fs.realpathSync(packageCheckout);
    const storage = {
      PI_MESSENGER_DIR: storageMode === 'custom' ? shared : '',
      PI_MESSENGER_GLOBAL: storageMode === 'global' ? '1' : '0',
      PI_SWARM_PROJECT_ROOT: '',
      PI_SWARM_INBOX: '',
      PI_MESSENGER_CWD: packageRoot,
      PI_MESSENGER_CHANNEL: '',
    };
    const as = (name: string) => ({ ...storage, PI_AGENT_NAME: name });
    const sandbox = createWorktree(project, `peer-${storageMode}`, 'Worker');
    expect(sandbox.isGitWorktree).toBe(true);
    expect(sandbox.worktreePath).toContain(
      `${path.sep}.swarm${path.sep}workspaces${path.sep}worker-peer-${storageMode}`
    );
    try {
      await invoke(
        project,
        ['run', 'start', '--goal', `${storageMode} originating goal`],
        as('Delegator')
      );
      await invoke(project, ['join'], as('Delegator'));
      expect(
        (
          await invoke(
            project,
            ['task', 'create', '--title', `${storageMode} originating task`],
            as('Delegator')
          )
        ).stdout
      ).toContain(`${storageMode} originating task`);

      expect((await invoke(sandbox.worktreePath, ['join'], as('Worker'))).stdout).toContain(
        'Joined as Worker'
      );
      expect((await invoke(sandbox.worktreePath, ['task', 'list'], as('Worker'))).stdout).toContain(
        `${storageMode} originating task`
      );
      expect(
        (await invoke(sandbox.worktreePath, ['task', 'claim', 'task-1'], as('Worker'))).stdout
      ).toContain('Claimed task-1');
      expect((await invoke(project, ['task', 'list'], as('Delegator'))).stdout).toContain(
        '[Worker]'
      );

      expect(
        (
          await invoke(
            project,
            ['send', 'Worker', `${storageMode} private contract`],
            as('Delegator')
          )
        ).stdout
      ).toContain('inbox');
      expect((await invoke(sandbox.worktreePath, ['inbox'], as('Worker'))).stdout).toContain(
        `${storageMode} private contract`
      );
      expect(fs.existsSync(path.join(project, '.pi', 'messenger', 'inbox', 'Worker.jsonl'))).toBe(
        false
      );
      if (storageMode === 'custom') {
        expect(fs.existsSync(path.join(shared, 'inbox', 'Worker.jsonl'))).toBe(false);
      }

      await invoke(other, ['run', 'start', '--goal', `${storageMode} other goal`], as('Worker'));
      await invoke(other, ['join'], as('Worker'));
      const foreignTasks = await invoke(other, ['task', 'list'], as('Worker'));
      expect(foreignTasks.stdout).not.toContain(`${storageMode} originating task`);
      expect((await invoke(other, ['inbox'], as('Worker'))).stdout).not.toContain(
        `${storageMode} private contract`
      );
      await invoke(other, ['join'], as('Scout'));
      expect((await invoke(other, ['peers'], as('Scout'))).stdout).not.toContain('Delegator');
      expect((await invoke(project, ['peers'], as('Delegator'))).stdout).toContain('Worker');
      expect((await invoke(project, ['peers'], as('Delegator'))).stdout).not.toContain('Scout');

      await invoke(project, ['abort'], as('Delegator'));
      await invoke(other, ['abort'], as('Worker'));
    } finally {
      removeWorktree(project, sandbox);
    }
  },
  60_000
);
