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

function ephemeralLow() {
  try {
    return Number(
      fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]
    );
  } catch {
    return 32768;
  }
}

/**
 * A port for a service the test does not bind itself. Ports below the kernel's
 * ephemeral range cannot be handed out by any listen(0), here or in a concurrent
 * process. Each reserver writes its own pid-named lock and then backs off if any
 * other live pid holds the port: of two racing reservers, the later scan always
 * sees the earlier lock. Dead-pid locks are deleted by whoever finds them.
 */
export async function reservePort(low = 20000, high = ephemeralLow()): Promise<number> {
  const dir = os.tmpdir();
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = low + Math.floor(Math.random() * Math.max(1, high - low));
    const prefix = `pi-swarm-test-port-${port}.`;
    const lock = path.join(dir, `${prefix}${process.pid}.lock`);
    try {
      fs.writeFileSync(lock, '', { flag: 'wx' });
    } catch {
      continue;
    }
    let held = false;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.lock')) continue;
      const pid = Number(name.slice(prefix.length, -'.lock'.length));
      if (pid === process.pid) continue;
      if (pid > 0 && alive(pid)) held = true;
      else
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {}
    }
    const probe = createServer();
    const free =
      !held &&
      (await new Promise<boolean>((resolve) => {
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
      }));
    if (free) {
      locks.push(lock);
      return port;
    }
    fs.rmSync(lock, { force: true });
  }
  throw new Error('No reservable service port');
}
