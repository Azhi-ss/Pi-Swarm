# Direct Verified Atomic Merge, P2P Coordination Toolbox, and Observer Controls

## Problem Statement

When autonomous peer agents collaborate on complex software tasks in isolated Git worktree sandboxes, three major friction points prevent a fully automated, reliable development loop:

1. **Manual or Chaotic Merge Bottleneck**: After a worker passes machine tests in its sandbox, there is no automated, conflict-safe mechanism to integrate the resulting patch into the host repository. Relying on conversational negotiation between agents causes "multi-agent turf wars", while requiring manual developer sign-off defeats the purpose of autonomous swarms.
2. **Peer Blindness & Coordination Friction**: Workers operating in isolated sandboxes cannot easily inspect which peers are exploring the same task, cannot introspect their own lease or retry status without parsing the full blackboard, and lack a direct, non-intrusive way to communicate cross-cutting API contracts (e.g., frontend/backend handoffs).
3. **Observer Disconnect & Lack of Safe Emergency Braking**: Human developers observing a swarm run either face total silence, an overwhelming stream of raw git diffs/logs, or intrusive full-screen terminal dashboards that interrupt normal interaction, and lack an instant physical emergency brake.

## Solution

A three-part architectural completion of Pi-Swarm aligning with OpenAI (Noam Brown) machine verifier principles and Anthropic (Claude Code 2026 Agent Teams) peer coordination:

1. **Direct Verified Atomic Merge Protocol (Module 6 / ADR 0001)**: The exit code 0 from the Ground Truth Verifier is the sole authority for code quality. When a worker passes verification, the host pre-checks the patch with `git apply --check`. If clean, it atomically commits directly to `main` with verification metadata. If a collision occurs because `main` evolved, the worker is mechanically bounced back into its sandbox via Steer injection to `git rebase main` and re-verify, completely eliminating natural language debate over merge conflicts.
2. **Peer Awareness & Self-Inspection Toolbox (Module 2)**: Equips peer agents with targeted coordination primitives (`peers --task <id>`, `status --self`, and file-based `send <peer> <msg>`), allowing agents on the same problem to coordinate directly while keeping individual context windows isolated.
3. **Observer Context Admission & Triple Commands (Phase 6 / ADR 0002)**: Replaces complex full-screen TUIs with an intelligent Context Admission protocol for the primary Delegator agent and three canonical commands: `status` (compact ANSI card), `explain` (objective situation brief digested from `<1000 tokens` `BLACKBOARD.md`), and `abort` (instant physical emergency brake via `SIG_ABORT`).

## User Stories

1. As a human developer, I want verified worker patches to automatically commit to my main branch, so that I don't have to manually inspect and apply diffs for tasks that already passed all objective tests.
2. As a human developer, I want every auto-merged commit on main to contain structured verification evidence (task ID, worker ID, command, exit code), so that my git history provides an auditable paper trail.
3. As a human developer, I want the host repository to remain clean and deployable after every swarm merge, so that concurrent workers always rebase against a solid, functional baseline.
4. As a human developer, I want an instant `abort` command and `ESC` shortcut, so that I can immediately kill all sandbox processes and reclaim disk space if the swarm goes off-track.
5. As a human developer, I want to type `status` at any time, so that I can see a compact, high-contrast ANSI snapshot of the four blackboard zones and active workers.
6. As a human developer, I want to ask "what is the swarm doing?" or type `explain`, so that the primary Delegator agent summarizes verified milestones, active hypotheses, and disproved dead ends in plain language.
7. As a peer worker, I want my patch to be tested against the host main branch with `git apply --check` before applying, so that my changes never corrupt the host repository.
8. As a peer worker whose patch conflicts with a freshly merged main branch, I want to receive a clear Steer instruction telling me to rebase and re-verify, so that I can resolve the conflict in my sandbox without human intervention.
9. As a peer worker, I want to run `status --self` while modifying code, so that I know my remaining lease TTL, sandbox paths, allocated port slots, and remaining retry count before I risk being pruned.
10. As a peer worker, I want to query `peers --task <id>`, so that I can identify other workers exploring alternative hypotheses or dependent parts of the same problem.
11. As a peer worker, I want to send targeted messages to a specific peer using `send <peer> <message>`, so that I can share API contract updates or schema changes without broadcasting to the entire swarm.
12. As a peer worker facing an unresolvable environmental blocker (e.g. missing external API key), I want to send a message to `delegator`, so that the primary agent is woken up via Steer to ask the human for assistance.
13. As the primary Delegator agent, I want a defined Context Admission mental model, so that I can interpret the `<1000 tokens` `BLACKBOARD.md` projection objectively without hallucinating progress.
14. As the Watchdog supervisor, I want `abort` signals to trigger POSIX negative PID process group kills, so that rogue child processes (e.g., spawned test runners or dev servers) are killed alongside the worker.
15. As the Watchdog supervisor, I want workers that fail rebase/merge verification 3 consecutive times to be moved to the Graveyard, so that compute is not wasted on unresolvable merge deadlocks.

## Implementation Decisions

- **Direct Verified Atomic Merge (ADR 0001)**:
  - Add merge coordination logic into the verification lifecycle (`swarm/verifier/merge.ts` integrated into `taskDone` handler in `swarm/handlers/task-lifecycle.ts`).
  - Pre-check: execute `git apply --check <patchPath>` in host workspace.
  - Apply & Commit: on clean check, execute `git apply <patchPath>` followed by `git commit -m "feat(swarm): verify & merge <taskId> by <workerId> [Exit 0]"` with author metadata.
  - Rebase-on-Conflict: if `--check` fails, generate Steer bounce message; keep task in `in_progress`; increment failure count toward the 3-attempt Fast Pruning threshold.
- **Peer Toolbox & Protocol Prompts (Module 2)**:
  - Extend CLI router (`router.ts`, `harness/cli.ts`) with:
    - `pi-messenger-swarm status --self`: extracts worker metadata from TaskStore, ProcessManager, and PortSlotManager.
    - `pi-messenger-swarm peers [--task <taskId>]`: returns list of active workers and their current staked tasks.
    - Ensure `pi-messenger-swarm send <to> <message>` works with direct worker IDs and `delegator`.
  - Update `buildSwarmProtocol()` in `swarm/spawn.ts` to document these three tools directly in the system prompt for spawned workers.
- **Observer Context Admission & Commands (Phase 6 / ADR 0002)**:
  - `status`: renders a colored ANSI terminal card of the 4 blackboard zones (Goal, Soft Staking, Verified, Graveyard) and active worker list.
  - `explain`: command / skill that reads `BLACKBOARD.md`, passes it to a dedicated briefing template, and outputs an objective status explanation.
  - `abort`: invokes `processManager.killAll()`, emits `swarm.abort` event to Signal Bus, and unlinks/removes worktrees.
- **Architectural Seams**:
  - Highest Seam 1 (Merge Lifecycle): `taskDone()` execution path in `swarm/handlers/task-lifecycle.ts`.
  - Highest Seam 2 (CLI / Router): `router.ts` action dispatching for `status`, `peers`, `send`, `explain`, `abort`.

## Testing Decisions

- **Testing Philosophy**:
  - Test only external behavior and observable state transitions (file system diffs, git commit log, blackboard state, command return payloads). No testing of private variables or mock-heavy internal plumbing.
  - Use real Git repositories and real detached worktrees in temporary directories (`TMPDIR`) to test `git apply`, `git commit`, and merge conflict rebasing.
- **Test Suites to Implement**:
  - `tests/swarm/direct-verified-merge.test.ts`:
    - Clean merge: worker generates patch in sandbox -> `task done` -> host applies patch -> commit created on main with exit 0 evidence -> task marked `verified` on blackboard.
    - Conflict rejection: concurrent worker B modifies same lines -> worker A merges -> worker B submits -> `git apply --check` detects conflict -> rejected with Steer message -> task remains `in_progress`.
    - Pruning on repeated conflict: worker fails 3 times -> automatically archived to Graveyard with `task.dead_end` signal.
  - `tests/swarm/peer-toolbox.test.ts`:
    - `status --self` returns accurate lease countdown, sandbox path, port slots, and retry count.
    - `peers --task <id>` accurately filters active workers.
    - `send` delivers targeted message to `.pi/messenger/inbox/<recipient>.jsonl`.
  - `tests/swarm/observer-commands.test.ts`:
    - `status` renders non-empty ANSI card.
    - `abort` terminates running worker processes and cleans worktrees.
- **Prior Art**:
  - `tests/swarm/worktree-sandbox.test.ts` (real git worktree creation & cleanup).
  - `tests/swarm/adversarial-verifier-pruning.test.ts` (verification gate & steer feedback).
  - `tests/swarm/process-watchdog.test.ts` (process supervisor & negative PID kill).

## Out of Scope

- Docker containerization or VM-level sandboxing (staying true to local-first Git worktree architecture).
- Multi-agent conversational chatrooms or unconstrained debate.
- Remote multi-machine swarm distribution (local multi-process only).
- GUI/Web dashboard (staying true to terminal and primary agent conversation).

## Further Notes

- Maintains 100% backward compatibility with existing 463 tests.
- Strictly adheres to Ponytail/Karpathy minimalism: shortest working diff, native Git capabilities, zero new external dependencies.
