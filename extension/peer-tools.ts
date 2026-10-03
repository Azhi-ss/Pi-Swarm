import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { MessengerActionParams } from '../action-types.js';
import type { MessengerConfig } from '../config.js';
import type { AgentMailMessage, Dirs, MessengerState, NameThemeConfig } from '../lib.js';
import { executeAction } from '../router.js';

/** A process is a spawned Peer Node when spawn set its inbox path. */
export function isSpawnedPeerNode(): boolean {
  return Boolean(process.env.PI_SWARM_INBOX?.trim());
}

interface PeerToolDeps {
  state: MessengerState;
  dirs: Dirs;
  config: MessengerConfig;
  nameTheme: NameThemeConfig;
  deliverMessage: (message: AgentMailMessage) => void;
  updateStatus: (ctx: ExtensionContext) => void;
}

type JsonSchema = {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  additionalProperties: false;
};

function schema(properties: JsonSchema['properties'], required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const text = (description: string) => ({ type: 'string', description });

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function inboxMessages(raw: string): unknown[] {
  const body = raw.trim();
  if (!body || body === 'No messages.') return [];
  return body
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

function structuredDetails(outcome: unknown): Record<string, unknown> {
  if (!outcome || typeof outcome !== 'object') return { error: 'empty_result' };
  const record = outcome as {
    content?: Array<{ text?: string }>;
    details?: unknown;
  };
  const details =
    record.details && typeof record.details === 'object'
      ? { ...(record.details as Record<string, unknown>) }
      : {};
  if (details.mode === 'inbox') {
    const body = (record.content ?? []).map((part) => part.text ?? '').join('\n');
    details.messages = inboxMessages(body);
  }
  return details;
}

function thrownFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(JSON.stringify({ error: message }));
}

/**
 * Register the twelve harness tools with deferred exposure.
 * No-ops unless this process is a spawned Peer Node.
 */
export function registerPeerHarnessTools(pi: ExtensionAPI, deps: PeerToolDeps): void {
  if (!isSpawnedPeerNode()) return;

  async function callHarness(action: string, params: MessengerActionParams, ctx: ExtensionContext) {
    let outcome: unknown;
    try {
      outcome = await executeAction(
        action,
        params,
        deps.state,
        deps.dirs,
        ctx,
        deps.deliverMessage,
        deps.updateStatus,
        undefined,
        {
          stuckThreshold: deps.config.stuckThreshold,
          swarmEventsInFeed: deps.config.swarmEventsInFeed,
          nameTheme: deps.nameTheme,
          feedRetention: deps.config.feedRetention,
        }
      );
    } catch (error) {
      thrownFailure(error);
    }

    let details: Record<string, unknown>;
    try {
      details = structuredDetails(outcome);
    } catch (error) {
      thrownFailure(error);
    }
    if (typeof details.error === 'string' && details.error) {
      throw new Error(JSON.stringify(details));
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(details) }],
      details,
      structuredContent: details,
    };
  }

  const tools: Array<{
    name: string;
    label: string;
    description: string;
    parameters: JsonSchema;
    call: (input: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
  }> = [
    {
      name: 'swarm_join',
      label: 'Join',
      description: 'Rejoin the mesh.',
      parameters: schema({
        channel: text('Channel to join'),
        create: { type: 'boolean', description: 'Create the channel when it is missing' },
      }),
      call: (input, ctx) =>
        callHarness(
          'join',
          {
            channel: optionalString(input.channel),
            create: input.create === true ? true : undefined,
          },
          ctx
        ),
    },
    {
      name: 'swarm_task_list',
      label: 'List tasks',
      description: 'List tasks on the Blackboard.',
      parameters: schema({}),
      call: (_input, ctx) => callHarness('task.list', {}, ctx),
    },
    {
      name: 'swarm_feed',
      label: 'Feed',
      description: 'Read recent mesh activity.',
      parameters: schema({
        limit: { type: 'number', description: 'Maximum events' },
        channel: text('Channel'),
      }),
      call: (input, ctx) =>
        callHarness(
          'feed',
          { limit: optionalNumber(input.limit), channel: optionalString(input.channel) },
          ctx
        ),
    },
    {
      name: 'swarm_task_claim',
      label: 'Claim',
      description: 'Claim a task and receive a Lease.',
      parameters: schema({ id: text('Task id') }, ['id']),
      call: (input, ctx) => callHarness('task.claim', { id: optionalString(input.id) }, ctx),
    },
    {
      name: 'swarm_propose',
      label: 'Propose',
      description: 'Record a hypothesis for a task.',
      parameters: schema({ id: text('Task id'), content: text('Hypothesis') }, ['id', 'content']),
      call: (input, ctx) =>
        callHarness(
          'task.propose',
          { id: optionalString(input.id), content: optionalString(input.content) },
          ctx
        ),
    },
    {
      name: 'swarm_challenge',
      label: 'Challenge',
      description: 'Record a counterexample against a task.',
      parameters: schema({ id: text('Task id'), reason: text('Counterexample') }, ['id', 'reason']),
      call: (input, ctx) =>
        callHarness(
          'task.challenge',
          { id: optionalString(input.id), reason: optionalString(input.reason) },
          ctx
        ),
    },
    {
      name: 'swarm_task_progress',
      label: 'Progress',
      description: 'Record a milestone and extend the Lease.',
      parameters: schema({ id: text('Task id'), message: text('Milestone') }, ['id', 'message']),
      call: (input, ctx) =>
        callHarness(
          'task.progress',
          { id: optionalString(input.id), message: optionalString(input.message) },
          ctx
        ),
    },
    {
      name: 'swarm_task_done',
      label: 'Done',
      description: 'Submit completion to the Ground Truth Verifier.',
      parameters: schema(
        {
          id: text('Task id'),
          summary: text('Completion summary'),
          verify: text('Verify command'),
        },
        ['id', 'summary']
      ),
      call: (input, ctx) =>
        callHarness(
          'task.done',
          {
            id: optionalString(input.id),
            summary: optionalString(input.summary),
            verify: optionalString(input.verify),
          },
          ctx
        ),
    },
    {
      name: 'swarm_status',
      label: 'Status',
      description: "Inspect this Peer Node's Lease, Sandbox, and port slots.",
      parameters: schema({}),
      call: (_input, ctx) => callHarness('status', { self: true }, ctx),
    },
    {
      name: 'swarm_peers',
      label: 'Peers',
      description: 'List active Peer Nodes.',
      parameters: schema({ taskId: text('Task id') }),
      call: (input, ctx) => callHarness('peers', { taskId: optionalString(input.taskId) }, ctx),
    },
    {
      name: 'swarm_send',
      label: 'Send',
      description: 'Deliver an ordinary message to a named peer.',
      parameters: schema({ to: text('Recipient'), message: text('Message') }, ['to', 'message']),
      call: (input, ctx) =>
        callHarness(
          'send',
          { to: optionalString(input.to), message: optionalString(input.message) },
          ctx
        ),
    },
    {
      name: 'swarm_inbox',
      label: 'Inbox',
      description: 'Read ordinary messages for this Peer Node.',
      parameters: schema({}),
      call: (_input, ctx) => callHarness('inbox', {}, ctx),
    },
  ];

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      exposure: 'deferred',
      parameters: tool.parameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return tool.call((params ?? {}) as Record<string, unknown>, ctx);
      },
    } as never);
  }
}
