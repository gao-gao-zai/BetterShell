import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { LocalBetterShellService } from './service.js';
import { DEFAULT_PROFILES } from './profiles.js';
import type { Agent } from '@deepseek-ai/dsh-agent';

function owner(): Agent {
  const root = new Context();
  return { ctx: root.extend() } as Agent;
}

describe.skipIf(process.platform !== 'win32')('single shell profiles', () => {
  it.each(['pwsh7', 'windowsPowerShell', 'cmd'] as const)(
    'runs a command with %s profile',
    async (profile) => {
      const service = new LocalBetterShellService({
        profiles: DEFAULT_PROFILES,
        defaultProfile: 'pwsh7',
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024 * 1024,
        maxCommandOutputBytes: 1024 * 1024,
        writeTimeoutMs: 1000,
      });
      const process = await service.startSingle(owner(), {
        profile,
        command: profile === 'cmd' ? 'echo single-profile' : 'Write-Output single-profile',
        maxOutputBytes: 1024,
      });
      const result = await process.done;
      const output = process.readOutput();
      const secondRead = process.readOutput();
      expect(result.exitCode).toBe(0);
      expect(output.delta).toContain('single-profile');
      expect(secondRead.delta).toBe('');
    },
  );

  it.each(['pwsh7', 'windowsPowerShell', 'cmd'] as const)(
    'decodes Chinese output for %s profile',
    async (profile) => {
      const service = new LocalBetterShellService({
        profiles: DEFAULT_PROFILES,
        defaultProfile: 'pwsh7',
        defaultRows: 30,
        defaultCols: 120,
        maxOutputBytes: 1024 * 1024,
        maxCommandOutputBytes: 1024 * 1024,
        writeTimeoutMs: 1000,
      });
      const process = await service.startSingle(owner(), {
        profile,
        command: profile === 'cmd' ? 'echo 中文编码' : "Write-Output '中文编码'",
        maxOutputBytes: 1024,
      });
      const result = await process.done;
      const output = process.readOutput();
      expect(result.exitCode).toBe(0);
      expect(output.delta).toContain('中文编码');
      expect(output.delta).not.toContain('\uFFFD');
    },
  );
});
