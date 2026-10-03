# Spec 0002: Solo pi vs Swarm — Bohrium noisy-blackbox

- **Status**: Accepted
- **Driver**: Pi-Swarm Engineering
- **GitHub Issue**: [#6](https://github.com/Azhi-ss/Pi-Swarm/issues/6)
- **Target Competition**: `terminal-bench-science-v0-1-0-noisy-blackbox-optim-8ba810d5`
- **Platform**: [DP Technology Bohrium Playground](https://play.bohrium.com/)

同一赛题、同一模型，跑两次。第一次没有 pi-swarm。第二次才开 swarm。比的是官方分，不是过程叙述。

## 1. 锁死的变量

两次都用这一条：

```bash
pi --model gpugeek/DeepSeek-V4.1-Flash:high
```

界面上就是 `(gpugeek) DeepSeek-V4.1-Flash • high`。provider、模型 id、thinking 档都不许换。

|        | Run 1 Solo                      | Run 2 Swarm                              |
| ------ | ------------------------------- | ---------------------------------------- |
| 运行时 | 只开 `pi`，不加载 pi-swarm      | `pi` + pi-swarm                          |
| 模型   | 上面这一条                      | 委托者与每个 worker 同一条               |
| 工作区 | `~/arena/noisy-blackbox-optim/` | 同一个赛题目录，但是一份新的 `solver.py` |
| 轨迹   | `archive/solo/trace.jsonl`      | `archive/swarm/trace.jsonl`              |

赛题不变：手写 `/app/solver.py` 的 `solver(fun, x0)`，禁止 `scipy.optimize` 以及 `cobyqa`、`cma`、`nevergrad`、`nlopt`、Py-BOBYQA 等现成优化器。官方评估器对 SciPy `Powell`（基线 `0.5000`）做 AUC 归一化。`0.8000` 只是赛题参考强线，不是本 ticket 的通过开关。

## 2. Run 1 — 只有 pi

先跑这个。pi-swarm 不得出现在这次会话里：

```bash
cd ~/arena/noisy-blackbox-optim
# outputs/solver.py 先恢复成空桩（只留 def solver(fun, x0)）
pi --no-extensions --model gpugeek/DeepSeek-V4.1-Flash:high
```

`--no-extensions` 是为了这次不加载 pi-swarm。会话里不能出现黑板、`task stake`、`spawn`。

跑完后：

1. `playground submit`，记下 `attempt_id`
2. `playground status --attempt-id <id>`，记下官方 `score` 和 `rank`
3. 把 `outputs/solver.py`、`traces/trace.jsonl`、attempt 记录归档到 `archive/solo/`
4. `playground trace validate --trace archive/solo/trace.jsonl` 通过

## 3. Run 2 — swarm

Run 1 归档之后再开。`outputs/solver.py` 重新回到空桩，禁止读取 `archive/solo/solver.py`。

```bash
pi --model gpugeek/DeepSeek-V4.1-Flash:high
```

pi-swarm 按现有方式链进这次会话。每个 worker 必须显式带上同一模型：

```bash
spawn --model gpugeek/DeepSeek-V4.1-Flash:high ...
```

不写 `--model` 时，子进程不会继承父会话的模型。`:high` 必须留在模型字符串里。worker 数量与假说内容不锁；模型锁。

提交、轮询、校验与 Run 1 相同，归档到 `archive/swarm/`。

## 4. 完成定义

两次官方结果都落盘即可关闭。假说是：同模型下，swarm 的官方 `score` 高于 solo。假说被证伪也要把数字写上，不能改模型重跑来圆场。

| run   | model                            | attempt_id | score | rank |
| ----- | -------------------------------- | ---------- | ----- | ---- |
| solo  | gpugeek/DeepSeek-V4.1-Flash:high |            |       |      |
| swarm | gpugeek/DeepSeek-V4.1-Flash:high |            |       |      |

## 5. 依赖

#3（Peer 发现与自省）和 #5（status / explain / abort）已关闭。两次测试都没有未完成的前置 ticket。
