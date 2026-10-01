import { readFileSync } from 'node:fs';

export function isProcessAlive(pid: number): boolean {
  try {
    // kill(pid, 0) is true for a zombie until its parent reaps it.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    if (state === 'Z' || state === 'X') return false;
  } catch {
    // No /proc (or the pid is already gone): fall through to the signal check.
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
