# AGENTS.md — Pi-Swarm 智能体开发与协作指南

> 本文件是面向 AI Coding Agents 的机读操作指南（README for Agents）。
> 进入本代码库的任何智能体均须遵循以下架构模型、命令清单与协作规范。

---

## 1. 项目概览 (Project Overview)

- **核心定位**：基于 `pi-messenger-swarm` 重构的轻量级、去中心化多智能体蜂群系统。
- **设计哲学**：践行 OpenAI Noam Brown（无中心协调官、对等扁平自组织、最小脚手架、客观机器裁判）与 Anthropic Claude 超级蜂群（假说软认领、沙箱筛选、Fast Pruning 快速剪枝）理念。
- **核心角色**：
  - **主 Coding Agent**：面向人类开发者的委托者与只读观察者，发布总目标规格，不微观插手；
  - **Swarm Peer 节点**：地位平等的对等工作节点，看黑板自主认领，独立沙箱攻坚，受控直接合并。

---

## 2. 常用构建与测试命令 (Essential Commands)

必须使用真实命令验证代码，严禁假想测试：

```bash
# 依赖与类型检查
pnpm install
npx tsc --noEmit

# 生产构建
pnpm run build

# 全量自动化测试 (Vitest)
npx vitest run

# 运行单个测试文件
npx vitest run tests/swarm/worktree-sandbox.test.ts

# 常用 CLI 工具动词 (蜂群交互)
pi-messenger-swarm blackboard show
pi-messenger-swarm task stake <taskId> "方案描述"
pi-messenger-swarm task heartbeat <taskId>
pi-messenger-swarm task done <taskId> "完成说明与证据"
pi-messenger-swarm propose <taskId> "策略方案"
pi-messenger-swarm challenge <taskId> "反驳理由与反例"
```

---

## 3. 架构与工作区映射 (Workspaces & Architecture)

- **宿主主工作区 (`projectRoot`)**：人类与主 Agent 所在目录，常规任务执行期间保持干净与只读；
- **Agent 专属沙箱 (`.swarm/workspaces/worker-<id>/`)**：基于 `git worktree add --detach` 创建的游离 HEAD 独立目录，软链复用宿主 `node_modules`；
- **四区全局黑板 (`BLACKBOARD.md`)**：单文件 CQRS 只读快照（<1000 tokens），呈现目标区 (Goal)、软认领区 (Soft Staking)、黄金事实区 (Verified) 与避坑区 (Graveyard)；
- **产物存储区 (`.pi/messenger/artifacts/<taskId>.patch`)**：保存通过机器客观验证的代码补丁。

---

## 4. 智能体行为规范 (Agent Behavioral Guidelines)

1. **看黑板工作 (Blackboard-Driven)**：
   - 攻坚前查阅 `BLACKBOARD.md` 了解全局规格、已被证伪的避坑路径与当前租约；
   - 认领任务使用 `task stake <id>`，享有默认 300 秒 TTL 租约，期间通过 `task heartbeat` 或进度上报自动续约。
2. **专属沙箱优先 (Sandbox First)**：
   - 必须在分配的专属沙箱 `.swarm/workspaces/worker-<id>` 内修改与调试代码；
   - 严格使用系统动态注入的环境变量（`$PORT`、`$TEST_PORT`、`$TMPDIR`），杜绝本地资源互踩。
3. **机器客观验证 (Ground Truth Verifier)**：
   - 调用 `task done` 自动触发机器客观测试门禁（默认 `npm test` 或指定 `--verify` 命令）；
   - **退出码 Exit Code 0 是完成的唯一标准**，严禁自然语言虚假确认；
   - 测试通过自动生成 `.patch` 归档至黄金事实区；测试失败通过 Steer 报错回路在沙箱内自愈。
4. **快速剪枝与止损 (Fast Pruning)**：
   - 单任务连续 3 次验证失败，系统自动归档至避坑区（Graveyard）并全局广播 `task.dead_end` 剪枝信号；
   - 触发剪枝后主动释放任务租约，转向其他假说方案，阻断算力浪费。
5. **短暂接力与证据辩论 (Ephemeral & Light)**：
   - 阶段性成果（如完成一个子函数或反例用例）验证通过并写入黑板后优雅退出，由新 Agent 冷启动接力，保护上下文纯净；
   - 质疑他人方案使用 `challenge`，必须尽量附带可复现反例用例，凭代码事实辩论。

---

## 5. 红线与安全禁忌 (Boundaries: What NOT to do)

- ❌ **严禁在宿主根目录直接修改代码**（必须在分配的专属 Worktree 沙箱内操作）；
- ❌ **严禁创建命名的临时 Git 分支**（必须使用 `--detach` 游离检出，保持用户 `git branch` 纯净）；
- ❌ **严禁删除或覆盖宿主 `node_modules`**（沙箱退出仅解绑软链接）；
- ❌ **严禁在未通过机器真实测试（Exit 0）前口头声明完成**；
- ❌ **严禁过度设计**（遵循 Karpathy / Ponytail 哲学：最短可用 Diff 胜出，禁止非必要的层层抽象与外部依赖引入）。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `Azhi-ss/Pi-Swarm`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
