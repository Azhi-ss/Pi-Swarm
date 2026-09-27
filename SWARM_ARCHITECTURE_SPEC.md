# 分布式自主蜂群系统 (Pi-Swarm) 架构规格与设计裁决 (Spec)

> **版本**：v2.0 (全裁决沉淀版)  
> **设计哲学**：基于 OpenAI Noam Brown 关于万级 Agent 蜂群涌现式协调、扁平网络、最小脚手架（Minimal Scaffolding）、并行测试时算力（Parallel Test-Time Compute）及端到端客观闭环的反推设计。
> **核心定位**：本地优先（Local-First），主 Agent 委托观察 + 蜂群自组织攻坚 + 机器客观验证门禁 + 专属 Worktree 隔离。

---

## 一、 系统全局拓扑与核心角色心智模型

整个系统在人机交互与节点分工上确立为清晰的**“双层解耦拓扑”**：

```
人类开发者 (终端键盘交互)
   │
   ▼ 提出需求 / 随时按键唤出 TUI 看板监控
┌────────────────────────────────────────────────────────┐
│ 1. 主 Coding Agent (用户面对的代理人)                   │
│    - 角色定位: 委托者 (Delegator) + 观察者 (Observer)  │
│    - 职责边界: 接收人类需求，将总目标与验收标准放上黑板；│
│                一键拉起自组织蜂群；不微观插手内部执行；  │
│                通过 TUI 键盘提供只读监控仪表盘；         │
│                保留人类一键紧急打断权 (SIG_ABORT 刹车)； │
│                蜂群合并完成后，直接向人类呈现最终成果。  │
└──────────────────────────┬─────────────────────────────┘
                           │ 按需释放 (不搞微观命令，充分放权)
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Swarm 蜂群网络 (无中心的对等自组织网格)             │
│    - 角色定位: 地位完全平等的 Peer 节点 (无主从/父子)   │
│    - 职责边界: 看黑板软认领假说、独立沙箱内攻坚、       │
│                自由提出策略 (propose)、辩论挑刺(challenge)│
│                本地机器跑测试自愈、跑通后直接受控合并。  │
└────────────────────────────────────────────────────────┘
```

---

## 二、 核心架构模块已定裁决清单 (Architectural Decisions)

### 模块 1：扁平拓扑与节点平权 (Flat Mesh Topology & Peer Equivalence) — [✅ 已代码落地]

- **核心裁决**：
  1. **彻底消除特权尊卑**：源码中全面清除 `PI_SWARM_SPAWNED` 特权分支（涵盖 `index.ts`、`harness/`、`swarm/`），解除会话退出级联强杀，所有 Agent 均作为合法的独立 Peer 节点接入网格。
  2. **短暂接力生命周期 (Ephemeral Lifecycle)**：Agent 遵循“用完即退”的短暂攻坚哲学，完成单点任务或达到步数阈值后提炼产物退出，新 Agent 冷启动接力，保护 Context 窗口纯净度。
  3. **进程组脱离管理**：采用 POSIX 进程组脱离（`detached: true`）与负 PID 组信号（`process.kill(-pid)`），保证子 Agent 独立生命周期，彻底消灭僵尸孤儿进程。
  4. **扩展提案与反驳动词**：CLI 扩展支持 `pi-messenger-swarm propose <taskId> "策略"` 与 `challenge <taskId> "反驳"`，实现 TaskStore 状态机与 Channel Feed 双流持久化。
  5. **极简脚手架提示词**：重构 `buildSwarmProtocol()`，废弃 10 条死板管束军规，替换为轻量对等指引。

---

### 模块 2：分级公共主题通信总线 (Hierarchical Topic Bus - Pub/Sub)

- **核心裁决**：
  1. **树状命名空间分流**：
     - `swarm/announcements`：全局广播重大进展与全局刹车信号（严格限频）。
     - `task/<taskId>`：模块攻坚与方案辩论子频道。
     - `agent/<agentId>/inbox`：点对点求助私信。
  2. **拉取优先与精准抢占 (Pull-First & Steer Wakeup)**：
     - 普通信道消息采用拉取（Pull）模式，绝不无脑强塞 Agent 上下文。
     - 仅当收到精准的点对点私信或全局紧急叫停时，利用原插件现成的 `triggerTurn: true, deliverAs: 'steer'` 通道毫秒级强行打断唤醒。

---

### 模块 3：四区全局黑板系统与单文件快照 (Blackboard & Readable Projection) — [✅ 已代码落地]

- **设计范式与核心价值**：
  - 吸取 Anthropic Claude 生物酶超级蜂群的假说管理与 OpenAI 万级蜂群的最小状态交互思想。
  - **CQRS 读写分离**：写操作基于 append-only JSONL 事件流追加（零文件锁竞争、抗高并发写入）；读操作自动聚合出单文件 Markdown 快照（`BLACKBOARD.md`），单次读取严格限制在 `<1000 tokens`，彻底杜绝上下文暴击。
- **四区数据流模型 (Four-Zone Data Model)**：
  1. **🎯 目标区 (Zone 1: Goal & Open Backlog)**：
     - 收录全局任务规格、验收标准、前置依赖 (`depends_on`)、关联提案 (`proposals`) 与可选的验证命令 (`verify_command`)。
     - 状态涵盖 `todo` 与 `blocked`（等待依赖解除）。
  2. **⚡ 软认领区 (Zone 2: Soft Staking & Leased Explorations)**：
     - **假说声明式认领**：Peer 节点自主声明探索方案（`task.stake <id> --reason "方案路径"`）。
     - **带 TTL 的轻量租约 (Lease Contract)**：默认租约时间 300 秒（`lease_expires_at = now + 300s`）。
     - **心跳续期与并发无锁抢占**：通过 `task.heartbeat` 续租；若节点崩溃挂死（通过系统级 PID 探活 `isProcessAlive`）或租约过期，其他 Peer 均可在 `acquireTaskClaim` 中无锁抢占接力。
  3. **🏆 黄金事实区 (Zone 3: Verified Artifacts & Immutable Golden Facts)**：
     - 仅收录通过机器客观验证器（Exit Code 0）的最终成果，记录验证人、时间戳、执行命令及生成的物理补丁文件 (`.patch`) 路径与 SHA。
  4. **🪦 避坑区 (Zone 4: Graveyard & Dead Ends)**：
     - 收录被机器客观证伪的方案、错误日志摘要与反例测试（Dead Ends），阻断全蜂群在相同死胡同上浪费算力。
- **底层数据结构与事件契约 (Schema & Event Contracts)**：

  ```typescript
  // 核心任务数据结构 (SwarmTask)
  interface SwarmTask {
    id: string;
    title: string;
    status: 'todo' | 'staked' | 'in_progress' | 'blocked' | 'verified' | 'done' | 'dead_end';
    claimed_by?: string;
    claim_reason?: string;
    lease_expires_at?: string; // ISO-8601
    verification_attempts?: number;
    verify_command?: string;
    verification?: {
      passed: boolean;
      exitCode: number;
      command: string;
      verifiedBy: string;
      verifiedAt: string;
      patch?: string; // 补丁文件路径
      durationMs: number;
    };
    dead_ends?: Array<{ agent: string; reason: string; timestamp: string; attempts: number }>;
    last_verification_failure?: {
      output: string;
      exitCode: number;
      timestamp: string;
      agent: string;
    };
  }

  // 核心事件类型
  type TaskEvent =
    | { type: 'task.staked'; taskId: string; agent: string; ttl: number; reason: string }
    | { type: 'task.heartbeat'; taskId: string; agent: string; ttl: number }
    | { type: 'task.verified'; taskId: string; agent: string; verification: VerificationResult }
    | { type: 'task.dead_end'; taskId: string; agent: string; reason: string; attempts: number };
  ```

- **单文件投影生成器规范 (`BLACKBOARD.md`)**：
  - 触发机制：任何任务事件追加时同步/防抖触发投影重算；
  - 呈现内容：`Active Peers (Mesh Registry)` 网格活跃节点与 PID 表 + 四区任务卡片；
  - 格式控制：无冗余正文，失败报错仅截取前 180 字符，单次渲染体积保持极简。

---

### 模块 4：客观真实验证器与自愈闭环 (Ground Truth Verifier & Self-Healing Loop) — [✅ 已代码落地]

- **设计范式与核心价值**：
  - 践行 OpenAI Noam Brown 核心理念：**“客观机器裁判（Ground Truth Verifier）是涌现协作的基石”**。
  - 杜绝多智能体之间用自然语言“幻觉自证完成”或“互相拍马屁式虚假确认”。
- **客观真实验证门禁 (Verification Gate Protocol)**：
  1. **拦截契约**：在 `task.done` 接口处设立强制拦截门禁，阻止 Agent 随意将状态改为 completed。
  2. **验证命令解析层级**：
     - ① CLI / 请求参数显示指定的 `--verify <cmd>`；
     - ② 任务黑板元数据绑定的 `task.verify_command`；
     - ③ 项目根目录自动探测（探测 `package.json` 中的 `test` 脚本，缺省为 `npm test`）。
  3. **沙箱物理执行与硬超时**：
     - 使用 `spawnSync` 在工作区物理执行，捕获真实的 `exitCode`、`stdout` 与 `stderr`；
     - 默认 60s 硬超时控制，超时触发 `ETIMEDOUT` 并强制 Kill 进程树（返回 Exit Code 124），严防死循环挂起。
- **Steer 报错注入与沙箱自愈回路 (Self-Healing Loop)**：
  - **触发条件**：`exitCode !== 0` 且未达到重试上限。
  - **状态保持**：任务状态维持在 `staked` / `in_progress`，拒绝完结。
  - **Steer 回弹注入**：拦截 `stderr/stdout` 报错堆栈，通过 `deliverAs: 'steer'`, `triggerTurn: true` 毫秒级打回原 Agent 终端会话：
    ```json
    {
      "type": "verification_failed",
      "command": "npm test",
      "exitCode": 1,
      "stderr": "...AssertionError: expected true to be false...",
      "instruction": "Verification failed. Inspect the test failure above, fix the bug in your sandbox, and verify again."
    }
    ```
- **负向知识沉淀与全群快速剪枝 (Fast Pruning Protocol)**：
  - **剪枝触发阈值**：单任务累计连续失败 3 次（`verification_attempts >= 3`）。
  - **避坑归档**：任务标记为 `dead_end`，捕获最终报错原因归档至黑板 Zone 4（Graveyard）。
  - **全局信道广播**：向系统全局 Channel Feed 广播 `task.dead_end` 剪枝事件。
  - **租约释放**：主动释放该任务的认领所有权与租约锁，阻断其他 Peer 在同质化失效路径上耗费无谓算力。
- **补丁产物自动生成 (Patch Artifact Generation)**：
  - 验证成功（Exit Code 0）时，系统自动执行 `git diff HEAD` 生成原子级物理补丁，写入 `.pi/messenger/artifacts/<taskId>.patch`，并记录补丁 SHA 晋升入黄金事实区。

---

### 模块 5：物理进程看门狗与全灭兜底 (Physical Watchdog & All-Dead Fallback)

- **设计范式与核心价值**：
  - **彻底消灭口头辩论的过度设计 (No Conversational Debate Overhead)**：摒弃让 Agent 在群聊中互相打嘴炮“辩论”的反模式。蜂群节点地位完全对等、互不干涉，自主看黑板抢占假说、沉入独立沙箱改代码跑测试。**客观机器测试（Exit Code 0）是决出胜负的唯一法官**，方案谁优谁劣由测试说了算，绝不浪费 Token 搞人工辩论。
  - **复用宿主基建，物理看门狗托底**：看门狗回归纯粹的物理与系统级防护底座，深度协同本地已有的 `@aliou/pi-processes` (`ps`) 插件。

- **核心裁决与四大防护防线**：
  1. **物理进程托管与死循环强杀 (Process Supervision via `ps`)**：
     - **受管登记**：Worker 派生时无缝注册为 `ps` 后台受管进程（命名为 `[Swarm] worker-<id>`），并注入 10 分钟（600s）全局硬超时；
     - **挂死拦截**：若沙箱测试陷入死循环（如 `while(true)`）或网络卡死，`ps` 底层触发 POSIX 进程组负 PID 强杀（`kill(-pid, SIGKILL)`），并联动模块 7 自动物理销毁沙箱，杜绝僵尸进程与磁盘残留；
     - **终端可观测**：人类可随时在 Pi 对话中输入 `/ps` 查看实时状态，输入 `/ps:logs worker-<id>` 追查沙箱真实测试日志，保留 `/ps:kill` 紧急人工制动权。
  2. **僵尸租约自动回收 (Stale Lease Reclamation)**：
     - 配合黑板 Zone 2 的 300s TTL 租约机制；
     - 看门狗定期巡检 Worker 的系统存活状态；若 Worker 进程意外崩溃且租约超时，看门狗自动将该假说状态重置为 `todo`，释放认领权，供其他存活 Worker 接力攻坚。
  3. **全灭检测与主 Agent 唤醒闭环 (All-Dead Fallback Protocol)**：
     - **触发条件**：某任务下的全部假说方案均连续 3 次验证失败被打入避坑区（`dead_end`），且存活活跃 Worker 数量降为 0（无节点在攻坚）；
     - **唤醒动作**：看门狗利用 Pi 原生的 `deliverAs: 'steer'`, `triggerTurn: true` 毫秒级强行唤醒主 Coding Agent；
     - **归因交付**：生成单份精炼的《避坑死因归因简报》（汇集所有 Worker 的尝试方案、报错堆栈、被证伪反例），交由主 Agent 或人类重构任务 Prompt 或重新规划总目标，彻底杜绝无声死锁。
  4. **全蜂群步数预算熔断器 (Global Step Budget Circuit Breaker)**：
     - 设定整场任务总调用轮次上限（默认 50 步）；
     - 触碰红线立刻触发全局熔断，向信道广播 `swarm.abort`，联动 `ps.killAll()` 停止一切沙箱活动，保护黑板已验证的黄金事实成果，杜绝失控刷 Token。

---

### 模块 6：受控交付与直接合并权限 (Direct Verified Merge Protocol)

- **核心裁决**：
  1. **蜂群拥有端到端合并权限**：
     - 蜂群节点拥有明确、受控的代码修改与合并权限，不仅仅是给建议。
     - 胜出的 Agent 在沙箱里**确认所有单元测试 100% 跑通后，直接拥有权限将经过验证的补丁（`git apply`）合并至主代码库**。
  2. **主 Agent 轻松验收**：
     - 主 Agent 唤醒后，直接面对一个已经修改完毕、测试通过的干净主工程，只需做最终 Git 状态核对，即可向人类交差。

---

### 模块 7：专属 Worktree 沙箱环境隔离 (Dedicated Worktree Sandbox) — [✅ 已代码落地]

- **设计范式与核心价值**：
  - 彻底终结多 Agent 并发开发时的“文件写踩踏”、“测试端口冲突 (EADDRINUSE)”与“主代码库脏修改”。
  - **极速与轻量 (Local-First)**：采用 Git 原生 Detached Worktree 机制，与主仓库共享 `.git/objects` 历史库，毫秒级就绪且磁盘占用极小。
- **核心实现规范 (Implementation Specs)**：
  1. **Swarm 专属受管目录与根忽略**：
     - 所有 Worker 物理隔离工作区统一建在 `.swarm/workspaces/worker-<agent-id>/`。
     - 根目录 `.gitignore` 包含 `.swarm/workspaces/` 与 `.swarm/patches/`，人类开发者的主工作区与版本控制完全无感。
  2. **游离 HEAD 模式，零分支污染 (`--detach`)**：
     - 使用 `git worktree add --detach .swarm/workspaces/worker-<agent-id> HEAD`。
     - **不创建任何多余的临时 Git 分支**，开发者的 `git branch` 保持绝对整洁。
  3. **依赖秒级就绪 (`node_modules` 软链优化)**：
     - 沙箱创建后自动在沙箱根目录建立指向宿主 `node_modules` 的软链接，避免每个沙箱重复执行包安装命令，秒级具备完整测试和执行环境；
     - 沙箱销毁时安全解除软链接，**严防误删宿主依赖**。
  4. **运行时环境变量隔离 (Runtime Isolation)**：
     - 动态端口槽位管理 (`PortSlotManager`)：分配独立的 `PORT` 与 `TEST_PORT`（按 Agent 槽位递增偏移，如 `3100+slot` 与 `3200+slot`），杜绝本地服务并发冲突；
     - 独立临时目录：注入专属 `TMPDIR=/tmp/agent-<id>`。
  5. **进程 CWD 重定向与验证器门禁联动**：
     - `swarm/spawn.ts` 将 Worker 子进程的 `cwd` 精准重定向到分配的沙箱物理路径；
     - 模块 4 验证器在 `task.done` 时自动识别并在该沙箱路径下执行客观测试，并将沙箱内的 `git diff HEAD` 生成物理 `.patch` 归档至主工程 `.pi/messenger/artifacts/<taskId>.patch`。
  6. **生命周期回收与防呆清理 (Lifecycle & Prune)**：
     - 任务结束或 Agent 退出时自动执行 `git worktree remove --force`；
     - 系统初始化与重连时执行 `git worktree prune`，自动回收异常崩溃残留的孤儿工作区。

---

## 三、 当前整体工程状态与路线图 (Roadmap Status)

- [x] **Phase 1: 核心理念与架构裁决收敛** —— 全部对齐确立
- [x] **Phase 2: 模块 1（扁平对等与脚手架瘦身）** —— 代码已落地，全量 359 项测试 100% 通过
- [x] **Phase 3: 模块 3 & 4 联动（四区黑板快照生成器 + 提交测试门禁钩子 + 自愈与剪枝）** —— 代码已落地，通过独立胜利审计，全量 54 个测试套件、429 项测试 100% 通过
- [x] **Phase 4: 模块 7 落地（`--detach` Worktree 专属隔离沙箱分配与回收 + 运行时隔离）** —— 代码已落地，全量 55 个测试套件、435 项测试 100% 通过
- [ ] **Phase 5: 模块 5 & 6 落地（物理看门狗 ps 托管与全灭兜底 + 验证通过受控直接合并）**
- [ ] **Phase 6: TUI 监控看板适配（纯粹观察者仪表盘与一键刹车键）**
