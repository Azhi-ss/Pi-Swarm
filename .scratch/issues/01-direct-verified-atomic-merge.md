# 01 — Direct Verified Atomic Merge Pipeline (Clean Path)

**What to build:** When a worker's task passes the Ground Truth Verifier with exit code 0, the system automatically checks the patch against the host workspace with `git apply --check`, applies the patch, commits directly to `main` with verification metadata (`feat(swarm): verify & merge <taskId> by <workerId> [Exit 0]`), and promotes the task to `verified` on the Blackboard.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent (GitHub #2)

- [ ] Physical patch generated from sandbox diff after exit code 0 verification
- [ ] Pre-check step executes `git apply --check` in the host workspace
- [ ] On clean pre-check, patch is applied to host workspace via `git apply`
- [ ] System automatically executes `git commit` on host `main` with standard message format `feat(swarm): verify & merge <taskId> by <workerId> [Exit 0]` including verification evidence
- [ ] Task is promoted to `verified` in TaskStore, and `BLACKBOARD.md` projects the patch into Zone 3 (Verified Artifacts)
- [ ] Full regression tests in `tests/swarm/direct-verified-merge.test.ts` pass with real git worktrees
