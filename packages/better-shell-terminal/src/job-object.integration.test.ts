import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('guardian fixture did not publish its process ids');
    await delay(50);
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error(`process ${String(pid)} survived Job Object guardian cleanup`);
}

describe.skipIf(process.platform !== 'win32')('Windows Job Object guardian', () => {
  it('kills a ConPTY process after its DSH host exits abruptly', async () => {
    const stateFile = join(tmpdir(), `better-shell-guardian-${randomUUID()}.json`);
    const fixture = resolve('packages/better-shell-terminal/src/abrupt-exit-host.fixture.ts');
    const host = spawn(process.execPath, ['--import', 'tsx', fixture, stateFile], {
      cwd: resolve('.'),
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      await waitForFile(stateFile, 10_000);
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
        terminalPid: number;
        guardianPid?: number;
      };
      expect(state.terminalPid).toBeGreaterThan(0);
      expect(state.guardianPid).toBeGreaterThan(0);
      await new Promise<void>((resolveExit, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('fixture host did not exit'));
        }, 10_000);
        host.once('exit', () => {
          clearTimeout(timeout);
          resolveExit();
        });
        host.once('error', reject);
      });
      await waitForExit(state.terminalPid, 10_000);
    } finally {
      if (host.exitCode === null) host.kill();
      rmSync(stateFile, { force: true });
    }
  }, 30_000);
});
