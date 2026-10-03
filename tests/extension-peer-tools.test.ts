import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import piMessengerExtension from '../index.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = {
        pid: 4242,
        unref: () => {},
        kill: () => true,
        on: () => proc,
        once: () => proc,
      };
      return proc;
    }),
  };
});

const PEER_HARNESS_TOOLS = [
  'swarm_join',
  'swarm_task_list',
  'swarm_feed',
  'swarm_task_claim',
  'swarm_propose',
  'swarm_challenge',
  'swarm_task_progress',
  'swarm_task_done',
  'swarm_status',
  'swarm_peers',
  'swarm_send',
  'swarm_inbox',
] as const;

interface StartedSession {
  cwd: string;
  ctx: ExtensionContext;
  tools: Array<{ name: string; exposure?: string; execute: Function; parameters: any }>;
  messages: Array<{ customType?: string; content?: string }>;
  shutdown: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

async function startSession(options: {
  inbox?: string;
  autoRegister?: boolean;
  agentName?: string;
}): Promise<StartedSession> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-swarm-peer-tools-'));
  const agentDir = path.join(cwd, 'agent-dir');
  fs.mkdirSync(path.join(cwd, '.pi', 'messenger'), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  if (options.autoRegister) {
    fs.writeFileSync(
      path.join(cwd, '.pi', 'pi-messenger.json'),
      JSON.stringify({ autoRegister: true })
    );
  }

  const previous = {
    cwd: process.cwd(),
    inbox: process.env.PI_SWARM_INBOX,
    project: process.env.PI_SWARM_PROJECT_ROOT,
    agentName: process.env.PI_AGENT_NAME,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    messengerDir: process.env.PI_MESSENGER_DIR,
    messengerGlobal: process.env.PI_MESSENGER_GLOBAL,
    runId: process.env.PI_SWARM_RUN_ID,
    channel: process.env.PI_MESSENGER_CHANNEL,
  };
  process.chdir(cwd);
  if (options.inbox === undefined) delete process.env.PI_SWARM_INBOX;
  else process.env.PI_SWARM_INBOX = options.inbox;
  delete process.env.PI_SWARM_PROJECT_ROOT;
  delete process.env.PI_MESSENGER_DIR;
  delete process.env.PI_MESSENGER_GLOBAL;
  delete process.env.PI_SWARM_RUN_ID;
  delete process.env.PI_MESSENGER_CHANNEL;
  process.env.PI_AGENT_NAME = options.agentName ?? 'PeerNode';
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const tools: StartedSession['tools'] = [];
  const messages: StartedSession['messages'] = [];
  const pi = {
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerTool: (tool: StartedSession['tools'][number]) => {
      tools.push(tool);
    },
    sendMessage: async (message: StartedSession['messages'][number]) => {
      messages.push(message);
    },
    exec: async () => ({ stdout: '', stderr: '' }),
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  };

  piMessengerExtension(pi as unknown as ExtensionAPI);

  const ctx = {
    hasUI: false,
    cwd,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => {},
      setStatus: () => {},
      custom: async () => undefined,
    },
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => 'peer-session-1',
    },
    model: { id: 'test-model' },
  } as unknown as ExtensionContext;

  for (const handler of handlers.get('session_start') ?? []) {
    await handler({ reason: 'startup' }, ctx);
  }

  const shutdown = async () => {
    for (const handler of handlers.get('session_shutdown') ?? []) {
      await handler({}, ctx);
    }
    process.chdir(previous.cwd);
    restoreEnv('PI_SWARM_INBOX', previous.inbox);
    restoreEnv('PI_SWARM_PROJECT_ROOT', previous.project);
    restoreEnv('PI_AGENT_NAME', previous.agentName);
    restoreEnv('PI_CODING_AGENT_DIR', previous.agentDir);
    restoreEnv('PI_MESSENGER_DIR', previous.messengerDir);
    restoreEnv('PI_MESSENGER_GLOBAL', previous.messengerGlobal);
    restoreEnv('PI_SWARM_RUN_ID', previous.runId);
    restoreEnv('PI_MESSENGER_CHANNEL', previous.channel);
    fs.rmSync(cwd, { recursive: true, force: true });
  };
  cleanups.push(shutdown);

  return { cwd, ctx, tools, messages, shutdown };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function registrationMessage(messages: Array<{ customType?: string; content?: string }>): string {
  const message = messages.find((entry) => entry.customType === 'messenger_context');
  if (!message?.content) throw new Error('registration message was not sent');
  return message.content;
}

function harnessTool(session: StartedSession, name: string) {
  const tool = session.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function callTool(
  session: StartedSession,
  name: string,
  params: Record<string, unknown> = {}
) {
  return harnessTool(session, name).execute('call-1', params, undefined, undefined, session.ctx);
}

async function errorPayload(
  session: StartedSession,
  name: string,
  params: Record<string, unknown>
) {
  try {
    await callTool(session, name, params);
  } catch (error) {
    return JSON.parse(error instanceof Error ? error.message : String(error)) as Record<
      string,
      unknown
    >;
  }
  throw new Error(`${name} resolved instead of returning an error result`);
}

describe('extension session harness tools', () => {
  it('registers the twelve deferred harness tools for a spawned Peer Node', async () => {
    const session = await startSession({
      inbox: '/tmp/pi-swarm-peer-inbox.jsonl',
    });

    expect(session.tools.map((tool) => tool.name)).toEqual([...PEER_HARNESS_TOOLS]);
    for (const tool of session.tools) {
      expect(tool.exposure).toBe('deferred');
    }
  });

  it('is in the mesh when the spawned Peer session starts', async () => {
    const session = await startSession({
      inbox: path.join(os.tmpdir(), 'peer-node-inbox.jsonl'),
      agentName: 'PeerNode',
    });

    const registration = JSON.parse(
      fs.readFileSync(
        path.join(session.cwd, '.pi', 'messenger', 'registry', 'PeerNode.json'),
        'utf8'
      )
    );
    expect(registration.name).toBe('PeerNode');
  });

  it('registers none of the harness tools for a Delegator session', async () => {
    const session = await startSession({ agentName: 'Delegator' });
    expect(session.tools).toEqual([]);

    const blankInbox = await startSession({ inbox: '   ', agentName: 'Delegator' });
    expect(blankInbox.tools).toEqual([]);
  });

  it('keeps the command-line tutorial and the twelve tools out of the registration message', async () => {
    const peer = await startSession({
      inbox: path.join(os.tmpdir(), 'peer-node-inbox.jsonl'),
      agentName: 'PeerNode',
    });
    const peerMessage = registrationMessage(peer.messages);
    expect(peerMessage).toContain('PeerNode');
    expect(peerMessage).not.toMatch(/pi-messenger-swarm/);

    const delegator = await startSession({ autoRegister: true, agentName: 'Delegator' });
    const delegatorMessage = registrationMessage(delegator.messages);
    expect(delegatorMessage).toContain('Delegator');
    expect(delegatorMessage).not.toMatch(/pi-messenger-swarm/);
    for (const name of PEER_HARNESS_TOOLS) {
      expect(peerMessage).not.toContain(name);
      expect(delegatorMessage).not.toContain(name);
    }
  });
});

describe('harness tool results', () => {
  it('rejoins through swarm_join and returns structured list data', async () => {
    const session = await startSession({
      inbox: path.join(os.tmpdir(), 'peer-node-inbox.jsonl'),
      agentName: 'PeerNode',
    });

    const joined = await callTool(session, 'swarm_join');
    expect(joined.isError).toBeFalsy();
    expect(joined.structuredContent).toMatchObject({
      mode: 'join',
      alreadyJoined: true,
      name: 'PeerNode',
    });
    expect(joined.content[0].text).not.toContain('pi-messenger-swarm');

    const listed = await callTool(session, 'swarm_task_list');
    expect(listed.structuredContent).toMatchObject({ mode: 'task.list', tasks: [] });
    expect(listed.content[0].text).not.toContain('No tasks yet');
    expect(JSON.parse(listed.content[0].text)).toMatchObject({ tasks: [] });
  });

  it('returns an error result for a refused claim instead of terminal prose', async () => {
    const session = await startSession({
      inbox: path.join(os.tmpdir(), 'peer-node-inbox.jsonl'),
      agentName: 'PeerNode',
    });

    const payload = await errorPayload(session, 'swarm_task_claim', { id: 'task-missing' });
    expect(payload).toMatchObject({ error: 'not_found', id: 'task-missing' });
    expect(JSON.stringify(payload)).not.toContain('not found');
  });

  it('forwards each harness argument and keeps successful data structured', async () => {
    const session = await startSession({
      inbox: path.join(os.tmpdir(), 'peer-node-inbox.jsonl'),
      agentName: 'PeerNode',
    });

    expect(harnessTool(session, 'swarm_task_claim').parameters).toMatchObject({
      required: ['id'],
    });
    expect(harnessTool(session, 'swarm_task_progress').parameters).toMatchObject({
      required: ['id', 'message'],
    });
    expect(harnessTool(session, 'swarm_task_done').parameters.required).toEqual(['id', 'summary']);
    expect(harnessTool(session, 'swarm_task_done').parameters.properties.verify.type).toBe(
      'string'
    );
    expect(harnessTool(session, 'swarm_propose').parameters.required).toEqual(['id', 'content']);
    expect(harnessTool(session, 'swarm_challenge').parameters.required).toEqual(['id', 'reason']);
    expect(harnessTool(session, 'swarm_feed').parameters.properties).toMatchObject({
      limit: { type: 'number' },
      channel: { type: 'string' },
    });
    expect(harnessTool(session, 'swarm_peers').parameters.properties.taskId.type).toBe('string');
    expect(harnessTool(session, 'swarm_send').parameters.required).toEqual(['to', 'message']);
    expect(harnessTool(session, 'swarm_status').parameters.required ?? []).toEqual([]);
    expect(harnessTool(session, 'swarm_inbox').parameters.required ?? []).toEqual([]);

    const feed = await callTool(session, 'swarm_feed', { limit: 1, channel: 'Notes' });
    expect(feed.structuredContent).toMatchObject({ mode: 'feed', channel: 'notes', events: [] });

    expect(await errorPayload(session, 'swarm_propose', { id: 'task-missing' })).toMatchObject({
      error: 'missing_content',
    });
    expect(
      await errorPayload(session, 'swarm_propose', {
        id: 'task-missing',
        content: 'try the cache',
      })
    ).toMatchObject({ error: 'not_found', id: 'task-missing' });

    expect(await errorPayload(session, 'swarm_challenge', { id: 'task-missing' })).toMatchObject({
      error: 'missing_reason',
    });
    expect(
      await errorPayload(session, 'swarm_challenge', {
        id: 'task-missing',
        reason: 'the cache still races',
      })
    ).toMatchObject({ error: 'not_found', id: 'task-missing' });

    expect(
      await errorPayload(session, 'swarm_task_progress', { id: 'task-missing' })
    ).toMatchObject({ error: 'missing_message' });

    const sent = await callTool(session, 'swarm_send', {
      to: 'PeerNode',
      message: 'contract ready',
    });
    expect(sent.structuredContent).toMatchObject({
      mode: 'send',
      delivered: ['PeerNode'],
    });
    expect(sent.content[0].text).not.toContain('Message delivered');

    const inbox = await callTool(session, 'swarm_inbox');
    expect(inbox.structuredContent.messages).toEqual([
      expect.objectContaining({ from: 'PeerNode', to: 'PeerNode', text: 'contract ready' }),
    ]);

    const status = await callTool(session, 'swarm_status');
    expect(status.structuredContent).toMatchObject({
      mode: 'status.self',
      agentName: 'PeerNode',
    });
    expect(status.content[0].text).not.toContain('Goal Zone');
  });

  it('reports a failed verification as an error result and records progress', async () => {
    const session = await startSession({
      inbox: path.join(os.tmpdir(), 'peer-node-inbox.jsonl'),
      agentName: 'PeerNode',
    });
    const { createTask, claimTask } = await import('../swarm/task-store.js');
    const { writeRegistration } = await import('./helpers/messenger-fixtures.js');
    const task = createTask(session.cwd, 'peer-session-1', { title: 'Ship the gate' }, 'dev');
    const other = createTask(session.cwd, 'peer-session-1', { title: 'Other hypothesis' }, 'dev');
    expect(claimTask(session.cwd, 'peer-session-1', other.id, 'OtherPeer')?.id).toBe(other.id);
    writeRegistration(
      {
        base: path.join(session.cwd, '.pi', 'messenger'),
        registry: path.join(session.cwd, '.pi', 'messenger', 'registry'),
      },
      { name: 'OtherPeer', pid: process.pid, cwd: session.cwd, isHuman: false }
    );

    const claimed = await callTool(session, 'swarm_task_claim', { id: task.id });
    expect(claimed.structuredContent).toMatchObject({ mode: 'task.claim' });
    expect(claimed.structuredContent.task.id).toBe(task.id);
    expect(claimed.content[0].text).not.toContain('Claimed');

    const progress = await callTool(session, 'swarm_task_progress', {
      id: task.id,
      message: 'gate compiled',
    });
    expect(progress.structuredContent).toMatchObject({ mode: 'task.progress', id: task.id });

    const peers = await callTool(session, 'swarm_peers', { taskId: other.id });
    expect(peers.structuredContent.peers).toEqual([
      expect.objectContaining({
        name: 'OtherPeer',
        tasks: [expect.objectContaining({ id: other.id })],
      }),
    ]);
    const others = await callTool(session, 'swarm_peers', { taskId: task.id });
    expect(others.structuredContent.peers).toEqual([]);

    const failed = await errorPayload(session, 'swarm_task_done', {
      id: task.id,
      summary: 'shipped',
      verify: 'exit 17',
    });
    expect(failed).toMatchObject({ error: 'verification_failed', exitCode: 17, id: task.id });
  });
});
