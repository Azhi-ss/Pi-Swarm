# Live Swarm E2E Benchmark: 6–8 Agent Autonomous Acceptance Run

## 1. Executive Summary

This specification defines the real-world, end-to-end (E2E) acceptance benchmark for **Pi-Swarm**. Instead of mock tests or simulated agents, Pi-Swarm is deployed against a live, cutting-edge open-source TypeScript codebase from the **SWE-bench-Live (MultiLang)** benchmark: **`openai/openai-agents-js`** (Task `openai__openai-agents-js-375`).

A swarm of **6 to 8 concurrent workers** backed by real LLM APIs (`gpt-6-astra`, `gemini-3.8-flash`, etc.) will collaborate autonomously in detached Git worktree sandboxes, coordinate via the Four-Zone Blackboard, execute objective machine verification with Vitest, and land an atomic commit directly on `main` upon achieving Exit Code 0.

---

## 2. Benchmark Target Task Profile

| Attribute                      | Specification                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Benchmark Suite**            | Microsoft SWE-bench-Live MultiLang (2026/2025)                                                       |
| **Instance ID**                | `openai__openai-agents-js-375`                                                                       |
| **Target Repository**          | [`openai/openai-agents-js`](https://github.com/openai/openai-agents-js)                              |
| **Base Commit**                | `6f1677c854b8daa427cbb11d105eca9f0f84d1f6`                                                           |
| **Language / Stack**           | TypeScript, Node.js 24+, pnpm workspaces, Vitest                                                     |
| **Issue Title**                | Streaming agents do not call the `agent_end` lifecycle hook (#371)                                   |
| **Objective Verifier Command** | `CI=1 NODE_ENV=test pnpm vitest run packages/agents-core/test/run.stream.test.ts`                    |
| **Unfixed Baseline Status**    | **Exit Code 1** (3 passed, 1 failed: `AssertionError: expected [] to have a length of 1 but got +0`) |
| **Fixed Target Status**        | **Exit Code 0** (4 passed, execution time ~1.2s)                                                     |

### Problem Statement

In `@openai/agents-core`, developers rely on the `agent_end` event to collect token usage and execution metrics at the completion of an agent run. For non-streaming runs, `Runner` correctly emits `agent_end`. However, when agents run in streaming mode (`Runner.run(..., { stream: true })`), `agent_end` is never fired on either the `Runner` or the `Agent` instance upon stream completion.

### Expected Fix

In `packages/agents-core/src/run.ts`, when the stream reaches completion in `Runner.run`, emit the `agent_end` event on both `this` (the runner) and `currentAgent` with `(context, output)` arguments, matching non-streaming semantics.

---

## 3. Swarm Topology & Hypothesis Partitioning (6–8 Workers)

To stress-test genuine concurrency, mesh communication, and conflict-safe merges, **6 to 8 concurrent worker agents** are launched simultaneously:

```
                          +------------------------+
                          |   BLACKBOARD.md        |
                          | (Goal / Staking /      |
                          |  Verified / Graveyard) |
                          +-----------+------------+
                                      |
       +------------------------------+-------------------------------+
       |             |                |                |              |
+------v-----+ +-----v------+  +------v-----+   +------v-----+  +-----v------+
| Worker 1-2 | | Worker 3-4 |  | Worker 5-6 |   |  Worker 7  |  |  Worker 8  |
| Lifecycle  | | Event Bus  |  | Edge Cases |   | Changeset  |  | Auditor /  |
| Stream Loop| | & Emitters |  | & Errors   |   | & Docs     |  | Regression|
+------------+ +------------+  +------------+   +------------+  +------------+
```

### Worker Role Breakdown

1. **Worker 1 & 2 (Lifecycle & Stream Loop Analysis)**:
   - Stake Hypothesis A: Trace the stream generator in `Runner.run` and locate where stream completion (`next_step_interruption` vs `response_done`) resolves.
2. **Worker 3 & 4 (Event Signature & Emitter Binding)**:
   - Stake Hypothesis B: Implement the dual emission contract: `this.emit('agent_end', context, currentAgent, output)` and `currentAgent.emit('agent_end', context, output)`.
3. **Worker 5 & 6 (Edge-Case & Interruption Handling)**:
   - Stake Hypothesis C: Ensure `agent_end` does _not_ prematurely fire during intermediate handoffs or unhandled stream failures.
4. **Worker 7 (Changeset & Version Metadata)**:
   - Stake Hypothesis D: Generate the changeset entry `.changeset/fix-streaming-agent-end-lifecycle.md` required by pnpm monorepo conventions.
5. **Worker 8 (Adversarial Regression Guard)**:
   - Stake Hypothesis E: Run the full non-streaming test suite (`packages/agents-core/test/run.test.ts`) to ensure zero regressions across standard execution paths.

---

## 4. Execution Workflow & Sandbox Isolation

### Phase 1: Arena Setup

1. Clone target repository into an isolated dogfood directory (`~/swarm-target-arena`).
2. Checkout base commit `6f1677c854b8daa427cbb11d105eca9f0f84d1f6`.
3. Apply reproducing test patch (`packages/agents-core/test/run.stream.test.ts`).
4. Run verifier command to confirm red baseline (**Exit Code 1**).

### Phase 2: Swarm Launch (6–8 Workers)

1. Launch swarm via local plugin integration:
   ```bash
   pi-messenger-swarm spawn --count 8 --task "fix-streaming-agent-end" --verify "CI=1 NODE_ENV=test pnpm vitest run packages/agents-core/test/run.stream.test.ts"
   ```
2. Each worker receives an isolated Git Detached Worktree in `.swarm/workspaces/worker-<id>` with symlinked `node_modules` and dedicated port slots.
3. Workers parse `BLACKBOARD.md` and claim sub-hypotheses with 300s TTL leases via `task stake`.

### Phase 3: Objective Machine Gate & Direct Atomic Merge

1. Workers edit code and run verification inside their sandboxes.
2. When a worker calls `task done`, the Ground Truth Verifier executes the verification command.
3. **Exit Code 0 Verification**:
   - Host runs `git apply --check <patch>`.
   - If clean: host automatically merges and commits `feat(swarm): verify & merge fix-streaming-agent-end by worker-<id> [Exit 0]`.
   - If collision occurs: competing workers receive Steer bounce instructions to `git rebase main` and re-test.

### Phase 4: Observer Plane Validation

During the live run, the human operator/delegator executes:

1. `pi-messenger-swarm status`: Inspect 4-zone ANSI summary card.
2. `pi-messenger-swarm explain`: Receive concise plain-language progress brief.
3. Verify graceful shutdown or `pi-messenger-swarm abort` process-tree cleanup.

---

## 5. Success & Acceptance Criteria

- [ ] **Concurrency**: Exactly 6–8 live worker processes operate concurrently without port collisions or worktree interference.
- [ ] **Objective Ground Truth**: Completion is determined solely by Exit Code 0 from `vitest run packages/agents-core/test/run.stream.test.ts`.
- [ ] **Host Branch Cleanliness**: The winning worker's patch is applied directly to host `main` with standard `[Exit 0]` commit metadata.
- [ ] **Zero Worktree Pollution**: All worktrees and temporary branches are clean upon completion (`git branch` shows 0 temporary branches).
- [ ] **Observer Verification**: `status`, `explain`, and signal bus report verified milestone in `BLACKBOARD.md` Zone 3.
