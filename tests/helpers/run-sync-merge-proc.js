import { applyAndCommitPatchSync } from '../../dist/swarm/verifier/merge.js';
import * as process from 'node:process';

const [, , hostCwd, targetCwd, patchPath, taskId, workerId] = process.argv;

const res = applyAndCommitPatchSync({
  hostCwd,
  targetCwd,
  patchPath,
  taskId,
  workerId,
});

if (!res.ok) {
  process.stderr.write(res.error || 'failed');
  process.exit(1);
} else {
  process.stdout.write(res.commitSha || 'ok');
  process.exit(0);
}
