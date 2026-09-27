import type { SwarmTask } from '../types.js';
import { replayTasks } from '../task-store/events.js';

const MAX_OUTPUT_SNIPPET = 800;

function truncateText(text: string, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... [truncated ${text.length - maxLen} chars]`;
}

/**
 * Generate a structured Attribution Brief (《避坑死因归因简报》) (<1500 tokens)
 * summarizing dead-end tasks, hypotheses, challenges, and error traces.
 */
export function generateAttributionBrief(
  cwd: string,
  sessionId: string,
  targetTaskIds?: string | string[]
): string {
  const allTasks = replayTasks(cwd, sessionId);
  let tasks: SwarmTask[] = [];

  if (targetTaskIds) {
    const ids = Array.isArray(targetTaskIds) ? new Set(targetTaskIds) : new Set([targetTaskIds]);
    tasks = allTasks.filter((t) => ids.has(t.id));
  } else {
    tasks = allTasks.filter((t) => t.status === 'dead_end');
  }

  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push('# 🪦 Swarm All-Dead Attribution Brief (避坑死因归因简报)');
  lines.push(`> Generated: ${now} | Session: ${sessionId} | Failed Tasks: ${tasks.length}`);
  lines.push('');
  lines.push('## ⚠️ Executive Summary');
  lines.push(
    'All attempted hypothesis exploration paths have failed consecutive verification gates and reached `dead_end`. All active sandbox workers have terminated. The swarm requires intervention by the Main Coding Agent.'
  );
  lines.push('');

  for (const task of tasks) {
    lines.push(`### 🎯 Task: \`${task.id}\` — ${task.title}`);
    lines.push(`- **Status**: \`${task.status}\``);
    lines.push(`- **Verification Attempts**: ${task.verification_attempts ?? 0} (Threshold: 3)`);

    // Dead ends & attempted proposals
    if (task.dead_ends && task.dead_ends.length > 0) {
      lines.push('#### 🚫 Disproven Hypotheses (Dead Ends)');
      for (const de of task.dead_ends) {
        lines.push(`- **Agent**: \`${de.agent}\` (${de.timestamp})`);
        lines.push(`  - **Reason**: ${de.reason}`);
      }
    } else if (task.dead_end_reason) {
      lines.push(`- **Dead End Reason**: ${task.dead_end_reason}`);
    }

    if (task.proposals && task.proposals.length > 0) {
      lines.push('#### 💡 Attempted Proposals');
      for (const p of task.proposals) {
        lines.push(`- **[${p.id}]** by \`${p.agent}\`: ${p.content}`);
      }
    }

    if (task.challenges && task.challenges.length > 0) {
      lines.push('#### ⚔️ Counterexample Challenges & Objections');
      for (const c of task.challenges) {
        lines.push(`- **[${c.id}]** by \`${c.agent}\`: ${c.content}`);
      }
    }

    // Last verification failure
    if (task.last_verification_failure) {
      const fail = task.last_verification_failure;
      lines.push('#### 💥 Last Verification Failure');
      lines.push(`- **Command**: \`${fail.command}\``);
      lines.push(`- **Exit Code**: \`${fail.exitCode}\``);
      lines.push(`- **Agent**: \`${fail.agent}\``);
      if (fail.output) {
        lines.push('```text');
        lines.push(truncateText(fail.output.trim(), MAX_OUTPUT_SNIPPET));
        lines.push('```');
      }
    }

    lines.push('');
  }

  lines.push('---');
  lines.push('## 🛠️ Actionable Next Steps for Main Coding Agent');
  lines.push('1. **Inspect Dead Ends**: Review disproven hypotheses and counterexamples above.');
  lines.push(
    '2. **Refine Acceptance Criteria**: Update task verification commands or specifications.'
  );
  lines.push(
    '3. **Decompose or Re-prompt**: Break the stuck task into smaller atomic tasks, or reformulate the prompt.'
  );
  lines.push('');

  return lines.join('\n');
}
