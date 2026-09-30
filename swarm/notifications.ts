import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentMailMessage } from '../lib.js';
import { isProcessAlive } from '../lib.js';
import { messengerDirs, activeRunId } from '../project.js';
import { withRunLock } from './run-store.js';

export interface CriticalNotification extends AgentMailMessage {
  project: string;
  runId: string;
  taskId?: string;
  status: 'pending' | 'enqueued' | 'handled';
  receiverPid?: number;
  handledAt?: string;
}
/** The correlation lines a receiver needs to act on a Critical Notification. */
export function criticalHeader(
  project: string,
  runId: string,
  recipient: string,
  incident: string,
  taskId?: string
): string {
  return `Project: ${project}\nRun: ${runId}\nRecipient: ${recipient}\n${taskId ? `Task: ${taskId}\n` : ''}Incident: ${incident}\n`;
}
function directory(cwd: string, runId: string) {
  return path.join(messengerDirs(cwd, runId).base, 'critical');
}
function file(cwd: string, runId: string, id: string) {
  return path.join(directory(cwd, runId), createHash('sha256').update(id).digest('hex') + '.json');
}
function save(notification: CriticalNotification) {
  const target = file(notification.project, notification.runId, notification.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(notification));
  fs.renameSync(temporary, target);
}
export function enqueueCritical(
  cwd: string,
  runId: string,
  message: AgentMailMessage,
  taskId?: string
): void {
  withRunLock(cwd, () => {
    if (fs.existsSync(file(cwd, runId, message.id))) return;
    save({ ...message, project: cwd, runId, taskId, status: 'pending' });
  });
}
export function listCritical(cwd: string, runId: string): CriticalNotification[] {
  const dir = directory(cwd, runId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
export function claimCritical(
  cwd: string,
  runId: string,
  recipient: string
): CriticalNotification[] {
  if (activeRunId(cwd) !== runId) return [];
  return withRunLock(cwd, () => {
    const pending = listCritical(cwd, runId).filter(
      (n) =>
        n.to === recipient &&
        n.status !== 'handled' &&
        (!n.receiverPid || !isProcessAlive(n.receiverPid))
    );
    for (const n of pending) {
      n.status = 'enqueued';
      n.receiverPid = process.pid;
      save(n);
    }
    return pending;
  });
}
export function acknowledgeCritical(cwd: string, runId: string, ids: string[]): void {
  withRunLock(cwd, () => {
    for (const n of listCritical(cwd, runId)) {
      if (!ids.includes(n.id) || n.receiverPid !== process.pid) continue;
      n.status = 'handled';
      n.handledAt = new Date().toISOString();
      save(n);
    }
  });
}
