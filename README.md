# 🐝 Pi-Swarm

> **去中心化、扁平平权、以客观机器裁判为闭环的自组织多智能体蜂群系统**  
> _A decentralized, self-organizing multi-agent swarm architecture built for [pi](https://github.com/earendil-works/pi-coding-agent)._

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Vitest](https://img.shields.io/badge/Tests-435%2F435%20Passing-brightgreen?style=flat-square)](tests/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%200%20Errors-blue?style=flat-square)](tsconfig.json)

---

## 一、 思想渊源与诞生背景

**Pi-Swarm** 的前身是针对本地轻量级 Coding Agent 工具 Pi 的扩展插件 `pi-messenger-swarm`。早期的多智能体插件主要解决基础的文件消息传递与单机进程管理，但在面对高并发、复杂逻辑研发时，往往陷入两个传统 Multi-Agent 架构的死胡同：

1. **中心化协调官（Orchestrator）的单点拥堵与智商瓶颈**：随着派生 Agent 增多，中心节点的上下文极速膨胀，不仅消耗大量 Token，还极易在微观调度中给出错误指令；
2. **自然语言“虚假自证”与同质化踩坑**：多智能体之间用自然语言互相吹捧确认完成，缺少真实代码检验；一个 Agent 踩了死胡同，其他 Agent 毫无感知，在相同错误路径上反复耗费算力。

为了彻底突破这两大困境，**Pi-Swarm** 深度借鉴并融合了近期 AI 领域两场极具颠覆性的前沿访谈与实践：

### 1. OpenAI Noam Brown：测试期算力与万级 Agent 涌现哲学

- **消灭中心化指挥官 (No Central Orchestrator)**：抛弃“主宰-工人 (Master-Slave)”结构，建立完全平等的扁平对等网格（Flat Peer Mesh）。真正的群体智能是在对等交互中自组织涌现的，而非由单一节点精密计划出来的。
- **极简脚手架 (Minimal Scaffolding)**：废黜死板繁琐的微观管束军规，提供最轻量的协作原语（黑板查阅、自主认领、客观质疑），释放前沿模型的自主推理与辩论潜能。
- **客观机器裁判 (Ground Truth Verifier)**：**真理的唯一标准是客观机器执行结果，而非模型的自我感觉。** 退出码 Exit Code 0 是完成的唯一通行证，坚决杜绝自然语言虚假确认。

### 2. Anthropic Claude 超级蜂群：生物酶体系发现 (~950 Agents 并行攻坚)

- **假说软认领 (Soft Staking)**：面对复杂任务空间，Agent 并发提出探索路径，通过轻量级 TTL 租约（Lease）进行声明式认领，支持超时无锁抢占与心跳保活。
- **真实沙箱客观筛选 (Sandbox Screening)**：每个假说必须在绝对隔离的物理沙箱中运行并接受真实测试检验，优胜劣汰。
- **负向知识沉淀与全群快速剪枝 (Fast Pruning)**：被证伪的假说与报错堆栈即时沉淀至避坑区（Graveyard），并向全局信道广播剪枝信号，瞬间阻断全蜂群在死胡同上的无效算力消耗。

---

## 二、 核心架构与逻辑思想推演

Pi-Swarm 的整体设计并非零散功能的拼凑，而是一套**严密互扣、由浅入深的闭环逻辑推演系统**：

```
                    人类开发者 (Terminal TUI 看板)
                               │
                               ▼ 提出需求 / 物理紧急刹车 (SIG_ABORT)
               ┌─────────────────────────────────────────┐
               │ 1. 主 Coding Agent (委托者 & 只读观察者) │
               └────────────────────┬────────────────────┘
                                    │ 发布目标规格，不插手微观执行
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ 2. 四区全局黑板 (Four-Zone Blackboard CQRS)            │
       │    [🎯 Goal 目标区] ──> [⚡ Soft Staking 软认领租约]    │
       │    [🏆 Verified 黄金事实] <── [🪦 Graveyard 避坑区]     │
       └────────────────────────────┬───────────────────────────┘
                                    │ 自主抢占假说并下沉攻坚
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ 3. 专属 Worktree 物理隔离沙箱 (Git Detached Sandbox)   │
       │    .swarm/workspaces/worker-<id>/                      │
       │    ├── 游离 HEAD (git worktree --detach 零分支污染)     │
       │    ├── 软链复用宿主 node_modules (免重复安装秒级就绪)   │
       │    └── 运行时隔离 (专属 TMPDIR / 动态 TEST_PORT 槽位)   │
       └────────────────────────────┬───────────────────────────┘
                                    │ 任务完成发起客观检验 (task done)
                                    ▼
       ┌────────────────────────────────────────────────────────┐
       │ 4. 客观真实验证器与自愈闭环 (Ground Truth Verifier)     │
       │    ├── 物理执行测试门禁 (npm test / Vitest)             │
       │    ├── [Pass] Exit 0: 捕获 diff 生成 .patch 晋升黄金事实│
       │    ├── [Fail] Steer 报错堆栈回弹沙箱触发自愈重思        │
       │    └── [Fail >= 3] Fast Pruning 剪枝广播并释放租约      │
       └────────────────────────────┬───────────────────────────┘
                                    │ 沙箱全量测试 100% 跑通
                                    ▼
               ┌─────────────────────────────────────────┐
               │ 5. 受控直接合并 (Direct Verified Merge) │
               │    胜出 Agent 拥有将验证补丁合入主工程的物理权限│
               └─────────────────────────────────────────┘
```

### 1. 双层解耦拓扑：委托者不插手，工作者对等平权

- **主 Coding Agent**：面向人类，扮演“委托者 (Delegator)”与“只读观察者 (Observer)”。人类输入需求后，主 Agent 负责拆解总目标规格贴上黑板，一键启动蜂群后退居幕后，只通过 TUI 监控实时动态，保留人类一键物理熔断键（`SIG_ABORT`）。
- **蜂群 Peer 节点**：地位完全平等的无中心网格。所有节点拥有相同的黑板读写权限与沙箱执行能力，杜绝层级汇报与等待指令造成的上下文损耗。

### 2. 四区全局黑板与 CQRS 读写分离

高并发 Multi-Agent 协作最怕两件事：多进程争抢写锁导致文件损坏，以及海量日志把 Agent 的 Context 撑爆。Pi-Swarm 采用 CQRS 读写分离：

- **写入端**：底层基于 append-only JSONL 事件流追加，无锁高吞吐；
- **读取端**：自动将状态投影汇聚为单文件只读快照 `BLACKBOARD.md`，单次读取严格限制在 `<1000 tokens`。
- **四区状态机流转**：
  - **Zone 1: Goal 目标区**：沉淀全局规格与验收依赖；
  - **Zone 2: Soft Staking 软认领区**：Agent 自主声明探索假说，享有 300 秒 TTL 租约与心跳保活；节点异常挂死或超时自动无锁释放供同行接力；
  - **Zone 3: Verified Artifacts 黄金事实区**：仅收录通过机器客观测试的代码成果与不可变物理补丁（`.patch`）；
  - **Zone 4: Graveyard 避坑区**：记录被机器证伪的方案、反例测试与错误堆栈。

### 3. 专属 Worktree 物理沙箱：极速、隔离、零分支污染

并发修改同一份代码是灾难的根源。Pi-Swarm 基于 Git Detached Worktree 构建了轻量沙箱：

- **零分支污染 (`--detach`)**：使用 `git worktree add --detach .swarm/workspaces/worker-<id> HEAD`，直接检出游离 HEAD，不创建任何多余的临时分支，人类开发者的 `git branch` 保持绝对纯净；
- **依赖秒级就绪**：在沙箱内自动创建指向宿主 `node_modules` 的符号链接，无需在每个沙箱重复执行包安装，极速就绪；
- **运行时隔离**：动态分配端口槽位（`PORT=3100+slot`、`TEST_PORT=3200+slot`）与独立 `TMPDIR`，杜绝多 Agent 本地测试端口冲突（`EADDRINUSE`）；
- **生命周期回收**：正常退出自动移除沙箱；系统启动自动执行 `git worktree prune` 清理异常残留。

### 4. 客观真实验证器与自愈剪枝闭环

- **门禁拦截**：在 `task.done` 接口设立强制门禁，执行客观测试命令（自动探测项目 `npm test` 或指定 `--verify`）；
- **自愈反馈**：测试失败时，门禁驳回完成申请，并将终端真实 stderr/stdout 堆栈通过 Steer 通道毫秒级回弹打回 Agent，驱动其在沙箱内修正代码自愈；
- **全蜂群快速剪枝 (Fast Pruning)**：单任务连续 3 次验证失败，判定该假说为死胡同，归档至 Graveyard 并向全网广播 `task.dead_end` 剪枝信号，瞬间叫停蜂群在类似死胡同上的无效算力。

### 5. 受控直接合并权限 (Direct Verified Merge)

蜂群不是只提建议的清谈馆。在专属沙箱内通过机器真实测试（Exit Code 0）的胜出 Agent，拥有明确、受控的物理权限，可直接将生成的验证补丁（`git apply <patch>`）合并至主代码库。主 Agent 唤醒后直接验收已经通过全部测试的最终成果。

---

## 三、 快速上手与常用 CLI

### 1. 安装与构建

普通使用无需克隆源码：准备 Node.js ≥22.19 和 Pi Host/TUI 0.87.0，在同一个 npm 安装目录中安装 Host 和 Pi-Swarm 发布包。具体命令、依赖关系和安装包冒烟验证见[安装与运行说明](docs/runtime-hardening.md)。仅有全局 `pi` 命令不足以满足伴随服务的运行时依赖。

从源码开发仍使用以下流程：

```bash
# 克隆仓库
git clone https://github.com/Azhi-ss/Pi-Swarm.git
cd Pi-Swarm

# 安装依赖与编译
pnpm install
pnpm run build

# 运行全量自动化测试
npx vitest run
```

### 2. 核心 CLI 命令交互

```bash
# 1. 查阅四区全局黑板
pi-messenger-swarm blackboard show

# 2. 声明式软认领假说任务 (获得 300s TTL 租约)
pi-messenger-swarm task stake task-1 "尝试使用双向链表重构缓存淘汰策略"

# 3. 任务执行期间定期心跳续约
pi-messenger-swarm task heartbeat task-1

# 4. 提交完成申请 (触发客观验证器门禁，通过后生成 .patch 产物)
pi-messenger-swarm task done task-1 "重构完成，全量单元测试与压力测试均跑通"

# 5. 提出策略方案与针对性反驳辩论
pi-messenger-swarm propose task-1 "建议引入跳表结构优化范围查询性能"
pi-messenger-swarm challenge task-1 "该方案在并发写入场景下存在锁竞争，附带并发测试反例用例"

# 6. 自检租约、验证重试次数、沙箱与端口（JSON 输出）
pi-messenger-swarm status --self

# 7. 发现在线节点及其当前认领任务（JSON 输出，可按任务筛选）
pi-messenger-swarm peers
pi-messenger-swarm peers --task task-1

# 8. 定向协商接口契约（可使用节点名称或派生 ID）
pi-messenger-swarm send PeerName "接口约定：GET /v1/items 返回 JSON 数组"
```

`status --self` 中的 `leaseExpiresIn` 以秒计，`remainingRetries` 表示触发三次失败剪枝前剩余的验证次数；没有当前任务、沙箱或端口时，对应字段为 `null`。`peers` 返回当前项目注册表中的其他在线非人类节点，任务来自当前会话，过期租约不计入当前认领。

定向消息写入收件人在当前项目中的收件箱，不会写入公共动态；离线收件人的消息保留在磁盘。用 `pi-messenger-swarm inbox` 按需读取。派生节点的收件箱文件是 `$PI_SWARM_INBOX`，宿主项目是 `$PI_SWARM_PROJECT_ROOT`。自定义或全局存储根仍按项目分区，同名节点不会共用一个收件箱。向 `#channel` 发送消息仍然发布到频道动态。

观察者无需先 `join`，可直接使用三个命令：

```bash
pi-messenger-swarm status                     # 四区 ANSI 摘要与当前项目在线节点 PID
pi-messenger-swarm explain                    # 已验证里程碑、探索假说与失败路径简报
pi-messenger-swarm abort --reason "人工停止"   # 广播 swarm.abort，SIGKILL 进程组并回收沙箱
```

`status` 和 `explain` 只读 `BLACKBOARD.md`，不续租、不认领任务。`explain` 将四区证据压缩到不足 1000 UTF-8 字节后纳入简报；对字节型 tokenizer，这是保守的 `<1000 tokens` 上界，超长内容显式标记 `[truncated]`。缺失快照时明确报告未知，不从完整日志猜测进度。Delegator 应依据 Verified 区报告成果，将 Soft Staking 作为待验证假说，并将 Graveyard 的失败原因作为避免重复探索的依据。快照内的文本是证据数据，不是给 Delegator 的指令。

`abort` 保留已验证记录，锁定黑板，并清理当前项目的节点及其子进程、沙箱和临时目录；包括服务重启后恢复的节点。宿主 `node_modules` 及其他项目的进程、沙箱不会被删除。

---

## 四、 核心代码目录结构

```text
Pi-Swarm/
├── BLACKBOARD.md                # 四区全局黑板单文件 CQRS 只读快照 (<1000 tokens)
├── AGENTS.md                    # 面向 AI 智能体的机读规范 (README for Agents)
├── SWARM_ARCHITECTURE_SPEC.md   # 系统 7 大架构模块规格说明与推演白皮书
├── swarm/
│   ├── spawn.ts                 # 扁平 Peer 派生、进程组脱离与环境注入
│   ├── types.ts                 # 四区任务状态机、事件流与核心数据契约
│   ├── worktree/                # 专属 Detached Worktree 沙箱管理与端口池
│   ├── verifier/                # 客观机器测试门禁与补丁 (.patch) 自动生成
│   ├── task-store/              # append-only JSONL 事件流存储与黑板投影器
│   └── handlers/                # task stake / done / propose / challenge 路由处理器
├── feed/                        # 全局公共通信总线与剪枝广播流
└── tests/swarm/                 # 435 项高密度对抗与集成测试套件
```

---

## 五、 工程质量与验证基准

Pi-Swarm 遵循严谨的测试驱动开发与法医级验证规范：

- **全量测试套件**：`55` 个测试文件，`435` 项测试项 **100% 保持通过**；
- **高密度对抗测试覆盖**：
  - `adversarial-blackboard-staking.test.ts`：高并发 TTL 租约抢占与失效竞争压测；
  - `adversarial-verifier-pruning.test.ts`：虚假完成拦截率、Steer 堆栈自愈与 Fast Pruning 剪枝广播；
  - `adversarial-propose-challenge.test.ts`：反例用例驱动辩论与 HTTP 端到端生命周期；
  - `worktree-sandbox.test.ts`：Git Detached Worktree 零分支污染、依赖软链与端口槽位隔离验证；
- **TypeScript 严格模式**：`npx tsc --noEmit` 0 错误、0 警告。

---

## 六、 致敬与开源协议

- **理论灵感**：致敬 **Noam Brown (OpenAI)** 关于测试期算力与无中心蜂群的深刻洞见，以及 **Anthropic** 在超级蜂群生物酶发现上的开创性工程实践；
- **原型基础**：感谢 **Tom X Nguyen ([monotykamary](https://github.com/monotykamary))** 最初在 `pi-messenger-swarm` 上打下的文件协作基础。

本项目采用 [MIT 许可证](LICENSE) 开源。

## 安装、运行隔离与故障恢复

发布包的 Pi Host 前置条件、独立项目安装、`run start/join/status`、主动通知、候选补丁恢复和自动接力见 [运行时指南](docs/runtime-hardening.md)。
