import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { describe, expect, it } from 'vitest';
import { LocalBetterShellService, createDefaultConfig } from './service.js';

function integrationAgent(): Agent {
  const root = new Context();
  return { ctx: root.extend() } as unknown as Agent;
}

describe.skipIf(process.platform !== 'win32')('Windows shell profile integration', () => {
  it.each([
    ['pwsh7', 'Write-Output BETTER_SHELL_PWSH7'],
    ['windowsPowerShell', 'Write-Output BETTER_SHELL_POWERSHELL5'],
    ['cmd', 'echo BETTER_SHELL_CMD'],
  ])('executes %s and preserves its session', async (profile, source) => {
    const service = new LocalBetterShellService(createDefaultConfig());
    const agent = integrationAgent();
    const session = await service.create(agent, { name: profile, profile });
    try {
      const operation = service.execute(agent, session.id, source);
      const command = await Promise.race([
        operation.done,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`${profile} integration timeout`));
          }, 10_000);
        }),
      ]);
      expect(command.status).toBe('completed');
      expect(command.exitCode).toBe(0);
      expect(command.output).toContain('BETTER_SHELL_');
      expect(command.output).not.toContain('__DSH_');
      expect(command.output).not.toContain('FromBase64String');
      expect(service.list(agent)).toHaveLength(1);
    } finally {
      await service.closeOwner(agent);
    }
  });

  it.each([
    ['pwsh7', "Write-Output '中文编码'"],
    ['windowsPowerShell', "Write-Output '中文编码'"],
    ['cmd', 'echo 中文编码'],
  ])('decodes Chinese PTY output for %s', async (profile, source) => {
    const service = new LocalBetterShellService(createDefaultConfig());
    const agent = integrationAgent();
    const session = await service.create(agent, { name: profile, profile });
    try {
      const operation = service.execute(agent, session.id, source);
      const command = await Promise.race([
        operation.done,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`${profile} Chinese integration timeout`));
          }, 10_000);
        }),
      ]);
      expect(command.status).toBe('completed');
      expect(command.exitCode).toBe(0);
      expect(command.output).toContain('中文编码');
      expect(command.output).not.toContain('\uFFFD');
    } finally {
      await service.closeOwner(agent);
    }
  });
});
