# 03 — Rebase-on-Conflict and Auto-Pruning Protocol

**What to build:** When concurrent workers produce conflicting changes, the host's `git apply --check` catches the collision before applying. Instead of corrupting `main` or debating in chat, the system injects a Steer instruction directing the worker to `git rebase main` and re-verify in its sandbox. If conflicts persist for 3 consecutive attempts, the task is archived to the Graveyard with a `task.dead_end` broadcast.

**Blocked by:** 01 — Direct Verified Atomic Merge Pipeline (Clean Path) (GitHub #2)

**Status:** ready-for-agent (GitHub #4)

- [ ] Collision detection via `git apply --check` intercepts overlapping modifications
- [ ] On collision, merge is rejected; task remains `in_progress` in sandbox
- [ ] Steer instruction injected to worker informing it of main evolution and requesting rebase & re-verify
- [ ] Worker performs `git rebase main` inside its sandbox, resolves conflicts, and re-triggers verification
- [ ] If conflict or verification failure reaches 3 consecutive attempts on the task, system transitions task to `dead_end`, moves it to Graveyard, and broadcasts `task.dead_end` event
- [ ] Integration tests in `tests/swarm/direct-verified-merge.test.ts` pass 100%
