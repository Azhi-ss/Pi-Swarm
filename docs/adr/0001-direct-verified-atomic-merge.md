# Direct Verified Atomic Merge to Main

When a peer's task passes the Ground Truth Verifier (Exit Code 0) in its Sandbox and passes `git apply --check`, the system immediately and atomically commits the patch directly onto the host's `main` branch. We deliberately rejected manual sign-off and intermediate staging branches: in an objective test-time compute paradigm (following OpenAI's Noam Brown), passing the machine verifier is the ultimate authority, and direct commits provide a concrete Git SHA baseline that subsequent concurrent peers can cleanly rebase against when resolving merge conflicts.

## Considered Options

- **Manual sign-off / uncommitted working tree**: Leaves the host workspace dirty and prevents other peers from testing or applying their patches concurrently.
- **Shadow integration branch (`swarm/main`)**: Adds branch-management friction without safety benefits, as the host's full test suite is already executed before and after merge.

## Consequences

- The host's `main` branch remains clean and deployable after every merged task.
- Subsequent peers encountering patch conflicts are mechanically bounced back into their Sandboxes to `git rebase main` and re-verify rather than negotiating conflicts in natural language.
