# Spec 0002: Live Swarm E2E Benchmark — Bohrium Playground Noisy Blackbox Optimization

- **Status**: Accepted
- **Driver**: Pi-Swarm Engineering
- **GitHub Issue**: [#6](https://github.com/Azhi-ss/Pi-Swarm/issues/6)
- **Target Competition**: `terminal-bench-science-v0-1-0-noisy-blackbox-optim-8ba810d5`
- **Platform**: [DP Technology Bohrium Playground](https://play.bohrium.com/)

---

## 1. 目标与背景 (Context)

前期针对单文件、10 行代码小 Bug（如 `trpc-7604` 与 `openai-agents-js-375`）的实测证明：单 Agent 凭借局部上下文在 1 分钟内即可解决，无法检验多智能体协同价值。

本规格将 Pi-Swarm 终极 E2E 验收升级为**高维、高熵、具备真实机器裁判与全球排行榜的科学计算赛题**：

- **赛题名称**：`Terminal-Bench Science v0.1.0: noisy-blackbox-optimization`
- **目标产物**：`/app/solver.py`（算法核心接口 `def solver(fun, x0) -> x_best`）
- **核心挑战**：在未知确定性高维噪声（$\widetilde f(x) = f(x) + \epsilon \eta(x) \max\{1, |f(x)|\}$）及极紧评估预算（$100 \times n$）下，纯手写自研优化算法击败经典 SciPy `Powell` 算法。
- **硬性约束**：严禁调用任何第三方优化库（`scipy.optimize`、`cma`、`nevergrad` 等），必须纯手写算法。

---

## 2. 独立工作区与官方交互 (Workspace & Interface)

- **工作区路径**：`~/arena/noisy-blackbox-optim/`（与 `pi-swarm` 代码库完全解耦）
- **官方输入**：`task.md`
- **官方产物**：`outputs/solver.py`
- **官方轨迹**：`traces/trace.jsonl`

---

## 3. 官方评分与排行榜排名验收标准 (Official Scoring & Ranking)

**本验收测试唯一认可的真值为 Bohrium 官方平台评测结果与官方排行榜排名。**

1. **官方评分标准**：
   - 官方评估器在 10 个精度目标（$10^{-1} \dots 10^{-10}$）上对实际历史曲线计算 AUC 积分，以 SciPy `Powell` 作为归一化基线（基线得分 `0.5000`）；
   - **及格硬性门槛**：官方云端最终得分必须严格 `> 0.8000`。
2. **官方排行榜与排名验收**：
   - 通过 `playground submit` 提交生成官方 `attempt_id`；
   - 通过 `playground status --attempt-id <attempt_id>` 轮询官方云端状态、官方分数与**官方排行榜排名 (`rank`)**；
   - **最终验收必须核验官方排名，确认蜂群算法在官方榜单上取得有效竞争名次**。
3. **ARM 轨迹规范**：
   - 必须通过 `playground trace validate --trace traces/trace.jsonl` 100% 格式检验。

---

## 4. 蜂群协同攻坚架构 (Swarm Execution)

- **Worker 1 & 2**：自适应差分进化（Adaptive Differential Evolution）假说
- **Worker 3 & 4**：带噪声平滑的信赖域二次逼近（Trust-Region）假说
- **Worker 5 & 6**：坐标轮换与自适应收缩模式搜索（Pattern Search）假说
- **Worker 7 & 8**：专职构造破坏性反例与回归测试门禁
- **收敛合入**：高分算法通过受控直接原子合并协议（Direct Atomic Merge）合入宿主主干（Zone 3 Verified Artifacts）。

---

## 5. 验收依赖前置 (Dependencies)

- [x] 赛题工作区环境与官方 CLI 预检跑通
- [ ] #3: Peer 发现与通信信令
- [ ] #5: 观察者全局管控与解释
