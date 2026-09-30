import { installCriticalDelivery } from './extension/critical-notifications.js';
import {
  messengerDirs,
  resolveProjectContext,
  configuredStorage,
  selectStorage,
  activeRunId,
  swarmSessionId,
} from './project.js';
/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination with a harness server for action dispatch.
 *
 * Architecture:
 * - This extension manages lifecycle hooks (registration, status, overlay, reservations)
 * - A long-lived harness server (pi-messenger-swarm) handles all action dispatch
 * - Models interact via the CLI, not a tool call — no eager invocation risk
 * - The SKILL.md teaches models how to use the CLI
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { OverlayHandle, TUI } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  formatRelativeTime,
  stripAnsiCodes,
  extractFolder,
} from './lib.js';
import { displayChannelLabel } from './channel.js';
import * as store from './store.js';
import { getContextSessionId, getEffectiveSessionId } from './store/shared.js';
import { syncChannelStateFromDisk } from './store/agents.js';
import { MessengerOverlay, type OverlayCallbacks } from './overlay/component.js';
import { MessengerConfigOverlay } from './overlay/config-overlay.js';
import { loadConfig, matchesAutoRegisterPath, type MessengerConfig } from './config.js';
import { logFeedEvent, pruneFeed } from './feed/index.js';
import { onLiveWorkersChanged } from './swarm/live-progress.js';
import { stopAllSpawned } from './swarm/spawn.js';
import { createDeliverMessage } from './extension/deliver-message.js';
import { createStatusController } from './extension/status.js';
import { createActivityTracker } from './extension/activity.js';
import { installShellAlias, createHarnessServer, resolveCli } from './extension/harness.js';
import { handleReservationEnforcement } from './extension/reservation.js';
import { createMentionAutocompleteProvider } from './extension/mention-autocomplete.js';
import { handleHashInput } from './extension/handle-input.js';
import { splitCliArgs } from './harness/commands.js';
import { handleSessionShutdown } from './extension/shutdown.js';
import { processManager } from './swarm/process-manager.js';
import { WatchdogService } from './swarm/watchdog/index.js';
import { getCircuitBreaker } from './swarm/circuit-breaker/index.js';

let overlayTui: TUI | null = null;
let overlayHandle: OverlayHandle | null = null;
let overlayOpening = false;

export default function piMessengerExtension(pi: ExtensionAPI) {
  const config: MessengerConfig = loadConfig(process.cwd());

  const state: MessengerState = {
    agentName: process.env.PI_AGENT_NAME || `Peer${process.pid}`,
    registered: false,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: '',
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: config.scopeToFolder,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    contextSessionId: undefined,
    currentChannel: '',
    sessionChannel: '',
    joinedChannels: [],
  };

  installCriticalDelivery(pi, () => process.env.PI_AGENT_NAME || state.agentName);

  const nameTheme = { theme: config.nameTheme, customWords: config.nameWords };

  function getMessengerDirs(): Dirs {
    const project = resolveProjectContext({
      cwd: process.cwd(),
      peer: process.env.PI_SWARM_PROJECT_ROOT,
    });
    if (configuredStorage()) selectStorage(project, configuredStorage()!);
    return messengerDirs(project);
  }

  const dirs = getMessengerDirs();

  const deliverMessage = createDeliverMessage({
    pi,
    state,
    dirs,
    config,
    requestRender: () => overlayTui?.requestRender(),
  });

  const { updateStatus, clearAllUnreadCounts, resetChannelScopedUiState } = createStatusController({
    state,
    dirs,
    config,
  });

  function syncContextSession(ctx: ExtensionContext): void {
    const selected = getMessengerDirs();
    if (selected.base !== dirs.base) {
      Object.assign(dirs, selected);
      state.registered = false;
      state.currentChannel = '';
      state.sessionChannel = '';
      state.joinedChannels = [];
    }
    if (!state.registered) return;

    const rebound = store.rebindContextSession(state, dirs, ctx);
    if (!rebound.changed) return;

    const cwd = ctx.cwd ?? process.cwd();
    if (rebound.previousSessionChannel && rebound.previousSessionChannel !== state.sessionChannel) {
      logFeedEvent(
        cwd,
        state.agentName,
        'leave',
        undefined,
        undefined,
        rebound.previousSessionChannel
      );
    }

    resetChannelScopedUiState();
    logFeedEvent(cwd, state.agentName, 'join', undefined, undefined, state.currentChannel);
    overlayTui?.requestRender();
    updateStatus(ctx);
  }

  const STATUS_HEARTBEAT_MS = 15_000;
  let latestCtx: ExtensionContext | null = null;
  let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  function startStatusHeartbeat(): void {
    if (statusHeartbeatTimer) return;
    statusHeartbeatTimer = setInterval(() => {
      if (latestCtx) updateStatus(latestCtx);
    }, STATUS_HEARTBEAT_MS);
  }

  function stopStatusHeartbeat(): void {
    if (!statusHeartbeatTimer) return;
    clearInterval(statusHeartbeatTimer);
    statusHeartbeatTimer = null;
  }

  onLiveWorkersChanged(() => {
    if (latestCtx) updateStatus(latestCtx);
    overlayTui?.requestRender();
  });

  function sendRegistrationContext(ctx: ExtensionContext): void {
    const folder = extractFolder(process.cwd());
    const locationPart = state.gitBranch ? `${folder} on ${state.gitBranch}` : folder;

    pi.sendMessage(
      {
        customType: 'messenger_context',
        content: `You are agent "${state.agentName}" in ${locationPart}. Your current channel is ${displayChannelLabel(state.currentChannel)}. Named channel ${displayChannelLabel('memory')} exists for durable cross-session notes. Use pi-messenger-swarm for all coordination. Key: when you spawn agents for tasks, delegate the work — do NOT claim those tasks yourself (spawned agents claim and execute them). Only claim tasks you will implement personally. Read agent output with task show (feed shows only previews). Examples: pi-messenger-swarm join | pi-messenger-swarm swarm | pi-messenger-swarm task create --title "..." | pi-messenger-swarm spawn --task-id task-1 --role Debugger "Fix X" | pi-messenger-swarm task show task-1 | pi-messenger-swarm send AgentName "hello" | pi-messenger-swarm feed --limit 20. See SKILL for full reference.`,
        display: false,
      },
      { triggerTurn: false }
    );
  }

  const harnessServer = createHarnessServer(dirs.base);

  pi.registerCommand('messenger', {
    description: "Open messenger overlay, or 'config' to manage settings",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (ctx.mode !== 'tui') {
        ctx.ui.notify(
          '/messenger overlay requires TUI mode (terminal). The chat and config overlays are terminal-only.',
          'info'
        );
        return;
      }
      latestCtx = ctx;
      syncContextSession(ctx);

      // /messenger config - open config overlay
      if (args[0] === 'config') {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => {
            return new MessengerConfigOverlay(tui, theme, done);
          },
          { overlay: true }
        );
        return;
      }

      // /messenger - open chat overlay (auto-joins if not registered)
      if (!state.registered) {
        if (!store.register(state, dirs, ctx, nameTheme)) {
          ctx.ui.notify('Failed to join agent mesh', 'error');
          return;
        }
        updateStatus(ctx);
        if (config.registrationContext) {
          sendRegistrationContext(ctx);
        }
      }

      // Sync channel state from disk so the overlay opens on the
      // most recent active channel (e.g. a named channel the agent
      // joined via the CLI), not a stale session channel.
      syncChannelStateFromDisk(state, dirs);

      if (overlayHandle && overlayHandle.isHidden()) {
        overlayHandle.setHidden(false);
        clearAllUnreadCounts();
        updateStatus(ctx);
        return;
      }

      const callbacks: OverlayCallbacks = {
        onBackground: (snapshotText) => {
          overlayHandle?.setHidden(true);
          pi.sendMessage(
            {
              customType: 'swarm_snapshot',
              content: snapshotText,
              display: true,
            },
            { triggerTurn: true }
          );
        },
        onSwitchChannel: (channelId) => {
          const switched = store.joinChannel(state, dirs, channelId, { create: true });
          if (!switched.success) return false;
          resetChannelScopedUiState();
          updateStatus(ctx);
          return true;
        },
      };

      const snapshot = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(tui, theme, state, dirs, done, callbacks);
        },
        {
          overlay: true,
          onHandle: (handle) => {
            overlayHandle = handle;
          },
        }
      );

      if (snapshot) {
        pi.sendMessage(
          {
            customType: 'swarm_snapshot',
            content: snapshot,
            display: true,
          },
          { triggerTurn: true }
        );
      }

      // Overlay closed
      clearAllUnreadCounts();
      overlayHandle = null;
      overlayTui = null;
      updateStatus(ctx);
    },
  });

  let watchdogService: WatchdogService | null = null;

  const hasPiProcesses =
    typeof (pi.events as any)?.listenerCount === 'function' &&
    (pi.events as any).listenerCount('processes:command:adopt') > 0;

  if (!hasPiProcesses) {
    pi.registerCommand('ps', {
      description: 'List active swarm worker processes',
      handler: async (_args, ctx) => {
        const workers = processManager.list();
        if (workers.length === 0) {
          ctx.ui?.notify('No running swarm workers.', 'info');
          return;
        }
        const lines = workers.map((w) => `${w.id}: ${w.name} (pid: ${w.pid}, status: ${w.status})`);
        ctx.ui?.notify(lines.join('\n'), 'info');
      },
    });

    pi.registerCommand('ps:logs', {
      description: 'View logs for a swarm worker process: /ps:logs <id>',
      handler: async (args, ctx) => {
        const id = args[0];
        if (!id) {
          ctx.ui?.notify('Usage: /ps:logs <workerId>', 'error');
          return;
        }
        const logs = processManager.getLogs(id);
        const text = `=== Worker ${id} Logs ===\nSTDOUT:\n${logs.stdout || '(none)'}\nSTDERR:\n${logs.stderr || '(none)'}`;
        ctx.ui?.notify(text, 'info');
      },
    });

    pi.registerCommand('ps:kill', {
      description: 'Force kill a swarm worker process: /ps:kill <id>',
      handler: async (args, ctx) => {
        const id = args[0];
        if (!id) {
          ctx.ui?.notify('Usage: /ps:kill <workerId>', 'error');
          return;
        }
        const stopped = processManager.kill(id);
        if (stopped) {
          ctx.ui?.notify(`Worker ${id} killed.`, 'info');
        } else {
          ctx.ui?.notify(`Worker ${id} not found.`, 'error');
        }
      },
    });
  }

  pi.registerMessageRenderer<AgentMailMessage>('agent_message', (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const safeFrom = stripAnsiCodes(details.from);
        const safeText = stripAnsiCodes(details.text);

        const header = theme.fg('accent', `From ${safeFrom}`);
        const time = theme.fg('dim', ` (${formatRelativeTime(details.timestamp)})`);

        const result: string[] = [];
        result.push(truncateToWidth(header + time, width));
        result.push('');

        for (const line of safeText.split('\n')) {
          result.push(truncateToWidth(line, width));
        }

        return result;
      },
      invalidate() {},
    };
  });

  const activityTracker = createActivityTracker({ state, dirs, config });

  pi.on('tool_call', async (event, ctx) => {
    await activityTracker.handleToolCall(event, ctx);
  });

  pi.on('tool_result', async (event, ctx) => {
    await activityTracker.handleToolResult(event, ctx);
  });

  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx;
    startStatusHeartbeat();
    state.isHuman = ctx.hasUI;

    if (ctx.hasUI) {
      ctx.ui.addAutocompleteProvider(createMentionAutocompleteProvider(state, dirs));
    }
    try {
      fs.rmSync(join(getAgentDir(), 'messenger/feed.jsonl'), { force: true });
    } catch {}

    syncContextSession(ctx);

    // Write the session ID to disk so the harness server (and CLI)
    // can discover it. The harness runs as a separate process and
    // has no access to pi's SessionManager — this file bridges that gap.
    let project = ctx.cwd;
    try {
      project = resolveProjectContext({
        cwd: ctx.cwd,
        peer: process.env.PI_SWARM_PROJECT_ROOT,
      });
    } catch {
      // Session startup still records the Interaction Session when no Project is selected.
    }
    const sessionId = swarmSessionId(project, getContextSessionId(ctx));
    if (sessionId) {
      try {
        const sessionFilePath = join(messengerDirs(project).base, 'session-id');
        fs.writeFileSync(sessionFilePath, sessionId, 'utf-8');
      } catch {
        // Best effort
      }

      watchdogService = new WatchdogService(
        project,
        sessionId,
        { pollIntervalMs: 5000, leaseTtlSeconds: 300 },
        (payload) => {
          void pi.sendMessage(
            {
              customType: payload.customType,
              content: payload.content,
              display: payload.display ?? true,
              details: payload.details,
            },
            { triggerTurn: true, deliverAs: 'steer' }
          );
        }
      );
      watchdogService.start();
    }

    // Install the CLI wrapper so all child bash processes
    // can find and use pi-messenger-swarm.
    installShellAlias();

    const shouldAutoRegister =
      config.autoRegister || matchesAutoRegisterPath(process.cwd(), config.autoRegisterPaths);

    // Start the harness server even without auto-register —
    // the model needs it for CLI actions regardless.
    harnessServer.start();
    Object.assign(dirs, getMessengerDirs());

    if (!shouldAutoRegister) {
      return;
    }

    const wasRegistered = state.registered;
    if (store.register(state, dirs, ctx, nameTheme)) {
      updateStatus(ctx);
      if (!wasRegistered) {
        const cwd = ctx.cwd ?? process.cwd();
        pruneFeed(cwd, config.feedRetention, state.currentChannel);
        logFeedEvent(cwd, state.agentName, 'join', undefined, undefined, state.currentChannel);
      }

      if (config.registrationContext) {
        sendRegistrationContext(ctx);
      }
    }
  });

  pi.on('session_start', async (event, ctx) => {
    // Handle new, resume, and fork reasons (existing sessions), not startup/reload
    if (event.reason === 'startup' || event.reason === 'reload') return;
    latestCtx = ctx;
    syncContextSession(ctx);
    updateStatus(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => {
    latestCtx = ctx;
    updateStatus(ctx);
  });

  pi.on('turn_end', async (event, ctx) => {
    latestCtx = ctx;
    syncContextSession(ctx);
    updateStatus(ctx);

    if (state.registered) {
      const msg = event.message as unknown as Record<string, unknown> | undefined;
      if (msg && msg.role === 'assistant' && msg.usage) {
        const usage = msg.usage as { totalTokens?: number; input?: number; output?: number };
        const total = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
        if (total > 0) {
          state.session.tokens += total;
          activityTracker.scheduleRegistryFlush(ctx);
        }
      }
    }
  });

  pi.on('agent_settled', async (_event, ctx) => {
    latestCtx = ctx;
    updateStatus(ctx);
  });

  pi.on('session_shutdown', async () => {
    const cwd = process.cwd();
    stopAllSpawned(cwd); // In-process safety net for extension-spawned agents
    watchdogService?.stop();
    stopStatusHeartbeat();
    // Do NOT send /quit to the harness server on session shutdown.
    // The harness is a long-lived daemon (detached + unref'd) designed to
    // survive across pi sessions. Killing it destroys all spawned subagents
    // that may still be working. The harness handles agent cleanup via its
    // own session tracking — it will unregister this session's agent when
    // handleSessionShutdown runs below. If the harness truly needs to stop,
    // the user can run `pi-messenger-swarm --stop` explicitly.
    harnessServer.stop(); // Only stops the process WE spawned (if any)
    overlayOpening = false;
    overlayHandle = null;
    overlayTui = null;
    await handleSessionShutdown(state, dirs);
    activityTracker.dispose();
  });

  pi.on('input', async (event, ctx) => {
    // Skip extension-injected messages to avoid loops
    if (event.source === 'extension') return { action: 'continue' };
    const text = event.text.trim();
    const cwd = ctx.cwd ?? process.cwd();
    const notify = (msg: string, kind?: 'info' | 'warning' | 'error') =>
      ctx.ui?.notify(msg, kind ?? 'info');

    // ##cmd [args] — run pi-messenger-swarm directly, never touching the LLM.
    // ## inherits the # autocomplete trigger so completions pop up automatically.
    // Output is shown immediately in the session view (display: true, triggerTurn: false)
    // and is filtered from LLM context by the `context` event handler below.
    if (text.startsWith('##')) {
      const rest = text.slice(2).trim();
      if (rest) {
        try {
          const { command, prefixArgs, cliPath, cwd: cliCwd } = resolveCli();
          // Use schema-aware splitting so multi-word trailing args (e.g. task
          // summaries, progress messages) are passed as a single token, which
          // the CLI then receives intact without requiring shell quoting.
          const cliArgs = splitCliArgs(rest);
          const result = await pi.exec(command, [...prefixArgs, cliPath, ...cliArgs], {
            cwd,
          });
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
          if (output) {
            await pi.sendMessage(
              { customType: 'swarm_cmd_result', content: output, display: true },
              { triggerTurn: false }
            );
          }
        } catch (err) {
          ctx.ui?.notify(`##${rest}: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
      }
      return { action: 'handled' };
    }

    return handleHashInput(text, state, dirs, cwd, notify);
  });

  // Filter swarm_cmd_result messages from LLM context so that ##cmd output
  // is shown to the user but never sent to the model.
  pi.on('context', async (event) => {
    const filtered = event.messages.filter(
      (m) => !('customType' in m && m.customType === 'swarm_cmd_result')
    );
    if (filtered.length === event.messages.length) return undefined;
    return { messages: filtered };
  });

  pi.on('tool_call', async (event, ctx) => {
    const cwd = resolveProjectContext({
      cwd: ctx.cwd,
      peer: process.env.PI_SWARM_PROJECT_ROOT,
    });
    if (process.env.PI_SWARM_RUN_ID && process.env.PI_SWARM_RUN_ID !== activeRunId(cwd))
      return { block: true, reason: 'This Swarm Run is no longer active.' };
    const sessionId = getEffectiveSessionId(cwd, state);
    const breaker = getCircuitBreaker(cwd, sessionId);
    breaker.recordStep(state.agentName || 'main', event.toolName, {
      cwd,
      sessionId,
    });
    if (breaker.isTripped()) {
      return {
        block: true,
        reason:
          '🛑 CIRCUIT BREAKER TRIPPED: Global step budget exceeded (50 steps max). All tool executions halted.',
      };
    }
    return handleReservationEnforcement(event, ctx, state, dirs);
  });
}
