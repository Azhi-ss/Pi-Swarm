import type { SwarmTask, SwarmTaskStatus } from './types.js';

const TERMINAL = new Set<SwarmTaskStatus>([
  'verified',
  'done',
  'dead_end',
  'archived',
  'superseded',
]);

/** Group key. Stored `alternative_of` is already the root; walk in case an older pointer remains. */
export function alternativeRoot(task: SwarmTask, tasks: SwarmTask[]): string {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let current = task;
  while (current.alternative_of && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.alternative_of);
    if (!parent) return current.alternative_of;
    current = parent;
  }
  return current.id;
}

export function groupMembers(tasks: SwarmTask[], root: string): SwarmTask[] {
  return tasks.filter((task) => alternativeRoot(task, tasks) === root);
}

export function inAlternativeGroup(task: SwarmTask, tasks: SwarmTask[]): boolean {
  return groupMembers(tasks, alternativeRoot(task, tasks)).length > 1;
}

/** Root id once any member has completed a Direct Verified Merge. */
export function finishedAlternativeRoot(task: SwarmTask, tasks: SwarmTask[]): string | null {
  const root = alternativeRoot(task, tasks);
  const members = groupMembers(tasks, root);
  if (members.length < 2) return null;
  const won = members.some(
    (member) => member.status === 'verified' && member.verification?.exitCode === 0
  );
  return won ? root : null;
}

export function isTerminalStatus(status: SwarmTaskStatus): boolean {
  return TERMINAL.has(status);
}
