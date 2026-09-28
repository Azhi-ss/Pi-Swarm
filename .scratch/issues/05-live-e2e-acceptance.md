# 05 — Live Swarm E2E Benchmark Acceptance Run (6–8 Workers on openai/openai-agents-js-375)

**What to execute:** Run a full-scale dogfooding acceptance test with 6 to 8 concurrent autonomous worker agents backed by real LLM APIs in isolated Git worktrees against the cutting-edge TypeScript benchmark task `openai/openai-agents-js-375` (streaming `agent_end` lifecycle bug). Evaluated exclusively by machine Exit Code 0 with automated direct atomic merge to host `main`.

**Blocked by:**

- 02 — Peer Awareness and Self-Inspection Toolbox (GitHub #3)
- 04 — Observer Context Admission and Triple Commands (GitHub #5)

**Status:** ready-for-agent (GitHub #6)

## Acceptance criteria

- [ ] Target environment established in isolated `~/swarm-target-arena/openai-agents-js` on base commit `6f1677c8` with reproducing test confirming Exit Code 1
- [ ] Swarm plugin linked ephemerally via `pi install /home/dministrator/project/pi-swarm -l` (zero pollution to host global Pi config, zero npm publishing required)
- [ ] 6 to 8 concurrent worker agents spawned with isolated detached worktrees (`.swarm/workspaces/worker-<id>`) and port slot allocation
- [ ] Workers interact via the Four-Zone Blackboard (`BLACKBOARD.md`), soft-staking complementary hypotheses
- [ ] Ground Truth Verifier gate intercepts `task done`, runs objective Vitest suite, and accepts only Exit Code 0
- [ ] Winning patch passes `git apply --check` and automatically commits directly to host `main` with standard `[Exit 0]` message
- [ ] Observer commands (`status`, `explain`, `abort`) tested against live running swarm
- [ ] All worker sandboxes cleanly unlinked and removed, leaving zero temporary branch pollution
