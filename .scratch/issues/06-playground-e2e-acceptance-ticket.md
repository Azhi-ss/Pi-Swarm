# Issue #6: Solo pi vs Swarm — Bohrium noisy-blackbox

规格以 [docs/specs/0002-live-swarm-e2e-benchmark.md](../../docs/specs/0002-live-swarm-e2e-benchmark.md) 为准。

两次测试，模型都是 `(gpugeek) DeepSeek-V4.1-Flash • high`（`pi --model gpugeek/DeepSeek-V4.1-Flash:high`）。

- [ ] **Run 1 Solo**：`pi --no-extensions`，不加载 pi-swarm。空桩 `solver.py` 起步。官方 `attempt_id` / `score` / `rank` 归档到 `~/arena/noisy-blackbox-optim/archive/solo/`。
- [ ] **Run 2 Swarm**：Run 1 归档后，`solver.py` 重新回到空桩，不得读取 solo 的解。委托者与每个 `spawn --model gpugeek/DeepSeek-V4.1-Flash:high` 的 worker 同一模型。官方结果归档到 `archive/swarm/`。
- [ ] **对比表**写回 issue：两次的 `attempt_id`、`score`、`rank`。假说是 swarm 分高于 solo；证伪也照记。

#3 和 #5 已关闭。两次测试都没有未完成的前置 ticket。
