# Observer Dashboard via Context Admission and Triple Commands

Rather than building an intrusive, heavyweight full-screen TUI that interrupts the developer's conversation flow, the human observer interface is implemented as an intelligent Context Admission protocol for the primary coding agent (Delegator) paired with three lightweight commands: `status`, `explain`, and `abort`.

## Context & Decision

When multiple peers work in isolated sandboxes, human developers require visibility and immediate physical control without navigating complex terminal dashboards. Because `BLACKBOARD.md` is already projected as a compact, read-only Markdown snapshot (<1000 tokens), the Delegator can ingest it on demand with zero context-window degradation.

We established three canonical interaction commands:

- **`status`**: Renders a compact ANSI card of the four-zone blackboard snapshot and active worker PIDs.
- **`explain`**: Directs the Delegator to analyze `BLACKBOARD.md` and deliver an objective, human-readable situation briefing (verified milestones, active hypotheses, disproved dead-ends).
- **`abort`**: Fires `SIG_ABORT`, triggering the Watchdog to batch-kill all sandbox process groups and reclaim worktrees immediately.

## Consequences

- Zero UI bloat: Developers interact through natural conversation or concise slash commands.
- High-level insight: Explanations are reasoned over objective Exit 0 facts, avoiding speculative guesses.
- Safety: Instant physical intervention remains one keystroke or command away.
