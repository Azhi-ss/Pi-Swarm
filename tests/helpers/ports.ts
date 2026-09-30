import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';

const locks: string[] = [];
process.once('exit', () => {
  for (const lock of locks) fs.rmSync(lock, { force: true });
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A port for a service the test does not bind itself. Ports below the kernel's
 * ephemeral range cannot be handed out by any listen(0), here or in a concurrent
 * process; the lock file reserves one among concurrent test processes.
 */
export async function reservePort(): Promise<number> {
  let ephemeral = 32768;
  try {
    ephemeral = Number(
      fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]
    );
  } catch {}
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20000 + Math.floor(Math.random() * Math.max(1, ephemeral - 20000));
    const lock = path.join(os.tmpdir(), `pi-swarm-test-port-${port}.lock`);
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    } catch {
      // A crashed owner's lock is removed; the port is left for a later pick.
      if (!alive(Number(fs.readFileSync(lock, 'utf8')))) fs.rmSync(lock, { force: true });
      continue;
    }
    locks.push(lock);
    const probe = createServer();
    const free = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No reservable service port');
}
