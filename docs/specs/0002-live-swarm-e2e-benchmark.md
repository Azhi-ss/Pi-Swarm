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

### Phase 1: Arena Setup & Project-Local Ephemeral Install (零污染单工程安装)

1. **物理目录与职责完全解耦**：
   - **插件研发源目录**：`/home/dministrator/project/pi-swarm`（当前插件源码所在，负责编写、编译与单测）；
   - **目标竞技场靶场目录**：`~/swarm-target-arena/openai-agents-js`（独立外置目录，绝不在当前项目内混合）；
   - **绝对隔离**：Bug 绝不放入当前 `pi-swarm` 目录，两个项目文件系统 100% 物理隔离。

2. **单工程临时安装（零污染正在使用的全局 Pi）**：
   - 使用项目级局部安装命令：
     ```bash
     cd ~/swarm-target-arena/openai-agents-js
     pi install /home/dministrator/project/pi-swarm -l
     ```
   - `-l` (`--local`) 保证插件配置仅写入靶场目录下的 `.pi/`，**绝不修改、绝不污染全局 `~/.pi`**，你的宿主 Pi 即使正在执行其他任务也完全不受任何干扰。
   - **免发 NPM 包**：直接利用本地绝对路径软链/加载，无需发布任何 npm 包。

3. **实时热修与自愈回路 (Rapid Hot-Reload)**：
   - 若实跑中发现蜂群逻辑或 CLI 有 Bug，直接在 `/home/dministrator/project/pi-swarm` 修改代码并执行 `pnpm run build`；
   - 靶场项目无需重新安装，下次启动自动加载最新的 `dist/` 构建产物，实现毫秒级快速自愈。

4. **基线与红灯用例就绪**：
   - 靶场检出目标基线 commit `6f1677c854b8daa427cbb11d105eca9f0f84d1f6`；
   - 应用测试补丁 `packages/agents-core/test/run.stream.test.ts`；
   - 执行客观验证命令，确认当前处于红灯（**Exit Code 1**，精准复现 Bug）。

### Phase 2: Swarm Launch (6–8 Workers)

1. **启动位置**：在目标靶场根目录 `~/swarm-target-arena/openai-agents-js` 启动蜂群：
   ```bash
   cd ~/swarm-target-arena/openai-agents-js
   pi-messenger-swarm spawn --count 8 --task "fix-streaming-agent-end" --verify "CI=1 NODE_ENV=test pnpm vitest run packages/agents-core/test/run.stream.test.ts"
   ```
2. **沙箱物理派发**：
   - 系统在靶场根目录下自动创建 `.swarm/workspaces/worker-1` 至 `worker-8` 的 Detached Worktree；
   - 自动软链接复用靶场宿主的 `node_modules`，各 Worker 独立调用你配置好的真实大模型 API；
   - 分配独立的端口偏移槽位（`PORT=3101..3108`, `TEST_PORT=3201..3208`）与 `TMPDIR`。
3. Workers 读取靶场根目录下的单文件黑板快照 `BLACKBOARD.md`，通过 `task stake` 软认领各自假说（默认 300s TTL 租约）。

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
