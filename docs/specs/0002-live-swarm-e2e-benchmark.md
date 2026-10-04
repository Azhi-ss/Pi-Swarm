# Spec 0002: PI goal vs AutoResearch vs Swarm — Bohrium abc record

- **Status**: Accepted
- **Driver**: Pi-Swarm Engineering
- **GitHub Issue**: [#6](https://github.com/Azhi-ss/Pi-Swarm/issues/6)
- **Target Competition**: `paper2arm-abc-conjecture-record-b335c57d`
- **Platform**: [科学骑士大师赛 · 第四季](https://play.bohrium.com/hackathon-s4)
- **Challenge**: [尝试打破 abc 猜想的最高质量记录](https://play.bohrium.com/challenge/paper2arm-abc-conjecture-record-b335c57d)

同一赛题、同一模型，跑三组。比较值是官方最终 `displayScore`（`scoreIsFinal: true`）。

噪声黑盒那道题的官方回放没有给出可比的比赛分，所以 ticket 6 改到这道。计分轮已于 2026-08-29 结束。现在的提交会标成 `late_scored`，不进赛季排名，但终局 `displayScore` 仍是这张 ticket 的官方分。

## 1. 锁死的变量

三组都用这一条，界面上就是 `(gpugeek) DeepSeek-V4.1-Flash • high`：

```bash
pi --model gpugeek/DeepSeek-V4.1-Flash:high
```

provider、模型 id、thinking 档都不许换。worker 数量、搜索方法和 AutoResearch 的假说内容不锁。

赛题要交出 `outputs/triple.json` 和 `outputs/run_summary.json`。`triple.json` 给出互素正整数 `a, b, c`（`a + b = c`）以及质因数分解。Harbor 核对分解后计算质量 `q = log(c) / log(rad(abc))`。

| 提交                                   | 分  |
| -------------------------------------- | --- |
| `q` 严格超过 1987 年纪录 `q0 ≈ 1.6299` | 100 |
| `q` 超过 `1.5678872644...`             | 20  |
| `q` 超过 `1.40`                        | 10  |
| 仅满足 `rad(abc) < c`                  | 5   |
| 验算失败                               | 0   |

100 分不是关闭条件。

轨迹门认的是 `thought` / `tool_call` / `tool_result` 步骤，不认 pi 原始 jsonl。pi 原始会话交上去时，Harbor 可以打出档位分，轨迹门系数是 0，公布分变成 0。每组只正式提交一次，交的是**这次自己的** `.pi-session` 转成的步骤。轨迹里必须有写出 `outputs/triple.json` 的那次执行。禁止占位轨迹和手写假轨迹。

## 2. 三个目录

不要从 `~/arena/abc-score-probe/` 复制。那次是手写 5 步轨迹，官方最终分是 0。三组各自一个目录，禁止读取另两个 arena，也禁止读取 `~/.pi/agent/sessions`。

|        | 1. PI goal                     | 2. AutoResearch                                       | 3. Swarm                                              |
| ------ | ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- |
| 目录   | `~/arena/abc-conjecture-solo/` | `~/arena/abc-conjecture-autoresearch/`                | `~/arena/abc-conjecture-swarm/`                       |
| tmux   | `abc-solo`                     | `abc-autoresearch`                                    | `abc-swarm`                                           |
| 运行时 | 只加载 `pi-goal`               | 只加载 `pi-autoresearch`                              | `pi-goal` + 本地 pi-swarm                             |
| Git    | 不建仓库                       | `git init` 并提交基线。去留要有提交可回退             | `git init` 并提交基线。worktree 需要已有提交          |
| 会话   | `--session-dir .pi-session`    | 另一个 `--session-dir .pi-session`，禁止 `--continue` | 另一个 `--session-dir .pi-session`，禁止 `--continue` |

## 3. 组 1 — 纯 goal

`~/.pi/agent/pi-goal.json` 的 `automaticTurns` 为 `null`，`noProgressTurns` 为 3。

```bash
tmux new-session -d -s abc-solo -c ~/arena/abc-conjecture-solo -- \
  pi --no-extensions -e npm:@narumitw/pi-goal --approve \
  --session-dir .pi-session \
  --model gpugeek/DeepSeek-V4.1-Flash:high
```

目标：

```text
/goal 在本目录写出 outputs/triple.json 和 outputs/run_summary.json。不要执行 playground submit。禁止读取其他 arena 目录和 ~/.pi/agent/sessions。模型保持 gpugeek/DeepSeek-V4.1-Flash:high。
```

会话里不能出现黑板、`task stake`、`spawn`。写完后由外部把本次 `.pi-session` 转成 ARM 步骤，只提交一次。

这一组已经交过。attempt **48757**，`displayScore` **20**，`scoreIsFinal: true`。原始会话那次 **48742** 被轨迹门乘成 0，不计入对比。

## 4. 组 2 — AutoResearch

使用 `npm:pi-autoresearch`，只在这次会话加载，不全局安装。循环是一次一个假说：`.auto/measure.sh` 打印 `METRIC q=<number>`，`q` 严格高于当前最好才 keep，否则 discard。无效三元组是 discard。主指标只有这个本地 `q`，不拿官方分当循环内的去留。

`.auto/config.json` 的 `maxIterations` 定为 **16**。插件默认 6 次会自己停掉。

```bash
tmux new-session -d -s abc-autoresearch -c ~/arena/abc-conjecture-autoresearch -- \
  pi --no-extensions -e npm:pi-autoresearch --approve \
  --session-dir .pi-session \
  --model gpugeek/DeepSeek-V4.1-Flash:high
```

循环结束前不 `playground submit`。停在 keep 下来的 `outputs/triple.json` 之后，用这次自己的 `.pi-session` 转成步骤，只提交一次。

## 5. 组 3 — Swarm

pi-swarm 没有装进全局包，用本地路径加载。

```bash
tmux new-session -d -s abc-swarm -c ~/arena/abc-conjecture-swarm -- \
  pi --no-extensions --approve \
  -e npm:@narumitw/pi-goal \
  -e /home/dministrator/project/pi-swarm \
  --session-dir .pi-session \
  --model gpugeek/DeepSeek-V4.1-Flash:high
```

`/goal` 与组 1 同一句，另外每个 worker 必须带上同一模型：

```bash
spawn --model gpugeek/DeepSeek-V4.1-Flash:high ...
```

这一组已经写出 `outputs/triple.json`，还没正式提交。提交仍用这次自己的 `.pi-session` 转成的步骤，只交一次。

## 6. 提交

三组相同：

```bash
playground submit \
  --challenge-id paper2arm-abc-conjecture-record-b335c57d \
  --outputs outputs \
  --trace <本次会话转成的 ARM jsonl> \
  --model gpugeek/DeepSeek-V4.1-Flash:high \
  --harness pi
playground status --attempt-id <id>
```

`attempt_id` 和 `scoreIsFinal: true` 的 `displayScore` 写入该目录的 `attempt.json`。

## 7. 收敛标准

关闭条件只有一条：Swarm 的官方最终分同时高于纯 goal 和 AutoResearch。高于一点就够。不要求打到 100，也不看赛季排名。

有一组不低于 Swarm，这张 ticket 就不关。不许换模型重跑。

| run          | model                            | attempt_id | displayScore |
| ------------ | -------------------------------- | ---------- | ------------ |
| PI goal      | gpugeek/DeepSeek-V4.1-Flash:high | 48757      | 20           |
| AutoResearch | gpugeek/DeepSeek-V4.1-Flash:high |            |              |
| Swarm        | gpugeek/DeepSeek-V4.1-Flash:high |            |              |

## 8. 依赖

#3（Peer 发现与自省）和 #5（status / explain / abort）已关闭。三组都没有未完成的前置 ticket。
