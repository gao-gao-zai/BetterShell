import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { describe, expect, it } from 'vitest';
import { LocalBetterShellService } from './service.js';
import { createDefaultConfig } from './service.js';

function integrationAgent(): Agent {
  const root = new Context();
  return { ctx: root.extend() } as unknown as Agent;
}

describe.skipIf(process.platform !== 'win32')('Windows ConPTY integration', () => {
  it('executes a cmd command and keeps the session alive', async () => {
    const service = new LocalBetterShellService(createDefaultConfig());
    const agent = integrationAgent();
    const session = await service.create(agent, { name: 'cmd-test', profile: 'cmd' });
    try {
      const operation = service.execute(agent, session.id, 'echo BETTER_SHELL_OK');
      const command = await Promise.race([
        operation.done,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`cmd integration timeout: ${JSON.stringify(operation.snapshot())}`));
          }, 10_000);
        }),
      ]);
      expect(command.status).toBe('completed');
      expect(command.exitCode).toBe(0);
      expect(command.output).toContain('BETTER_SHELL_OK');
      expect(command.output).not.toContain('__DSH_');
      expect(service.list(agent)).toHaveLength(1);
    } finally {
      await service.closeOwner(agent);
    }
  });
});
