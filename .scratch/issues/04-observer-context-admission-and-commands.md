# 04 — Observer Context Admission and Triple Commands (status, explain, abort)

**What to build:** Gives the human developer and primary Delegator agent a complete non-intrusive observation and control plane: `status` outputs a compact 4-zone ANSI card, `explain` reads `BLACKBOARD.md` to produce an intelligent situation brief without context bloat, and `abort` broadcasts `SIG_ABORT` to trigger Watchdog process-group termination and worktree cleanup.

**Blocked by:**

- 01 — Direct Verified Atomic Merge Pipeline (Clean Path) (GitHub #2)
- 02 — Peer Awareness and Self-Inspection Toolbox (GitHub #3)

**Status:** ready-for-agent (GitHub #5)

- [ ] `pi-messenger-swarm status` outputs a clean, colored ANSI summary card of the 4 blackboard zones (Goal, Soft Staking, Verified, Graveyard) and active worker PIDs
- [ ] `pi-messenger-swarm explain` ingests `<1000 tokens` `BLACKBOARD.md` projection and outputs an objective situation brief (completed milestones, active hypotheses, and disproved dead ends)
- [ ] `pi-messenger-swarm abort` broadcasts `swarm.abort` signal, and triggers Watchdog `killAll()` with negative PID group termination (`SIGKILL`) and safe worktree cleanup
- [ ] Integration tests in `tests/swarm/observer-commands.test.ts` pass 100%
