# Issue #6: Solo pi vs Swarm — Bohrium noisy-blackbox

规格以 [docs/specs/0002-live-swarm-e2e-benchmark.md](../../docs/specs/0002-live-swarm-e2e-benchmark.md) 为准。下面是执行时不能丢的约束。

同一赛题、同一模型，分两个目录各跑一次。模型都是 `(gpugeek) DeepSeek-V4.1-Flash • high`。

- [ ] **两个目录**：`~/arena/noisy-blackbox-optim/` 只当题包源。拷成 `noisy-blackbox-solo/` 和 `noisy-blackbox-swarm/`。两份 `solver.py` 都从官方空桩开始，并删掉占位 `traces/trace.jsonl`。
- [ ] **隔离**：swarm 目录 `git init` 并提交基线。两次都用各自的 `--session-dir .pi-session`，禁止 `--continue`。Run 2 不得读取 solo 目录，也不得读取 `~/.pi/agent/sessions`。
- [ ] **Goal**：`~/.pi/agent/pi-goal.json` 的 `automaticTurns` 设为 `null`，两边输入同一句 `/goal`。
- [ ] **Run 1 Solo**：tmux `noisy-solo`。`pi --no-extensions -e npm:@narumitw/pi-goal --session-dir .pi-session --model gpugeek/DeepSeek-V4.1-Flash:high`，再输入规格里的 `/goal`。只正式提交一次。`attempt_id` 和 `score` 写入该目录的 `attempt.json`。
- [ ] **Run 2 Swarm**：Run 1 提交后再开 tmux `noisy-swarm`。同一条 `pi` 再加 `-e /home/dministrator/project/pi-swarm`。先输入同一个 `/goal`，再 `run start --goal` 用这句话。每个 worker 都要 `spawn --model gpugeek/DeepSeek-V4.1-Flash:high`。只正式提交一次。
- [ ] **收敛**：swarm 的官方 `score` 高于 solo 即关闭。不要求 `> 0.8000`，也不看套题总榜名次。`playground status` 不返回 `rank`。

#3 和 #5 已关闭。
