import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {
  JobDoneListener,
  JobHooks,
  JobId,
  JobRead,
  JobSnapshot,
  JobStart,
} from '@deepseek-ai/dsh-jobs';
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {
  BetterShellService,
  CommandId,
  CommandOperation,
  CommandSnapshot,
  SessionId,
  SessionSnapshot,
} from '@gao-gao-zai/better-shell-terminal';
import { describe, expect, it, vi } from 'vitest';
import { createToolDefinitions, apply } from './index.js';

const SESSION_ID = 'session-test' as SessionId;
const COMMAND_ID = '001' as CommandId;

function agent(inject = vi.fn()): Agent {
  return { inject } as unknown as Agent;
}

function execution(owner: Agent): ToolRunContext {
  return {
    agent: owner,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

function session(): SessionSnapshot {
  return {
    id: SESSION_ID,
    name: 'main',
    profile: 'cmd',
    status: 'running',
    pid: 123,
    createdAt: 1,
    lastActivityAt: 1,
  };
}

function runningCommand(): CommandSnapshot {
  return {
    id: COMMAND_ID,
    sessionId: SESSION_ID,
    command: 'echo hello',
    status: 'running',
    startedAt: 1,
    output: '',
    truncated: false,
  };
}

function operation(): CommandOperation {
  const snapshot = runningCommand();
  return {
    id: COMMAND_ID,
    done: new Promise<CommandSnapshot>(() => {
      // Kept live so background and detach behavior can be inspected.
    }),
    snapshot: () => snapshot,
    activityAt: () => 1,
    read: (cursor = 0) => ({
      text: cursor === 0 ? 'hello' : '',
      cursor: 5,
      truncated: false,
      generation: 0,
    }),
  };
}

class FakeJobs {
  public readonly starts: JobStart[] = [];
  public hooks: JobHooks | undefined;
  public rejectStart = false;
  public waitSnapshot: JobSnapshot | undefined;
  public doneListener: JobDoneListener | undefined;

  public onJobDone(listener: JobDoneListener): () => void {
    this.doneListener = listener;
    return () => {
      if (this.doneListener === listener) this.doneListener = undefined;
    };
  }

  public complete(snapshot: JobSnapshot, owner: Agent): void {
    void this.doneListener?.(snapshot, owner);
  }

  public start(spec: JobStart): JobId {
    if (this.rejectStart) throw new Error('NO_JOB_CONTROLLER');
    this.starts.push(spec);
    this.hooks = spec.run();
    return 'better-shell-1' as JobId;
  }

  public list(): JobSnapshot[] {
    return this.starts.map((spec, index) => ({
      id: `better-shell-${String(index + 1)}` as JobId,
      kind: spec.kind,
      label: spec.label,
      status: 'running' as const,
      startedAt: 1,
      reported: false,
    }));
  }

  public wait(): Promise<JobSnapshot> {
    return Promise.resolve(this.waitSnapshot ?? this.snapshot());
  }

  public get(): JobSnapshot {
    return this.snapshot();
  }

  public read(): JobRead {
    return { text: this.hooks?.readOutput?.() ?? '', snapshot: this.snapshot() };
  }

  public kill(): 'requested' {
    this.hooks?.cancel('test');
    return 'requested';
  }

  private snapshot(): JobSnapshot {
    return {
      id: 'better-shell-1' as JobId,
      kind: 'better-shell',
      label: 'echo hello',
      status: 'running',
      startedAt: 1,
      reported: false,
    };
  }
}

function fakeShellService(
  execute = vi.fn(() => operation()),
  maxConcurrentJobs = 8,
): BetterShellService {
  return {
    settings: () => ({
      maxRuntimeMs: 24 * 60 * 60 * 1000,
      backgroundTimeoutMs: 10 * 60 * 1000,
      waitTimeoutMs: 30_000,
      readWaitMs: 30_000,
      writeTimeoutMs: 5_000,
      outputBytes: 16 * 1024,
      maxSessions: 32,
      maxCommandHistory: 256,
      maxWriteBytes: 64 * 1024,
      maxConcurrentJobs,
    }),
    startSingle: vi.fn(() => {
      let consumed = false;
      return Promise.resolve({
        profile: 'cmd',
        pid: 123,
        startedAt: 1,
        activityAt: () => 1,
        done: new Promise<{ exitCode: number | null; finishedAt: number }>(() => {
          // Kept live so background behavior can be inspected.
        }),
        readOutput: () => {
          const delta = consumed ? '' : 'hello';
          consumed = true;
          return { delta, truncated: false };
        },
        kill: vi.fn(),
      });
    }),
    create: vi.fn(() => Promise.resolve(session())),
    list: vi.fn(() => [session()]),
    execute,
    write: vi.fn(() => Promise.resolve({ bytesWritten: 1, timerReset: false, session: session() })),
    read: vi.fn((_owner, _session, request) => ({
      text: request.cursor === undefined || request.cursor === 0 ? 'hello' : '',
      cursor: 5,
      truncated: false,
      generation: 0,
      totalBytes: 5,
      command: runningCommand(),
    })),
    waitForChange: vi.fn(() => Promise.resolve()),
    listCommands: vi.fn(() => [runningCommand(), { ...runningCommand(), id: 'C2' as CommandId }]),
    cancelCommand: vi.fn(() => Promise.resolve({ ...runningCommand(), status: 'killed' as const })),
    cancel: vi.fn(() => Promise.resolve(session())),
    close: vi.fn(() => Promise.resolve()),
    closeOwner: vi.fn(() => Promise.resolve()),
    cleanupOwner: vi.fn(() =>
      Promise.resolve({
        sessionsClosed: 0,
        singleProcessesStopped: 0,
        commandsCancelled: 0,
        completedAt: 1,
      }),
    ),
  };
}

interface ApprovalStub {
  readonly config: { readonly policy: 'ask' | 'never' };
  readonly request: (request: { readonly toolName: string }) => Promise<string>;
}

function allowedApproval(): ApprovalStub {
  return {
    config: { policy: 'ask' },
    request: (_request) => {
      void _request;
      return Promise.resolve('allowed-once');
    },
  };
}

interface ShellStub {
  readonly sandboxMode?: string;
}

interface SandboxPolicyStub {
  readonly resolve: (request: { readonly session: Agent['session'] }) => {
    readonly mode: string;
  };
}

function definitions(
  jobs: FakeJobs,
  betterShell: BetterShellService,
  approval: ApprovalStub = allowedApproval(),
  shell: ShellStub = {},
  sandboxPolicy?: SandboxPolicyStub,
): readonly ToolDefinition[] {
  const ctx = {
    jobs,
    betterShell,
    approval,
    shell,
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
  } as unknown as Context;
  return createToolDefinitions(ctx);
}

function tool(items: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = items.find((item) => item.name === name);
  if (found === undefined) throw new Error(`missing tool: ${name}`);
  return found;
}

async function run(
  definition: ToolDefinition,
  args: Record<string, JsonValue>,
  owner: Agent,
): Promise<Record<string, JsonValue>> {
  return (await definition.execute(args, execution(owner))) as Record<string, JsonValue>;
}

async function createSession(items: readonly ToolDefinition[], owner: Agent): Promise<void> {
  await run(
    tool(items, 'shell_session'),
    { operation: 'create', session_name: 'main', shell_profile: 'cmd' },
    owner,
  );
}

describe('better-shell tool definitions', () => {
  it('registers exactly the documented four tools', () => {
    const items = definitions(new FakeJobs(), fakeShellService());
    expect(items.map((item) => item.name)).toEqual([
      'shell_execute',
      'shell_write',
      'shell_read',
      'shell_session',
    ]);
  });

  it('documents the exact shell profiles in tool schemas', () => {
    const items = definitions(new FakeJobs(), fakeShellService());
    const execute = tool(items, 'shell_execute');
    const session = tool(items, 'shell_session');
    expect(execute.parameters['properties']).toMatchObject({
      shell_profile: { enum: ['pwsh7', 'windowsPowerShell', 'cmd'] },
    });
    expect(session.parameters['properties']).toMatchObject({
      shell_profile: { enum: ['pwsh7', 'windowsPowerShell', 'cmd'] },
    });
  });

  it('requests approval through the DSH service for session creation and command execution', async () => {
    const request = vi.fn((_request: { readonly toolName: string }) => {
      void _request;
      return Promise.resolve('allowed-once');
    });
    const items = definitions(new FakeJobs(), fakeShellService(), {
      config: { policy: 'never' },
      request,
    });
    const owner = agent();
    await createSession(items, owner);
    await run(
      tool(items, 'shell_execute'),
      { mode: 'execute', command: 'echo hello', session_name: 'main', run_mode: 'background' },
      owner,
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ toolName: 'shell_session' });
    expect(request.mock.calls[1]?.[0]).toMatchObject({ toolName: 'shell_execute' });
  });
  it('allows shell operations without approval in danger-full-access', async () => {
    const request = vi.fn(() => Promise.resolve('rejected'));
    const items = definitions(
      new FakeJobs(),
      fakeShellService(),
      {
        config: { policy: 'never' },
        request,
      },
      { sandboxMode: 'danger-full-access' },
    );
    const owner = agent();
    await createSession(items, owner);
    const result = await run(
      tool(items, 'shell_execute'),
      { mode: 'execute', command: 'echo hello', session_name: 'main', run_mode: 'background' },
      owner,
    );

    expect(result).toMatchObject({ status: 'background' });
    expect(request).not.toHaveBeenCalled();
  });

  it('starts a PTY command inside the accepted background job', async () => {
    const jobs = new FakeJobs();
    const execute = vi.fn(() => operation());
    const items = definitions(jobs, fakeShellService(execute));
    const owner = agent();
    await createSession(items, owner);

    const result = await run(
      tool(items, 'shell_execute'),
      { mode: 'execute', command: 'echo hello', session_name: 'main', run_mode: 'background' },
      owner,
    );

    expect(jobs.starts[0]?.kind).toBe('better-shell');
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      mode: 'execute',
      status: 'background',
      session_name: 'main',
      command_id: '001',
    });
  });

  it('does not start a PTY command when jobs preflight rejects registration', async () => {
    const jobs = new FakeJobs();
    const execute = vi.fn(() => operation());
    const items = definitions(jobs, fakeShellService(execute));
    const owner = agent();
    await createSession(items, owner);
    jobs.rejectStart = true;

    const rejected = await run(
      tool(items, 'shell_execute'),
      { mode: 'execute', command: 'echo hello', session_name: 'main', run_mode: 'background' },
      owner,
    );
    expect(rejected).toMatchObject({ error: { code: 'COMMAND_START_FAILED' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces and releases the per-Agent concurrent job reservation', async () => {
    const jobs = new FakeJobs();
    const items = definitions(
      jobs,
      fakeShellService(
        vi.fn(() => operation()),
        1,
      ),
    );
    const owner = agent();
    await createSession(items, owner);

    const first = await run(
      tool(items, 'shell_execute'),
      { mode: 'execute', command: 'echo first', session_name: 'main', run_mode: 'background' },
      owner,
    );
    expect(first).toMatchObject({ status: 'background' });

    const rejected = await run(
      tool(items, 'shell_execute'),
      { mode: 'execute', command: 'echo second', session_name: 'main', run_mode: 'background' },
      owner,
    );
    expect(rejected).toMatchObject({ error: { code: 'RESOURCE_LIMIT_EXCEEDED' } });

    const failedJobs = new FakeJobs();
    failedJobs.rejectStart = true;
    const failedItems = definitions(failedJobs, fakeShellService());
    const failedOwner = agent();
    await createSession(failedItems, failedOwner);
    const failed = await run(
      tool(failedItems, 'shell_execute'),
      { mode: 'execute', command: 'echo fail', session_name: 'main', run_mode: 'background' },
      failedOwner,
    );
    expect(failed).toMatchObject({ error: { code: 'COMMAND_START_FAILED' } });
    failedJobs.rejectStart = false;
    const retried = await run(
      tool(failedItems, 'shell_execute'),
      { mode: 'execute', command: 'echo retry', session_name: 'main', run_mode: 'background' },
      failedOwner,
    );
    expect(retried).toMatchObject({ status: 'background' });
  });
  it('detaches a wait-mode PTY command without cancelling it', async () => {
    const jobs = new FakeJobs();
    jobs.waitSnapshot = {
      id: 'better-shell-1' as JobId,
      kind: 'better-shell',
      label: 'echo hello',
      status: 'running',
      startedAt: 1,
      reported: false,
    };
    const service = fakeShellService();
    const items = definitions(jobs, service);
    const owner = agent();
    await createSession(items, owner);

    const result = await run(
      tool(items, 'shell_execute'),
      {
        mode: 'execute',
        command: 'echo hello',
        session_name: 'main',
        run_mode: 'wait',
        wait_timeout_ms: 1,
      },
      owner,
    );

    expect(result).toMatchObject({
      status: 'background',
      wait_expired: true,
      detached_to_background: true,
      command_id: '001',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest inspects the mock; it is not invoked detached.
    expect(vi.mocked(service.cancelCommand).mock.calls).toHaveLength(0);
  });

  it('injects a bounded completion notice for an armed background job', async () => {
    const jobs = new FakeJobs();
    const injected = vi.fn();
    const owner = agent(injected);
    const betterShell = fakeShellService();
    const tools = { register: vi.fn() };
    const ctx = {
      jobs,
      betterShell,
      approval: {
        config: { policy: 'ask' },
        request: vi.fn(() => Promise.resolve('allowed-once')),
      },
      shell: {},
      tools,
      effect: vi.fn(),
    } as unknown as Context;
    apply(ctx);
    const items = createToolDefinitions(ctx);
    await createSession(items, owner);
    await run(
      tool(items, 'shell_execute'),
      { mode: 'execute', command: 'echo hello', session_name: 'main', run_mode: 'background' },
      owner,
    );

    jobs.complete(
      {
        id: 'better-shell-1' as JobId,
        kind: 'better-shell',
        label: 'echo hello',
        status: 'completed',
        detail: 'exit code: 0',
        outputLimitBytes: 16 * 1024,
        startedAt: 1,
        finishedAt: 2,
        reported: false,
      },
      owner,
    );
    await Promise.resolve();
    expect(injected).toHaveBeenCalledOnce();
    const message = injected.mock.calls[0]?.[0] as { content: readonly { text?: string }[] };
    expect(message.content[0]?.text).toContain('shell_background_result');
    expect(message.content[0]?.text).toContain('"output_available":true');
  });
  it('preserves the documented stopping status in background notifications', async () => {
    const jobs = new FakeJobs();
    const injected = vi.fn();
    const owner = agent(injected);
    const ctx = {
      jobs,
      betterShell: fakeShellService(),
      approval: {
        config: { policy: 'ask' },
        request: vi.fn(() => Promise.resolve('allowed-once')),
      },
      shell: {},
      tools: { register: vi.fn() },
      effect: vi.fn(),
    } as unknown as Context;
    apply(ctx);
    const items = createToolDefinitions(ctx);
    await createSession(items, owner);
    await run(
      tool(items, 'shell_execute'),
      { mode: 'execute', command: 'echo hello', session_name: 'main', run_mode: 'background' },
      owner,
    );
    jobs.complete(
      {
        id: 'better-shell-1' as JobId,
        kind: 'better-shell',
        label: 'echo hello',
        status: 'stopping',
        startedAt: 1,
        reported: false,
      },
      owner,
    );
    await Promise.resolve();
    expect(injected.mock.calls[0]?.[0]).toBeDefined();
    const message = injected.mock.calls[0]?.[0] as { content: readonly { text?: string }[] };
    expect(message.content[0]?.text).toContain('"status":"stopping"');
  });
  it('paginates command lists and validates incremental cursors', async () => {
    const items = definitions(new FakeJobs(), fakeShellService());
    const owner = agent();
    await createSession(items, owner);

    const listed = await run(
      tool(items, 'shell_read'),
      { operation: 'list', session_name: 'main', limit: 1 },
      owner,
    );
    expect(listed).toMatchObject({ next_cursor: '1', truncated: true });

    const read = await run(
      tool(items, 'shell_read'),
      {
        operation: 'command',
        session_name: 'main',
        command_id: '001',
        read_mode: 'incremental',
        offset: 0,
      },
      owner,
    );
    expect(read).toMatchObject({ output: 'hello', wait_expired: false });
    expect(read['next_cursor']).toMatch(/^rc_/);

    const rejected = await run(
      tool(items, 'shell_read'),
      {
        operation: 'command',
        session_name: 'main',
        command_id: '001',
        read_mode: 'incremental',
        cursor: 'invalid',
      },
      owner,
    );
    expect(rejected).toMatchObject({ error: { code: 'INVALID_CURSOR' } });
  });
});
