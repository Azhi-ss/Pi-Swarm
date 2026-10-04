# Issue #6: PI goal vs AutoResearch vs Swarm — abc record

规格以 [docs/specs/0002-live-swarm-e2e-benchmark.md](../../docs/specs/0002-live-swarm-e2e-benchmark.md) 为准。

同一赛题 `paper2arm-abc-conjecture-record-b335c57d`，同一模型 `(gpugeek) DeepSeek-V4.1-Flash • high`。三组各一个目录，各交一次。比较值是 `scoreIsFinal: true` 的 `displayScore`。

- [x] **组 1 纯 goal**：`~/arena/abc-conjecture-solo/`。只加载 `pi-goal`。attempt **48757**，`displayScore` **20**。48742 是原始 pi 会话，轨迹门系数为 0，不计入。
- [ ] **组 2 AutoResearch**：`~/arena/abc-conjecture-autoresearch/`。只加载 `npm:pi-autoresearch`。本地 `q` 更高才 keep。`maxIterations` 为 16。停稳后转轨迹，只提交一次。
- [ ] **组 3 Swarm**：`~/arena/abc-conjecture-swarm/`。`pi-goal` + 本地 pi-swarm。每个 worker `spawn --model gpugeek/DeepSeek-V4.1-Flash:high`。文件已写出，尚未提交。
- [ ] **轨迹**：每组用自己的 `.pi-session` 转成 ARM 步骤再交。轨迹里要有写出 `outputs/triple.json` 的那次执行。禁止读其他 arena 和 `~/.pi/agent/sessions`。
- [ ] **收敛**：Swarm 的官方最终分同时高于纯 goal 和 AutoResearch。高于一点即关闭。不要求 100，不看赛季排名。

#3 和 #5 已关闭。
