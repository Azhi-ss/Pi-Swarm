# Spec 0002: Solo pi vs Swarm — Bohrium noisy-blackbox

- **Status**: Accepted
- **Driver**: Pi-Swarm Engineering
- **GitHub Issue**: [#6](https://github.com/Azhi-ss/Pi-Swarm/issues/6)
- **Target Competition**: `terminal-bench-science-v0-1-0-noisy-blackbox-optim-8ba810d5`
- **Platform**: [DP Technology Bohrium Playground](https://play.bohrium.com/)

同一赛题、同一模型，跑两次。第一次没有 pi-swarm。第二次才开 swarm。比较值是官方 `score`。

## 1. 锁死的变量

两次都用这一条，界面上就是 `(gpugeek) DeepSeek-V4.1-Flash • high`：

```bash
pi --model gpugeek/DeepSeek-V4.1-Flash:high
```

provider、模型 id、thinking 档都不许换。worker 数量和算法假说不锁。

赛题是手写 `outputs/solver.py` 里的 `solver(fun, x0)`。禁止 `scipy.optimize` 以及 `cobyqa`、`cma`、`nevergrad`、`nlopt`、Py-BOBYQA 等现成优化器。官方分对 SciPy `Powell`（`0.5000`）做归一化。`0.8000` 只是题面参考线，不是这张 ticket 的关闭条件。

## 2. 两个目录

现有 `~/arena/noisy-blackbox-optim/` 只当题包源，不在里面跑。它现在不是 Git 仓库。两次各用一份拷贝，避免第一次的解、轨迹和 Git 历史被第二次读到。

|        | Run 1 Solo                     | Run 2 Swarm                                           |
| ------ | ------------------------------ | ----------------------------------------------------- |
| 目录   | `~/arena/noisy-blackbox-solo/` | `~/arena/noisy-blackbox-swarm/`                       |
| tmux   | `noisy-solo`                   | `noisy-swarm`，等 Run 1 提交后再开                    |
| 运行时 | `pi-goal`，不加载 pi-swarm     | `pi-goal` + 本地 pi-swarm                             |
| Git    | 不建仓库                       | `git init` 并提交基线。worktree 需要已有提交          |
| 会话   | `--session-dir .pi-session`    | 另一个 `--session-dir .pi-session`，禁止 `--continue` |

```bash
rm -rf ~/arena/noisy-blackbox-solo ~/arena/noisy-blackbox-swarm
cp -a ~/arena/noisy-blackbox-optim ~/arena/noisy-blackbox-solo
cp -a ~/arena/noisy-blackbox-optim ~/arena/noisy-blackbox-swarm
rm -f ~/arena/noisy-blackbox-solo/traces/trace.jsonl ~/arena/noisy-blackbox-swarm/traces/trace.jsonl
git -C ~/arena/noisy-blackbox-swarm init
git -C ~/arena/noisy-blackbox-swarm add -A
git -C ~/arena/noisy-blackbox-swarm commit -m "baseline task package"
```

两份的 `outputs/solver.py` 都保持官方空桩（只把 `x0` 返回）。Run 2 不得读取 `noisy-blackbox-solo/`，也不得读取 `~/.pi/agent/sessions` 里的旧会话。分目录挡不住全局会话，所以会话目录必须指到各自文件夹里。

## 3. 同一个 /goal

`~/.pi/agent/pi-goal.json` 两边共用。缺文件时默认只自动续跑 25 次，这道题会在交卷前停下。开跑前写成：

```json
{
  "continuationLimits": {
    "automaticTurns": null,
    "noProgressTurns": 3
  }
}
```

`automaticTurns: null` 表示不限自动续跑次数。`noProgressTurns` 仍是 3。两边用同一句目标：

```text
/goal 在本目录从空桩写出 outputs/solver.py，通过官方评测后只提交一次。禁止读取另一个 arena 目录和 ~/.pi/agent/sessions 里的旧会话。模型保持 gpugeek/DeepSeek-V4.1-Flash:high。
```

## 4. Run 1 — 只有 pi

```bash
tmux new-session -d -s noisy-solo -c ~/arena/noisy-blackbox-solo -- \
  pi --no-extensions -e npm:@narumitw/pi-goal --approve \
  --session-dir .pi-session \
  --model gpugeek/DeepSeek-V4.1-Flash:high
```

`--no-extensions` 会关掉全局扩展。`-e npm:@narumitw/pi-goal` 只把 goal 模式加回来，pi-swarm 不在这次会话里。进去后输入上面的 `/goal`。会话里不能出现黑板、`task stake`、`spawn`。跑完后只正式提交一次：

```bash
playground submit \
  --challenge-id terminal-bench-science-v0-1-0-noisy-blackbox-optim-8ba810d5 \
  --outputs outputs \
  --trace traces/trace.jsonl \
  --model gpugeek/DeepSeek-V4.1-Flash \
  --harness pi
playground status --attempt-id <id>
playground trace validate --trace traces/trace.jsonl
```

把 `attempt_id` 和 `score` 写进该目录的 `attempt.json`。`status` 的返回里没有 `rank`。

## 5. Run 2 — swarm

Run 1 的 `attempt.json` 写好后再开。pi-swarm 没有装进全局包，用本地路径加载：

```bash
tmux new-session -d -s noisy-swarm -c ~/arena/noisy-blackbox-swarm -- \
  pi --no-extensions --approve \
  -e npm:@narumitw/pi-goal \
  -e /home/dministrator/project/pi-swarm \
  --session-dir .pi-session \
  --model gpugeek/DeepSeek-V4.1-Flash:high
```

先输入与 Run 1 相同的 `/goal`，再执行：

```bash
pi-messenger-swarm run start --goal "在本目录从空桩写出 outputs/solver.py，通过官方评测后只提交一次。禁止读取另一个 arena 目录和 ~/.pi/agent/sessions 里的旧会话。模型保持 gpugeek/DeepSeek-V4.1-Flash:high。"
```

每个 worker 必须带上同一模型。省略 `--model` 时，子进程不会继承父会话的模型，`:high` 也会丢：

```bash
spawn --model gpugeek/DeepSeek-V4.1-Flash:high ...
```

提交、轮询、校验与 Run 1 相同，结果写进 swarm 目录自己的 `attempt.json`。每边只交最终那一次。

## 6. 收敛标准

关闭条件只有一条：swarm 的官方 `score` 高于 solo。高于一点就够，不要求拉开差距，也不要求打过 `0.8000`。

`playground status --attempt-id <id>` 的 `score` 是唯一比较值。套题总榜 `GET /api/benchmarks/15/leaderboard` 有 `rank`，那是 70 题的总榜，不作为这道题的收敛标准。

solo 分不低于 swarm 分，这张 ticket 就不关。不许换模型重跑。

| run   | model                            | attempt_id | score |
| ----- | -------------------------------- | ---------- | ----- |
| solo  | gpugeek/DeepSeek-V4.1-Flash:high |            |       |
| swarm | gpugeek/DeepSeek-V4.1-Flash:high |            |       |

## 7. 依赖

#3（Peer 发现与自省）和 #5（status / explain / abort）已关闭。两次测试都没有未完成的前置 ticket。
