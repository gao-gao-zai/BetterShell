import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BetterShellSettings } from './config.js';
import { LocalBetterShellService } from './service.js';
import type { PtyFactory, PtyProcess, ShellProfile } from './types.js';

class FakePty implements PtyProcess {
  public readonly pid = 4242;
  public readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  public onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  public onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public resize(): void {
    // No-op fake.
  }

  public kill(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 });
  }

  public emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

function fakeAgent(): Agent {
  const root = new Context();
  const ctx = root.extend();
  return { ctx } as unknown as Agent;
}

const profile: ShellProfile = {
  kind: 'powershell',
  executable: 'pwsh.exe',
  args: ['-NoLogo'],
  allowPty: true,
};

describe('LocalBetterShellService', () => {
  it('keeps a PTY session across commands and supports active raw writes', async () => {
    const pty = new FakePty();
    const factory: PtyFactory = () => pty;
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      factory,
    );
    const agent = fakeAgent();
    const session = await service.create(agent, { name: 'build', profile: 'test' });
    const operation = service.execute(agent, session.id, 'Write-Output hello');
    expect(pty.writes[0]).toContain('FromBase64String');
    await service.write(agent, session.id, { control: 'ENTER' });
    expect(pty.writes[1]).toBe('\r');
    const encodedScript = /FromBase64String\('([^']+)'\)/.exec(pty.writes[0] ?? '')?.[1];
    if (encodedScript === undefined) throw new Error('encoded script missing');
    const script = Buffer.from(encodedScript, 'base64').toString('utf8');
    const startMarker = /(__DSH_START_[a-f0-9]+_)/.exec(script)?.[1];
    const marker = /(__DSH_DONE_[a-f0-9]+_)/.exec(script)?.[1];
    if (startMarker === undefined || marker === undefined) throw new Error('markers missing');
    pty.emit('echoed wrapper\r\n' + startMarker + 'hello\r\n' + marker + '0__');
    await expect(operation.done).resolves.toMatchObject({
      status: 'completed',
      output: 'hello\r\n',
    });
    expect(service.list(agent)).toHaveLength(1);
    await service.closeOwner(agent);
    expect(service.list(agent)).toHaveLength(0);
  });

  it('normalizes newlines in written text to carriage returns', async () => {
    const pty = new FakePty();
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => pty,
    );
    const agent = fakeAgent();
    const session = await service.create(agent, { name: 'nl', profile: 'test' });
    await service.write(agent, session.id, {
      text: 'Write-Output one\nWrite-Output two\r\nWrite-Output three',
    });
    expect(pty.writes[0]).toBe('Write-Output one\rWrite-Output two\rWrite-Output three');
    await service.closeOwner(agent);
  });

  it('strips ANSI escape sequences from command output', async () => {
    const pty = new FakePty();
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => pty,
    );
    const agent = fakeAgent();
    const session = await service.create(agent, { name: 'ansi', profile: 'test' });
    const operation = service.execute(agent, session.id, 'Write-Output hello');
    const encodedScript = /FromBase64String\('([^']+)'\)/.exec(pty.writes[0] ?? '')?.[1];
    if (encodedScript === undefined) throw new Error('encoded script missing');
    const script = Buffer.from(encodedScript, 'base64').toString('utf8');
    const startMarker = /(__DSH_START_[a-f0-9]+_)/.exec(script)?.[1];
    const marker = /(__DSH_DONE_[a-f0-9]+_)/.exec(script)?.[1];
    if (startMarker === undefined || marker === undefined) throw new Error('markers missing');
    pty.emit(
      '\u001b[2J\u001b[1;21H' + startMarker + '\u001b[32;1mhello\u001b[0m\r\n' + marker + '0__',
    );
    await expect(operation.done).resolves.toMatchObject({
      status: 'completed',
      output: 'hello\r\n',
    });
    await service.closeOwner(agent);
  });

  it('force-cancels a command and closes the PTY after confirmation timeout', async () => {
    const pty = new FakePty();
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => pty,
    );
    const agent = fakeAgent();
    const session = await service.create(agent, { name: 'cancel', profile: 'test' });
    const operation = service.execute(agent, session.id, 'Start-Sleep 60');
    const result = await service.cancelCommand(agent, session.id, operation.id, true);
    expect(result.status).toBe('cancelled');
    expect(pty.writes.at(-1)).toBe('\u0003');
    expect(service.list(agent)[0]?.status).toBe('closed');
    await service.closeOwner(agent);
  });

  it('interrupts a command on normal cancel and keeps the session alive', async () => {
    const pty = new FakePty();
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => pty,
    );
    const agent = fakeAgent();
    const session = await service.create(agent, { name: 'soft', profile: 'test' });
    const operation = service.execute(agent, session.id, 'Start-Sleep 60');
    const encodedScript = /FromBase64String\('([^']+)'\)/.exec(pty.writes[0] ?? '')?.[1];
    if (encodedScript === undefined) throw new Error('encoded script missing');
    const script = Buffer.from(encodedScript, 'base64').toString('utf8');
    expect(script).toContain('finally');
    const startMarker = /(__DSH_START_[a-f0-9]+_)/.exec(script)?.[1];
    const marker = /(__DSH_DONE_[a-f0-9]+_)/.exec(script)?.[1];
    if (startMarker === undefined || marker === undefined) throw new Error('markers missing');
    pty.emit(startMarker);

    const cancelPromise = service.cancelCommand(agent, session.id, operation.id, false);
    expect(pty.writes.at(-1)).toBe('\u0003');
    pty.emit(marker + '130__');
    const result = await cancelPromise;
    expect(result.status).toBe('cancelled');
    expect(result.exitCode).toBe(130);
    expect(service.list(agent)[0]?.status).toBe('running');
    await service.closeOwner(agent);
  });

  it('waits for output changes without mutating command state', async () => {
    const pty = new FakePty();
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => pty,
    );
    const agent = fakeAgent();
    const session = await service.create(agent, { name: 'wait', profile: 'test' });
    const operation = service.execute(agent, session.id, 'Write-Output later');
    const changed = service.waitForChange(agent, session.id, operation.id, undefined, 1000);
    pty.emit('later');
    await expect(changed).resolves.toBeUndefined();
    expect(operation.snapshot().status).toBe('running');

    await expect(
      service.waitForChange(agent, session.id, operation.id, undefined, 1),
    ).resolves.toBeUndefined();
    expect(operation.snapshot().status).toBe('running');

    const controller = new AbortController();
    const aborted = service.waitForChange(agent, session.id, operation.id, controller.signal, 1000);
    controller.abort(new Error('cancel read wait'));
    await expect(aborted).rejects.toThrow('cancel read wait');
    await service.closeOwner(agent);
  });
  it('applies live resource limits without rebuilding existing sessions', async () => {
    const pty = new FakePty();
    let settings: BetterShellSettings = {
      ...DEFAULT_SETTINGS,
      maxSessions: 2,
      maxWriteBytes: 4,
    };
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => pty,
      () => settings,
    );
    const agent = fakeAgent();
    const first = await service.create(agent, { name: 'live', profile: 'test' });
    settings = { ...settings, maxSessions: 1 };
    await expect(service.create(agent, { name: 'blocked', profile: 'test' })).rejects.toThrow(
      'RESOURCE_LIMIT_EXCEEDED',
    );
    expect(() => service.write(agent, first.id, { text: 'hello' })).toThrow('WRITE_LIMIT_EXCEEDED');
    expect(service.list(agent)[0]?.id).toBe(first.id);
    await service.closeOwner(agent);
  });
  it('validates single process cwd and environment overlays before spawning', async () => {
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => new FakePty(),
    );
    const owner = fakeAgent();

    await expect(
      service.startSingle(owner, {
        command: 'Write-Output nope',
        profile: 'test',
        cwd: 'relative',
      }),
    ).rejects.toThrow('cwd must be an absolute path');
    await expect(
      service.startSingle(owner, {
        command: 'Write-Output nope',
        profile: 'test',
        env: { 'BAD-KEY': 'value' },
      }),
    ).rejects.toThrow('invalid environment key');
  });
  it('rejects cwd outside configured allowed roots', async () => {
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        allowedCwdRoots: ['C:\\Windows'],
        writeTimeoutMs: 1000,
      },
      () => new FakePty(),
    );
    await expect(
      service.startSingle(fakeAgent(), {
        profile: 'test',
        command: 'Write-Output nope',
        cwd: 'C:\\Users',
      }),
    ).rejects.toThrow('PATH_NOT_ALLOWED');
  });

  it('returns an owner cleanup summary and cancels active commands', async () => {
    const pty = new FakePty();
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => pty,
    );
    const owner = fakeAgent();
    const session = await service.create(owner, { name: 'cleanup', profile: 'test' });
    const command = service.execute(owner, session.id, 'Start-Sleep 60');

    const before = Date.now();
    const summary = await service.cleanupOwner(owner, 'test cleanup');
    const after = Date.now();

    expect(summary.sessionsClosed).toBe(1);
    expect(summary.singleProcessesStopped).toBe(0);
    expect(summary.commandsCancelled).toBe(1);
    expect(summary.completedAt).toBeGreaterThanOrEqual(before);
    expect(summary.completedAt).toBeLessThanOrEqual(after);
    await expect(command.done).resolves.toMatchObject({ status: 'cancelled' });
    expect(service.list(owner)).toHaveLength(0);
  });

  it('rejects a different owner even when the session id is known', async () => {
    const pty = new FakePty();
    const service = new LocalBetterShellService(
      {
        profiles: { test: profile },
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024,
        maxCommandOutputBytes: 1024,
        writeTimeoutMs: 1000,
      },
      () => pty,
    );
    const first = fakeAgent();
    const second = fakeAgent();
    const session = await service.create(first, { name: 'private', profile: 'test' });
    expect(() => service.list(second)).not.toThrow();
    expect(() => service.write(second, session.id, { text: 'nope' })).toThrow('session not found');
    await service.closeOwner(first);
  });
});
