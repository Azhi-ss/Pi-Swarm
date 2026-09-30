import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isValidAgentName,
  type AgentMailMessage,
  type Dirs,
  type MessengerState,
} from '../../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { listSpawnedHistory } from '../../swarm/spawn.js';
import { activeRunId } from '../../project.js';
import { getEffectiveSessionId } from '../../store/shared.js';
import {
  formatFeedLine,
  isSwarmEvent,
  logFeedEvent,
  readFeedEvents,
  type FeedEvent,
} from '../../feed/index.js';
import { notRegisteredError, result } from '../result.js';

export function executeSend(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  to: string | string[] | undefined,
  message?: string,
  replyTo?: string,
  channel?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (!message) {
    return result('Error: message is required when sending.', {
      mode: 'send',
      error: 'missing_message',
    });
  }

  if (
    !to ||
    (Array.isArray(to) && to.length === 0) ||
    (typeof to === 'string' && to.trim().length === 0)
  ) {
    return result("Error: send requires 'to'. Use an agent name, agent list, or #channel.", {
      mode: 'send',
      error: 'missing_recipient',
    });
  }

  const isChannelTarget = typeof to === 'string' && to.startsWith('#');
  const targetChannel = isChannelTarget ? normalizeChannelId(to) : channel || state.currentChannel;

  if (isChannelTarget) {
    logFeedEvent(cwd, state.agentName, 'message', to, message, targetChannel);
    return result(`Message posted to ${to}.`, { mode: 'send', channel: targetChannel, to });
  }

  const targets = Array.isArray(to) ? to : [to];
  const spawned = listSpawnedHistory(cwd, getEffectiveSessionId(cwd, state));
  const recipients = [
    ...new Set(
      targets.map((target) => spawned.find((agent) => agent.id === target)?.name ?? target)
    ),
  ];
  if (recipients.some((name) => typeof name !== 'string' || !isValidAgentName(name))) {
    return result(
      'Error: recipient must be an agent name (letters, numbers, underscore, hyphen).',
      {
        mode: 'send',
        error: 'invalid_recipient',
      }
    );
  }

  const inboxDir = join(dirs.base, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  for (const recipient of recipients) {
    const runId = activeRunId(cwd);
    const mail: AgentMailMessage = {
      id: randomUUID(),
      from: state.agentName,
      to: recipient,
      text: message,
      timestamp: new Date().toISOString(),
      replyTo: replyTo ?? null,
      channel: targetChannel,
      project: cwd,
      ...(runId ? { runId } : {}),
    };
    fs.appendFileSync(join(inboxDir, `${recipient}.jsonl`), JSON.stringify(mail) + '\n', 'utf8');
  }

  const inactive = recipients.filter((name) => {
    const agent = spawned.find((agent) => agent.name === name);
    return agent && agent.status !== 'running';
  });
  let text = `Message delivered to ${recipients.join(', ')} inbox.`;
  if (inactive.length)
    text += `\nWarning: ${inactive.join(', ')} is no longer running; messages are queued on disk.`;
  return result(text, {
    mode: 'send',
    channel: targetChannel,
    to,
    delivered: recipients,
    warning: inactive.length ? 'target_agent_completed' : undefined,
  });
}

export function executeFeed(
  cwd: string,
  currentChannel: string,
  limit?: number,
  swarmEventsInFeed: boolean = true,
  requestedChannel?: string
) {
  const channelId = requestedChannel ? normalizeChannelId(requestedChannel) : currentChannel;
  const effectiveLimit = limit ?? 20;
  let events: FeedEvent[];
  if (!swarmEventsInFeed) {
    events = readFeedEvents(cwd, effectiveLimit * 2, channelId);
    events = events.filter((e) => !isSwarmEvent(e.type));
    events = events.slice(-effectiveLimit);
  } else {
    events = readFeedEvents(cwd, effectiveLimit, channelId);
  }

  if (events.length === 0) {
    return result(`# Activity Feed ${displayChannelLabel(channelId)}\n\nNo activity yet.`, {
      mode: 'feed',
      channel: channelId,
      events: [],
    });
  }

  const lines: string[] = [
    `# Activity Feed ${displayChannelLabel(channelId)} (last ${events.length})`,
    '',
  ];
  for (const event of events) {
    lines.push(formatFeedLine(event));
  }

  return result(lines.join('\n'), {
    mode: 'feed',
    channel: channelId,
    events: events.map((e) => ({ ...e, preview: e.preview ?? undefined })),
    count: events.length,
  });
}
