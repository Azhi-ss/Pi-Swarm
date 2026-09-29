import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { activeRunId, resolveProject } from '../project.js';
import { acknowledgeCritical, claimCritical } from '../swarm/notifications.js';

/** The Pi host consumes urgent records; ordinary inboxes remain pull-based. */
export function installCriticalDelivery(pi: ExtensionAPI, recipient: () => string): void {
  let timer: NodeJS.Timeout | undefined;
  let queued: string[] = [];
  let inTurn: string[] = [];
  let project: string;
  let runId: string;
  pi.on('session_start', (_event, ctx) => {
    process.env.PI_SWARM_PEER_PID = String(process.pid);
    project = resolveProject(ctx.cwd, process.env.PI_SWARM_PROJECT_ROOT);
    runId = process.env.PI_SWARM_RUN_ID || activeRunId(project) || '';
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      const current = process.env.PI_SWARM_RUN_ID || activeRunId(project);
      if (!current || !recipient()) return;
      if (current !== runId) {
        runId = current;
        queued = [];
        inTurn = [];
      }
      try {
        for (const notification of claimCritical(project, runId, recipient())) {
          queued.push(notification.id);
          pi.sendMessage(
            {
              customType: 'swarm_critical',
              content: notification.text,
              display: true,
              details: notification,
            },
            { deliverAs: 'steer', triggerTurn: true }
          );
        }
      } catch (error) {
        ctx.ui.notify(`Critical delivery pending: ${String(error)}`, 'error');
      }
    }, 200);
    timer.unref();
  });
  pi.on('context', () => {
    inTurn.push(...queued);
    queued = [];
  });
  pi.on('message_end', (event) => {
    // This response follows the context that included the incident. Earlier
    // assistant messages in agent_end's accumulated history are not receipts.
    const message = event.message;
    if (
      message.role !== 'assistant' ||
      message.stopReason === 'error' ||
      message.stopReason === 'aborted' ||
      !message.content.length
    )
      return;
    if (inTurn.length) acknowledgeCritical(project, runId, inTurn);
    inTurn = [];
  });
  pi.on('session_shutdown', () => {
    if (timer) clearInterval(timer);
  });
}
