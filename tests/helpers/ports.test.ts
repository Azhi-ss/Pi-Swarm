import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { reservePort } from './ports.js';

// Below the 20000 default floor, so no other test process reserves these.
const LOW = 19100;
const lockOf = (port: number, owner = '') =>
  path.join(os.tmpdir(), `pi-swarm-test-port-${port}${owner}.lock`);
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid!;

function reserver(low: number, high: number) {
  const helper = new URL('./ports.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { reservePort } = await import(${JSON.stringify(helper)});
       console.log(await reservePort(${low}, ${high}));
       process.stdin.resume();`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  const port = new Promise<number>((resolve, reject) => {
    child.stdout.once('data', (data) => resolve(Number(String(data).trim())));
    child.once('exit', (code) => reject(new Error(`reserver exited ${code}`)));
  });
  return { child, port };
}

it('never hands one port to two concurrent reservers racing over stale locks', async () => {
  const size = 6;
  for (let round = 0; round < 5; round++) {
    for (let port = LOW; port < LOW + size; port++)
      fs.writeFileSync(lockOf(port), String(deadPid()));
    const reservers = Array.from({ length: size }, () => reserver(LOW, LOW + size));
    try {
      const ports = await Promise.all(reservers.map((r) => r.port));
      expect(new Set(ports).size).toBe(size);
    } finally {
      for (const { child } of reservers) child.stdin.end();
      await Promise.all(
        reservers.map(({ child }) =>
          child.exitCode === null ? new Promise((r) => child.once('exit', r)) : null
        )
      );
    }
  }
}, 60_000);

it('survives a lock whose content is gone by the time it is read', async () => {
  // A dangling link exists for an exclusive create but cannot be read.
  const vanished = lockOf(LOW + 12);
  const unlink = () => {
    try {
      fs.unlinkSync(vanished);
    } catch {}
  };
  unlink();
  fs.symlinkSync(path.join(os.tmpdir(), `pi-swarm-missing-${process.pid}`), vanished);
  try {
    expect(await reservePort(LOW + 12, LOW + 13)).toBe(LOW + 12);
  } finally {
    unlink();
  }
});

it('reclaims a dead owner lock and backs off from a live one', async () => {
  const stale = lockOf(LOW + 10, `.${deadPid()}`);
  fs.writeFileSync(stale, '');
  expect(await reservePort(LOW + 10, LOW + 11)).toBe(LOW + 10);
  expect(fs.existsSync(stale)).toBe(false);

  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const held = lockOf(LOW + 11, `.${owner.pid}`);
  fs.writeFileSync(held, '');
  try {
    await expect(reservePort(LOW + 11, LOW + 12)).rejects.toThrow('No reservable service port');
  } finally {
    owner.kill('SIGKILL');
    fs.rmSync(held, { force: true });
  }
});
