import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-jobs';
import type { JobId, JobOutcome, JobSnapshot } from '@deepseek-ai/dsh-jobs';
import '@deepseek-ai/dsh-shell';
import '@deepseek-ai/dsh-user-approval';
import {
  defineTool,
  type JsonValue,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import {
  DEFAULT_PROFILES,
  type CommandId,
  type CommandOperation,
  type CommandSnapshot,
  type SessionId,
  type SessionSnapshot,
  type SingleProcess,
  type WriteRequest,
} from '@gao-gao-zai/better-shell-terminal';
import '@gao-gao-zai/better-shell-terminal';

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    betterShell: 'better-shell';
  }
}

interface ReadCursorState {
  readonly sessionId: SessionId;
  readonly commandId: CommandId;
  readonly mode: 'incremental';
  readonly offset: number;
  readonly generation: number;
}

interface OwnerState {
  readonly sessions: Map<string, SessionId>;
  readonly cursors: Map<string, ReadCursorState>;
  nextCursorNumber: number;
}

const PROFILE_NAMES = Object.keys(DEFAULT_PROFILES).join(', ');
const PROFILE_DESCRIPTION =
  `Available profiles: ${PROFILE_NAMES}. Use the exact profile name; ` +
  '`pwsh7` is PowerShell 7, `windowsPowerShell` is Windows PowerShell 5.1, and `cmd` is cmd.exe.';

const states = new WeakMap<Agent, OwnerState>();
const stateCleanupInstalled = new WeakSet<Agent>();
interface BackgroundMeta {
  readonly taskId?: string;
  readonly sessionName?: string;
  readonly commandId?: string;
  readonly commandPreview: string;
}
const backgroundJobs = new WeakMap<Agent, Map<JobId, BackgroundMeta>>();
interface ShellReservation {
  id?: JobId;
  released: boolean;
}
interface ShellAdmissionState {
  readonly reservations: Set<ShellReservation>;
}
const shellAdmissions = new WeakMap<Agent, ShellAdmissionState>();

function admissionFor(agent: Agent): ShellAdmissionState {
  let state = shellAdmissions.get(agent);
  if (state === undefined) {
    state = { reservations: new Set() };
    shellAdmissions.set(agent, state);
  }
  return state;
}

function reserveShellJob(agent: Agent, activeJobs: number, limit: number): ShellReservation {
  const state = admissionFor(agent);
  const pendingReservations = [...state.reservations].filter(
    (reservation) => reservation.id === undefined,
  ).length;
  if (activeJobs + pendingReservations >= limit)
    throw new Error('RESOURCE_LIMIT_EXCEEDED: background jobs');
  const reservation: ShellReservation = { released: false };
  state.reservations.add(reservation);
  return reservation;
}

function trackShellJob(reservation: ShellReservation, id: JobId): void {
  reservation.id = id;
}

function releaseShellReservation(agent: Agent, reservation: ShellReservation): void {
  if (reservation.released) return;
  reservation.released = true;
  shellAdmissions.get(agent)?.reservations.delete(reservation);
}

function releaseShellJob(agent: Agent, id: JobId): void {
  const state = shellAdmissions.get(agent);
  if (state === undefined) return;
  const reservation = [...state.reservations].find(
    (entry) => entry.id === id || entry.id === undefined,
  );
  if (reservation !== undefined) releaseShellReservation(agent, reservation);
}

function armBackgroundJob(agent: Agent, id: JobId, meta: BackgroundMeta): void {
  let jobs = backgroundJobs.get(agent);
  if (jobs === undefined) {
    jobs = new Map();
    backgroundJobs.set(agent, jobs);
  }
  jobs.set(id, meta);
}

function requireOwner(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('shell tools require an agent owner');
  return exec.agent;
}

function stateFor(agent: Agent): OwnerState {
  let state = states.get(agent);
  if (state === undefined) {
    state = { sessions: new Map(), cursors: new Map(), nextCursorNumber: 1 };
    states.set(agent, state);
  }
  if (!stateCleanupInstalled.has(agent)) {
    const ownerContext = (
      agent as unknown as {
        readonly ctx?: {
          effect?: (factory: () => () => void, name?: string) => unknown;
        };
      }
    ).ctx;
    if (ownerContext?.effect !== undefined) {
      stateCleanupInstalled.add(agent);
      const ownerState = state;
      ownerContext.effect(
        () => () => {
          ownerState.sessions.clear();
          ownerState.cursors.clear();
          backgroundJobs.delete(agent);
          shellAdmissions.delete(agent);
        },
        'better-shell tools owner cleanup',
      );
    }
  }
  return state;
}

function sessionId(agent: Agent, name: string): SessionId {
  const value = stateFor(agent).sessions.get(name);
  if (value === undefined) throw new Error(`SESSION_NOT_FOUND: ${name}`);
  return value;
}

function publicSessionStatus(value: SessionSnapshot): 'idle' | 'busy' | 'exited' | 'closed' {
  return value.status === 'running'
    ? value.activeCommandId === undefined
      ? 'idle'
      : 'busy'
    : value.status;
}

function sessionJson(value: SessionSnapshot): JsonValue {
  const status = publicSessionStatus(value);
  return {
    id: value.id,
    name: value.name,
    profile: value.profile,
    status,
    pid: value.pid,
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.activeCommandId === undefined ? {} : { activeCommandId: value.activeCommandId }),
  };
}

function commandJson(value: CommandSnapshot): JsonValue {
  const outputBytes = Buffer.byteLength(value.output, 'utf8');
  return {
    id: value.id,
    sessionId: value.sessionId,
    command: value.command,
    status: value.status,
    startedAt: value.startedAt,
    output: value.output,
    output_bytes: outputBytes,
    output_available: outputBytes > 0,
    more: value.truncated,
    truncated: value.truncated,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
  };
}

function jobJson(value: JobSnapshot): JsonValue {
  return {
    id: value.id,
    kind: value.kind,
    label: value.label,
    status: publicJobStatus(value),
    startedAt: value.startedAt,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}

interface ShellErrorDescriptor {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

const ERROR_MESSAGES: Readonly<Record<string, Omit<ShellErrorDescriptor, 'code'>>> = {
  SHELL_NOT_ALLOWED: { message: 'The requested shell profile is not allowed.', retryable: false },
  SESSION_NAME_REQUIRED: { message: 'A terminal session name is required.', retryable: true },
  SHELL_PROFILE_REQUIRED: {
    message: 'A shell profile is required when creating a terminal session.',
    retryable: true,
  },
  SESSION_NAME_DUPLICATE: {
    message: 'A terminal session with this name already exists.',
    retryable: true,
  },
  SESSION_NOT_FOUND: {
    message: 'The terminal session does not exist for this Agent.',
    retryable: true,
  },
  SESSION_BUSY: { message: 'The terminal session is already running a command.', retryable: true },
  SESSION_CLOSED: { message: 'The terminal session is no longer running.', retryable: true },
  SESSION_START_FAILED: { message: 'The terminal session could not be started.', retryable: true },
  COMMAND_START_FAILED: { message: 'The shell command could not be started.', retryable: true },
  COMMAND_TIMEOUT: {
    message: 'The shell command exceeded its runtime or activity limit.',
    retryable: true,
  },
  COMMAND_CANCELLED: { message: 'The shell command was cancelled.', retryable: true },
  TASK_CANCELLED: { message: 'The background shell task was cancelled.', retryable: true },
  COMMAND_WAIT_DETACHED: {
    message: 'The command continues in the background after the wait expired.',
    retryable: true,
  },
  READ_WAIT_LIMIT_EXCEEDED: {
    message: 'The requested read wait exceeds the active limit.',
    retryable: true,
  },
  WRITE_TIMEOUT: { message: 'The PTY write timed out.', retryable: true },
  WRITE_LIMIT_EXCEEDED: { message: 'The PTY write is too large.', retryable: true },
  APPROVAL_REQUIRED: {
    message: 'User approval is required before executing this command.',
    retryable: true,
  },
  APPROVAL_REJECTED: {
    message: 'User approval was not granted for this command.',
    retryable: true,
  },
  COMMAND_NOT_FOUND: {
    message: 'The shell command does not exist for this session.',
    retryable: true,
  },
  INVALID_COMMAND_ID: { message: 'The command ID is invalid.', retryable: true },
  INVALID_CURSOR: {
    message: 'The cursor is invalid for this Agent, session, or command.',
    retryable: true,
  },
  TASK_NOT_FOUND: {
    message: 'The background shell task does not exist for this Agent.',
    retryable: true,
  },
  TIMEOUT_LIMIT_EXCEEDED: {
    message: 'The requested timeout exceeds the active limit.',
    retryable: true,
  },
  OUTPUT_LIMIT_EXCEEDED: {
    message: 'The requested output size exceeds the active limit.',
    retryable: true,
  },
  SHELL_ARGUMENTS_NOT_ALLOWED: {
    message: 'The supplied arguments are not allowed for this Shell operation.',
    retryable: true,
  },
  PERMISSION_DENIED: { message: 'The Shell operation is not permitted.', retryable: false },
  PATH_NOT_ALLOWED: {
    message: 'The requested working directory is not allowed.',
    retryable: false,
  },
  ENVIRONMENT_INVALID: { message: 'The environment overlay is invalid.', retryable: true },
  CWD_INVALID: {
    message: 'The working directory must be an absolute valid path.',
    retryable: true,
  },
  RESOURCE_LIMIT_EXCEEDED: {
    message: 'The shell resource limit has been reached.',
    retryable: true,
  },
  CONFIG_INVALID: {
    message: 'The shell tool arguments or active configuration are invalid.',
    retryable: true,
  },
};

function shellError(error: unknown): ShellErrorDescriptor {
  const source = error instanceof Error ? error.message : String(error);
  const direct = Object.keys(ERROR_MESSAGES).find((code) => source.includes(code));
  let code = direct;
  if (code === undefined) {
    if (/unknown shell profile|single execution is disabled|PTY is disabled/i.test(source)) {
      code = 'SHELL_NOT_ALLOWED';
    } else if (/session name already exists/i.test(source)) {
      code = 'SESSION_NAME_DUPLICATE';
    } else if (/session not found|not owned/i.test(source)) {
      code = 'SESSION_NOT_FOUND';
    } else if (/session is busy/i.test(source)) {
      code = 'SESSION_BUSY';
    } else if (/session is not running|session is closed/i.test(source)) {
      code = 'SESSION_CLOSED';
    } else if (/command not found/i.test(source)) {
      code = 'COMMAND_NOT_FOUND';
    } else if (/cwd must be an absolute|working directory/i.test(source)) {
      code = 'CWD_INVALID';
    } else if (/environment|NUL|environment overlay/i.test(source)) {
      code = 'ENVIRONMENT_INVALID';
    } else if (/not allowed|permission|approval/i.test(source)) {
      code = 'PERMISSION_DENIED';
    } else if (/argument|required|exclusive|must be/i.test(source)) {
      code = 'SHELL_ARGUMENTS_NOT_ALLOWED';
    } else {
      code = 'COMMAND_START_FAILED';
    }
  }
  const descriptor = ERROR_MESSAGES[code] ?? ERROR_MESSAGES['COMMAND_START_FAILED'];
  if (descriptor === undefined) {
    return {
      code: 'COMMAND_START_FAILED',
      message: 'The shell operation failed.',
      retryable: true,
    };
  }
  return { code, ...descriptor };
}

function withStructuredErrors(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    async execute(args, exec): Promise<JsonValue> {
      try {
        return (await definition.execute(args, exec)) as JsonValue;
      } catch (error) {
        const descriptor = shellError(error);
        return {
          error: {
            code: descriptor.code,
            message: descriptor.message,
            retryable: descriptor.retryable,
          },
        };
      }
    },
  };
}

function outputText(value: JsonValue): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

const output = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => outputText(value),
};

function outcomeFromShell(status: 'completed' | 'killed' | 'failed', detail: string): JobOutcome {
  return { status, detail };
}

function cancelTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

function startDeadline(
  cancel: () => void,
  maxRuntimeMs: number,
): ReturnType<typeof setTimeout> | undefined {
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs <= 0) return undefined;
  return setTimeout(cancel, maxRuntimeMs);
}

function startActivityGuard(
  cancel: () => void,
  lastActivity: () => number,
  timeoutMs: number,
): ReturnType<typeof setInterval> | undefined {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return undefined;
  const interval = Math.max(25, Math.min(1000, Math.floor(timeoutMs / 4)));
  return setInterval(() => {
    if (Date.now() - lastActivity() >= timeoutMs) cancel();
  }, interval);
}

function clearActivity(timer: ReturnType<typeof setInterval> | undefined): void {
  if (timer !== undefined) clearInterval(timer);
}

function limitText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  let selectedLength = Math.min(Math.max(0, maxBytes), bytes.length);
  while (selectedLength > 0) {
    const decoded = bytes.subarray(0, selectedLength).toString('utf8');
    if (Buffer.byteLength(decoded, 'utf8') === selectedLength) break;
    selectedLength -= 1;
  }
  const selected = bytes.subarray(0, selectedLength).toString('utf8');
  return { text: selected, truncated: selectedLength < bytes.length };
}

function truncateJsonStrings(value: JsonValue, maxBytes: number): JsonValue {
  if (typeof value === 'string') return limitText(value, maxBytes).text;
  if (Array.isArray(value)) return value.map((entry) => truncateJsonStrings(entry, maxBytes));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value))
      result[key] = truncateJsonStrings(entry, maxBytes);
    return result;
  }
  return value;
}

function boundedItems(
  items: readonly JsonValue[],
  maxBytes: number,
): { items: JsonValue[]; truncated: boolean } {
  const result: JsonValue[] = [];
  for (const item of items) {
    const candidate = truncateJsonStrings(item, maxBytes);
    const size = Buffer.byteLength(JSON.stringify([...result, candidate]), 'utf8');
    if (result.length > 0 && size > maxBytes) return { items: result, truncated: true };
    result.push(candidate);
  }
  return { items: result, truncated: result.length < items.length };
}

function publicJobStatus(
  snapshot: JobSnapshot,
): 'running' | 'stopping' | 'completed' | 'failed' | 'timeout' | 'cancelled' {
  if (snapshot.detail === 'COMMAND_TIMEOUT') return 'timeout';
  if (
    snapshot.status === 'killed' ||
    snapshot.detail === 'COMMAND_CANCELLED' ||
    snapshot.detail === 'TASK_CANCELLED'
  )
    return 'cancelled';
  return snapshot.status;
}

function extractExitCode(detail: string | undefined): number | null {
  const match = detail?.match(/^exit code: (-?\d+)$/);
  return match === undefined || match === null ? null : Number.parseInt(match[1] ?? '0', 10);
}

function jobResult(
  ctx: Context,
  id: JobId,
  agent: Agent,
  maxBytes: number,
): Record<string, JsonValue> {
  const snapshot = ctx.jobs.get(id, agent);
  const read = ctx.jobs.read(id, agent);
  const limited = limitText(read.text, maxBytes);
  const status = publicJobStatus(snapshot);
  const exitCode = extractExitCode(snapshot.detail);
  const durationMs =
    snapshot.finishedAt === undefined
      ? null
      : Math.max(0, snapshot.finishedAt - snapshot.startedAt);
  return {
    job: jobJson(snapshot),
    status,
    exit_code: exitCode,
    duration_ms: durationMs,
    output: limited.text,
    returned_bytes: Buffer.byteLength(limited.text, 'utf8'),
    output_available: limited.text.length > 0,
    more: limited.truncated,
    truncated: limited.truncated,
  };
}

function stringEnvironment(value: Record<string, JsonValue>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`environment value must be a string: ${key}`);
    result[key] = entry;
  }
  return result;
}

function parseReadCursor(
  agent: Agent,
  session: SessionId,
  command: CommandId,
  cursor: string | undefined,
  offset: number | undefined,
): { readonly offset: number | undefined; readonly generation: number | undefined } {
  if (cursor !== undefined && offset !== undefined) throw new Error('INVALID_CURSOR');
  if (cursor === undefined) return { offset, generation: undefined };
  const value = stateFor(agent).cursors.get(cursor);
  if (value === undefined) throw new Error('INVALID_CURSOR');
  if (value.sessionId !== session || value.commandId !== command) {
    throw new Error('INVALID_CURSOR');
  }
  return { offset: value.offset, generation: value.generation };
}

function createReadCursor(
  agent: Agent,
  session: SessionId,
  command: CommandId,
  offset: number,
  generation: number,
): string {
  const state = stateFor(agent);
  const cursor = `rc_${state.nextCursorNumber.toString(36)}_${randomUUID()}`;
  state.nextCursorNumber += 1;
  state.cursors.set(cursor, {
    sessionId: session,
    commandId: command,
    mode: 'incremental',
    offset,
    generation,
  });
  return cursor;
}

function parseListCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error('INVALID_CURSOR');
  const value = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_CURSOR');
  return value;
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
  allowZero = false,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (allowZero ? result < 0 : result <= 0) || result > maximum) {
    throw new Error(`${label} exceeds configured limit ${String(maximum)}`);
  }
  return result;
}

function registerSingleJob(
  ctx: Context,
  agent: Agent,
  command: string,
  profile: string | undefined,
  maxRuntimeMs: number,
  backgroundTimeoutMs: number,
  maxOutputBytes: number,
): JobId {
  return ctx.jobs.start({
    kind: 'better-shell',
    label: command,
    owner: agent,
    outputLimitBytes: maxOutputBytes,
    run: () => {
      let singleProcess: SingleProcess | undefined;
      let timedOut = false;
      let cancelled = false;
      const stop = () => {
        cancelled = true;
        singleProcess?.kill();
      };
      const timeout = () => {
        timedOut = true;
        stop();
      };
      const deadline = startDeadline(timeout, maxRuntimeMs);
      const activity = startActivityGuard(
        timeout,
        () => singleProcess?.activityAt() ?? Date.now(),
        backgroundTimeoutMs,
      );
      const done = ctx.betterShell
        .startSingle(agent, {
          command,
          ...(profile === undefined ? {} : { profile }),
        })
        .then((process) => {
          singleProcess = process;
          if (cancelled) process.kill();
          return process.done;
        })
        .then((result) => {
          cancelTimer(deadline);
          clearActivity(activity);
          const outcomeStatus =
            timedOut || result.exitCode === null
              ? 'killed'
              : result.exitCode === 0
                ? 'completed'
                : 'failed';
          return outcomeFromShell(
            outcomeStatus,
            timedOut
              ? 'COMMAND_TIMEOUT'
              : cancelled
                ? 'COMMAND_CANCELLED'
                : `exit code: ${result.exitCode === null ? 'unknown' : String(result.exitCode)}`,
          );
        })
        .catch((error: unknown) => {
          cancelTimer(deadline);
          clearActivity(activity);
          if (timedOut) return outcomeFromShell('killed', 'COMMAND_TIMEOUT');
          if (cancelled) return outcomeFromShell('killed', 'COMMAND_CANCELLED');
          return outcomeFromShell(
            'failed',
            error instanceof Error ? error.message : 'single startup failed',
          );
        });
      return {
        cancel: stop,
        done,
        readOutput: () => singleProcess?.readOutput().delta ?? '',
      };
    },
  });
}

interface RegisteredPtyJob {
  readonly id: JobId;
  readonly operation: CommandOperation;
}

function registerPtyJob(
  ctx: Context,
  agent: Agent,
  session: SessionId,
  commandText: string,
  maxRuntimeMs: number,
  backgroundTimeoutMs: number,
  maxOutputBytes: number,
): RegisteredPtyJob {
  let operation: CommandOperation | undefined;
  const id = ctx.jobs.start({
    kind: 'better-shell',
    label: commandText,
    owner: agent,
    outputLimitBytes: maxOutputBytes,
    run: () => {
      const commandOperation = ctx.betterShell.execute(agent, session, commandText);
      operation = commandOperation;
      let cursor: number | undefined;
      let timedOut = false;
      const stop = () => {
        void ctx.betterShell.cancelCommand(agent, session, commandOperation.id, true);
      };
      const timeout = () => {
        timedOut = true;
        stop();
      };
      const deadline = startDeadline(timeout, maxRuntimeMs);
      const activity = startActivityGuard(
        timeout,
        () => commandOperation.activityAt(),
        backgroundTimeoutMs,
      );
      const done = commandOperation.done.then((command) => {
        cancelTimer(deadline);
        clearActivity(activity);
        return outcomeFromShell(
          timedOut || command.status === 'killed' || command.status === 'cancelled'
            ? 'killed'
            : command.status === 'completed'
              ? 'completed'
              : 'failed',
          timedOut
            ? 'COMMAND_TIMEOUT'
            : command.status === 'cancelled'
              ? 'COMMAND_CANCELLED'
              : `exit code: ${command.exitCode === undefined ? 'unknown' : String(command.exitCode)}`,
        );
      });
      return {
        cancel: stop,
        done,
        readOutput: () => {
          const next = commandOperation.read(cursor);
          cursor = next.cursor;
          return next.text;
        },
      };
    },
  });
  if (operation === undefined)
    throw new Error('better-shell job starter did not create an operation');
  return { id, operation };
}

function allowsUnpromptedShell(ctx: Context, agent: Agent): boolean {
  const context = ctx as unknown as {
    readonly sandboxPolicy?: {
      resolve(request: { readonly session: Agent['session'] }): { readonly mode?: string };
    };
    readonly shell?: { readonly sandboxMode?: string };
  };
  const resolved = context.sandboxPolicy?.resolve({ session: agent.session });
  return (
    resolved?.mode === 'danger-full-access' ||
    (resolved === undefined && context.shell?.sandboxMode === 'danger-full-access')
  );
}

async function authorizeCommand(
  ctx: Context,
  agent: Agent,
  command: string,
  signal: AbortSignal,
  toolName = 'shell_execute',
  callId?: ToolRunContext['callId'],
): Promise<void> {
  if (allowsUnpromptedShell(ctx, agent)) return;
  const approval = ctx.approval;
  const request = {
    agent,
    toolName,
    reason: `${toolName}: ${command.slice(0, 200)}`,
    signal,
  };
  const outcome =
    callId === undefined
      ? await approval.request(request)
      : await approval.request({ ...request, callId });
  if (outcome !== 'allowed-once') throw new Error('APPROVAL_REJECTED');
}

export function createToolDefinitions(ctx: Context): readonly ToolDefinition[] {
  const active = ctx.betterShell.settings();
  const limits = `Active limits: foreground wait ${String(active.waitTimeoutMs)}ms; background inactivity ${String(active.backgroundTimeoutMs)}ms; absolute runtime ${String(active.maxRuntimeMs)}ms; read wait ${String(active.readWaitMs)}ms; write timeout ${String(active.writeTimeoutMs)}ms; response output ${String(active.outputBytes)} bytes; write input ${String(active.maxWriteBytes)} bytes; ${String(active.maxSessions)} PTY sessions per Agent; ${String(active.maxCommandHistory)} retained commands per session; ${String(active.maxConcurrentJobs)} concurrent Shell jobs per Agent.`;
  const shellExecute = defineTool({
    name: 'shell_execute',
    description: `Execute a Shell command in single or persistent PTY mode. In both modes, run_mode may be wait or background; wait_timeout_ms applies to foreground waiting and detaches without cancelling when it expires. In single mode, omit session_name and optionally select shell_profile; in execute mode, pass session_name and omit shell_profile. ${PROFILE_DESCRIPTION} ${limits}`,
    parameters: {
      mode: {
        type: 'string',
        enum: ['single', 'execute'],
        default: 'single',
        description: 'single starts one process; execute uses an existing PTY session.',
      },
      command: { type: 'string', required: true, description: 'Non-empty shell command text.' },
      shell_profile: {
        type: 'string',
        enum: Object.keys(DEFAULT_PROFILES),
        description: PROFILE_DESCRIPTION + ' Single mode only.',
      },
      session_name: { type: 'string', description: 'Owner-scoped PTY session name.' },
      run_mode: {
        type: 'string',
        enum: ['wait', 'background'],
        default: 'wait',
        description: 'wait until completion or detach; background returns immediately.',
      },
      wait_timeout_ms: {
        type: 'integer',
        description: `Foreground wait in milliseconds, 0-${String(active.waitTimeoutMs)}; expiry detaches without cancelling.`,
      },
      background_timeout_ms: {
        type: 'integer',
        description: `Background inactivity timeout in milliseconds, 1-${String(active.backgroundTimeoutMs)}.`,
      },
      max_runtime_ms: {
        type: 'integer',
        description: `Absolute runtime in milliseconds, 1-${String(active.maxRuntimeMs)}.`,
      },
      max_output_bytes: {
        type: 'integer',
        description: `Maximum returned UTF-8 bytes, 0-${String(active.outputBytes)}.`,
      },
    },
    output,
    async execute(args, exec): Promise<JsonValue> {
      const agent = requireOwner(exec);
      const mode = args.mode ?? 'single';
      const runMode = args.run_mode ?? 'wait';
      if (mode === 'single' && args.session_name !== undefined)
        throw new Error('SESSION_ARGUMENT_INVALID');
      if (
        mode === 'execute' &&
        (args.session_name === undefined || args.shell_profile !== undefined)
      )
        throw new Error('SESSION_ARGUMENT_INVALID');
      const settings = ctx.betterShell.settings();
      await authorizeCommand(ctx, agent, args.command, exec.signal, 'shell_execute', exec.callId);
      const maxRuntime = boundedLimit(
        args.max_runtime_ms,
        settings.maxRuntimeMs,
        settings.maxRuntimeMs,
        'TIMEOUT_LIMIT_EXCEEDED: max_runtime_ms',
      );
      const backgroundTimeout = boundedLimit(
        args.background_timeout_ms,
        settings.backgroundTimeoutMs,
        settings.backgroundTimeoutMs,
        'TIMEOUT_LIMIT_EXCEEDED: background_timeout_ms',
      );
      const maxOutput = boundedLimit(
        args.max_output_bytes,
        settings.outputBytes,
        settings.outputBytes,
        'OUTPUT_LIMIT_EXCEEDED: max_output_bytes',
        true,
      );
      const activeShellJobs = ctx.jobs
        .list(agent)
        .filter(
          (job) =>
            job.kind === 'better-shell' && (job.status === 'running' || job.status === 'stopping'),
        ).length;
      const reservation = reserveShellJob(agent, activeShellJobs, settings.maxConcurrentJobs);
      let jobId: JobId;
      let session: SessionId | undefined;
      let sessionName: string | undefined;
      let commandId: CommandId | undefined;
      const arm = (): void => {
        armBackgroundJob(agent, jobId, {
          ...(mode === 'single' ? { taskId: String(jobId) } : {}),
          ...(sessionName === undefined ? {} : { sessionName }),
          ...(commandId === undefined ? {} : { commandId: String(commandId) }),
          commandPreview: args.command,
        });
      };
      try {
        if (mode === 'single') {
          jobId = registerSingleJob(
            ctx,
            agent,
            args.command,
            args.shell_profile,
            maxRuntime,
            backgroundTimeout,
            maxOutput,
          );
        } else {
          const requestedSession = args.session_name;
          if (requestedSession === undefined) throw new Error('SESSION_NAME_REQUIRED');
          sessionName = requestedSession;
          session = sessionId(agent, requestedSession);
          const registered = registerPtyJob(
            ctx,
            agent,
            session,
            args.command,
            maxRuntime,
            backgroundTimeout,
            maxOutput,
          );
          commandId = registered.operation.id;
          jobId = registered.id;
        }
        trackShellJob(reservation, jobId);
      } catch (error) {
        releaseShellReservation(agent, reservation);
        throw error;
      }
      if (runMode === 'background') {
        arm();
        return {
          mode,
          status: 'background',
          ...(mode === 'single' ? { task_id: String(jobId) } : {}),
          ...(session === undefined || sessionName === undefined || commandId === undefined
            ? {}
            : { session_name: sessionName, command_id: String(commandId) }),
          wait_expired: false,
          detached_to_background: false,
        };
      }
      const waitMs = boundedLimit(
        args.wait_timeout_ms,
        settings.waitTimeoutMs,
        settings.waitTimeoutMs,
        'TIMEOUT_LIMIT_EXCEEDED: wait_timeout_ms',
        true,
      );
      const snapshot =
        waitMs === 0
          ? ctx.jobs.get(jobId, agent)
          : await ctx.jobs.wait(jobId, waitMs, agent, exec.signal);
      if (snapshot.status === 'running' || snapshot.status === 'stopping') {
        arm();
        return {
          mode,
          status: 'background',
          ...(mode === 'single' ? { task_id: String(jobId) } : {}),
          ...(session === undefined || sessionName === undefined || commandId === undefined
            ? {}
            : { session_name: sessionName, command_id: String(commandId) }),
          wait_expired: true,
          detached_to_background: true,
          message: '等待时间已到，命令未被终止，现已转为后台运行。',
        };
      }
      return {
        mode,
        status: publicJobStatus(snapshot),
        ...(mode === 'single' ? { task_id: null } : {}),
        ...(session === undefined || sessionName === undefined || commandId === undefined
          ? {}
          : { session_name: sessionName, command_id: String(commandId) }),
        wait_expired: false,
        timed_out: snapshot.detail === 'COMMAND_TIMEOUT',
        ...jobResult(ctx, jobId, agent, maxOutput),
      };
    },
  });

  const shellWrite = defineTool({
    name: 'shell_write',
    description: `Write raw text or structured control input to a persistent PTY session. Pass exactly one of text or control; control is one of CTRL_C, CTRL_D, ESC, ENTER, TAB, or BACKSPACE. ${limits}`,
    parameters: {
      session_name: { type: 'string', required: true },
      text: { type: 'string' },
      control: { type: 'string', enum: ['CTRL_C', 'CTRL_D', 'ESC', 'ENTER', 'TAB', 'BACKSPACE'] },
      write_timeout_ms: {
        type: 'integer',
        description: `Write timeout in milliseconds, 1-${String(active.writeTimeoutMs)}.`,
      },
      include_output: {
        type: 'boolean',
        default: true,
        description: 'Include bounded recent session output.',
      },
      max_output_bytes: {
        type: 'integer',
        description: `Maximum returned UTF-8 bytes, 0-${String(active.outputBytes)}.`,
      },
    },
    output,
    async execute(args, exec): Promise<JsonValue> {
      const agent = requireOwner(exec);
      const id = sessionId(agent, args.session_name);
      if ((args.text === undefined) === (args.control === undefined))
        throw new Error('TEXT_CONTROL_EXCLUSIVE');
      const settings = ctx.betterShell.settings();
      const writeTimeout = boundedLimit(
        args.write_timeout_ms,
        settings.writeTimeoutMs,
        settings.writeTimeoutMs,
        'TIMEOUT_LIMIT_EXCEEDED: write_timeout_ms',
      );
      const maxOutput = boundedLimit(
        args.max_output_bytes,
        settings.outputBytes,
        settings.outputBytes,
        'OUTPUT_LIMIT_EXCEEDED: max_output_bytes',
        true,
      );
      let request: WriteRequest;
      if (args.text !== undefined) {
        request = { text: args.text, timeoutMs: writeTimeout };
      } else {
        const control = args.control;
        if (control === undefined) throw new Error('TEXT_CONTROL_EXCLUSIVE');
        request = { control, timeoutMs: writeTimeout };
      }
      const written = await ctx.betterShell.write(agent, id, request);
      const read =
        args.include_output === false
          ? undefined
          : ctx.betterShell.read(agent, id, { maxBytes: maxOutput });
      return {
        session_name: args.session_name,
        status: 'written',
        bytes_written: written.bytesWritten,
        returned_bytes: read === undefined ? 0 : Buffer.byteLength(read.text, 'utf8'),
        output_length: read?.totalBytes ?? 0,
        more: read?.truncated ?? false,
        timer_reset: written.session.activeCommandId !== undefined,
        session_status: written.session.activeCommandId === undefined ? 'idle' : 'busy',
        ...(read === undefined ? {} : { output: read.text, truncated: read.truncated }),
      };
    },
  });

  const shellRead = defineTool({
    name: 'shell_read',
    description: `Read the command list for a specified PTY session or read full/incremental command output. Use shell_session operation list to list sessions. ${limits}`,
    parameters: {
      operation: { type: 'string', enum: ['list', 'command'], required: true },
      session_name: { type: 'string', required: true },
      command_id: { type: 'string' },
      read_mode: { type: 'string', enum: ['full', 'incremental'], default: 'full' },
      cursor: { type: 'string' },
      offset: { type: 'integer' },
      wait_ms: {
        type: 'integer',
        description: `Event-driven wait in milliseconds, 0-${String(active.readWaitMs)}; expiry does not change command state.`,
      },
      limit: {
        type: 'integer',
        description: 'Maximum command records in this page; use list_cursor for more.',
      },
      list_cursor: { type: 'string', description: 'Opaque numeric page cursor returned by list.' },
      max_output_bytes: {
        type: 'integer',
        description: `Maximum returned UTF-8 bytes, 0-${String(active.outputBytes)}.`,
      },
    },
    output,
    async execute(args, exec): Promise<JsonValue> {
      const agent = requireOwner(exec);
      const id = sessionId(agent, args.session_name);
      if (args.operation === 'list') {
        if (
          args.command_id !== undefined ||
          args.cursor !== undefined ||
          args.offset !== undefined ||
          args.wait_ms !== undefined
        ) {
          throw new Error('READ_ARGUMENT_INVALID');
        }
        const start = parseListCursor(args.list_cursor);
        const settings = ctx.betterShell.settings();
        const limit = boundedLimit(args.limit, 100, 100, 'OUTPUT_LIMIT_EXCEEDED: limit');
        const maxOutput = boundedLimit(
          args.max_output_bytes,
          settings.outputBytes,
          settings.outputBytes,
          'OUTPUT_LIMIT_EXCEEDED: max_output_bytes',
          true,
        );
        const commands = ctx.betterShell.listCommands(agent, id);
        const page = commands.slice(start, start + limit);
        const bounded = boundedItems(page.map(commandJson), maxOutput);
        const next = start + bounded.items.length;
        return {
          operation: 'list',
          session_name: args.session_name,
          items: bounded.items,
          next_cursor: next < commands.length ? String(next) : null,
          truncated: bounded.truncated || next < commands.length,
        };
      }
      if (args.command_id === undefined) throw new Error('COMMAND_NOT_FOUND');
      if (args.limit !== undefined || args.list_cursor !== undefined) {
        throw new Error('READ_ARGUMENT_INVALID');
      }
      const readMode = args.read_mode ?? 'full';
      if (readMode === 'full' && (args.cursor !== undefined || args.offset !== undefined)) {
        throw new Error('INVALID_CURSOR');
      }
      const commandId = args.command_id as CommandId;
      const cursor =
        readMode === 'incremental'
          ? parseReadCursor(agent, id, commandId, args.cursor, args.offset)
          : { offset: undefined, generation: undefined };
      const settings = ctx.betterShell.settings();
      const maxOutput = boundedLimit(
        args.max_output_bytes,
        settings.outputBytes,
        settings.outputBytes,
        'OUTPUT_LIMIT_EXCEEDED: max_output_bytes',
        true,
      );
      const readOnce = () =>
        ctx.betterShell.read(agent, id, {
          commandId,
          ...(cursor.offset === undefined ? {} : { cursor: cursor.offset }),
          ...(cursor.generation === undefined ? {} : { generation: cursor.generation }),
          maxBytes: maxOutput,
        });
      let read = readOnce();
      const waitMs = boundedLimit(
        args.wait_ms,
        0,
        settings.readWaitMs,
        'TIMEOUT_LIMIT_EXCEEDED: wait_ms',
        true,
      );
      const deadline = Date.now() + waitMs;
      while (
        read.text.length === 0 &&
        read.command?.status === 'running' &&
        Date.now() < deadline
      ) {
        await ctx.betterShell.waitForChange(
          agent,
          id,
          commandId,
          exec.signal,
          Math.max(1, deadline - Date.now()),
        );
        read = readOnce();
      }
      const waitExpired =
        waitMs > 0 &&
        read.text.length === 0 &&
        read.command?.status === 'running' &&
        Date.now() >= deadline;
      return {
        operation: 'command',
        session_name: args.session_name,
        command_id: args.command_id,
        status: read.command?.status ?? 'failed',
        read_mode: readMode,
        wait_expired: waitExpired,
        output: read.text,
        returned_bytes: Buffer.byteLength(read.text, 'utf8'),
        output_length: read.totalBytes,
        more: read.truncated,
        next_cursor:
          readMode === 'incremental'
            ? createReadCursor(agent, id, commandId, read.cursor, read.generation)
            : null,
        truncated: read.truncated,
      };
    },
  });

  const shellSession = defineTool({
    name: 'shell_session',
    description: `Create, list, delete, or cancel owner-scoped PTY sessions and commands. create requires session_name and shell_profile; list takes no session target; delete requires session_name; cancel uses either task_id or session_name plus command_id. ${PROFILE_DESCRIPTION} ${limits}`,
    parameters: {
      operation: { type: 'string', enum: ['create', 'list', 'delete', 'cancel'], required: true },
      session_name: { type: 'string' },
      shell_profile: {
        type: 'string',
        enum: Object.keys(DEFAULT_PROFILES),
        description: PROFILE_DESCRIPTION,
      },
      cwd: { type: 'string' },
      env: {
        type: 'object',
        additionalProperties: true,
      },
      command_id: { type: 'string' },
      task_id: { type: 'string' },
      force: { type: 'boolean', default: false },
      limit: { type: 'integer' },
      list_cursor: { type: 'string' },
    },
    output,
    async execute(args, exec): Promise<JsonValue> {
      const agent = requireOwner(exec);
      const state = stateFor(agent);
      if (args.operation === 'list') {
        if (
          args.session_name !== undefined ||
          args.shell_profile !== undefined ||
          args.cwd !== undefined ||
          args.env !== undefined ||
          args.command_id !== undefined ||
          args.task_id !== undefined ||
          args.force === true
        ) {
          throw new Error('SESSION_ARGUMENT_INVALID');
        }
        const start = parseListCursor(args.list_cursor);
        const settings = ctx.betterShell.settings();
        const limit = boundedLimit(args.limit, 100, 100, 'OUTPUT_LIMIT_EXCEEDED: limit');
        const maxOutput = settings.outputBytes;
        const sessions = ctx.betterShell.list(agent);
        const page = sessions.slice(start, start + limit);
        const bounded = boundedItems(page.map(sessionJson), maxOutput);
        const next = start + bounded.items.length;
        return {
          operation: 'list',
          sessions: bounded.items,
          next_cursor: next < sessions.length ? String(next) : null,
          truncated: bounded.truncated || next < sessions.length,
        };
      }
      if (args.operation === 'create') {
        if (args.session_name === undefined) throw new Error('SESSION_NAME_REQUIRED');
        if (args.shell_profile === undefined) throw new Error('SHELL_PROFILE_REQUIRED');
        if (
          args.command_id !== undefined ||
          args.task_id !== undefined ||
          args.force === true ||
          args.limit !== undefined ||
          args.list_cursor !== undefined
        )
          throw new Error('SESSION_ARGUMENT_INVALID');
        await authorizeCommand(
          ctx,
          agent,
          `Create ${args.shell_profile} shell session: ${args.session_name}`,
          exec.signal,
          'shell_session',
          exec.callId,
        );
        const value = await ctx.betterShell.create(agent, {
          name: args.session_name,
          profile: args.shell_profile,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.env === undefined ? {} : { env: stringEnvironment(args.env) }),
        });
        state.sessions.set(args.session_name, value.id);
        return {
          operation: 'create',
          session_name: args.session_name,
          shell_profile: args.shell_profile,
          status: publicSessionStatus(value),
          session: sessionJson(value),
        };
      }
      if (args.operation === 'delete') {
        if (args.session_name === undefined) throw new Error('SESSION_NAME_REQUIRED');
        if (
          args.shell_profile !== undefined ||
          args.cwd !== undefined ||
          args.env !== undefined ||
          args.command_id !== undefined ||
          args.task_id !== undefined ||
          args.force === true ||
          args.limit !== undefined ||
          args.list_cursor !== undefined
        )
          throw new Error('SESSION_ARGUMENT_INVALID');
        await ctx.betterShell.close(agent, sessionId(agent, args.session_name), 'tool delete');
        state.sessions.delete(args.session_name);
        return { operation: 'delete', session_name: args.session_name, status: 'deleted' };
      }
      if (
        args.shell_profile !== undefined ||
        args.cwd !== undefined ||
        args.env !== undefined ||
        args.limit !== undefined ||
        args.list_cursor !== undefined
      )
        throw new Error('SESSION_ARGUMENT_INVALID');
      if (
        args.task_id !== undefined &&
        (args.session_name !== undefined || args.command_id !== undefined)
      )
        throw new Error('CANCEL_TARGET_EXCLUSIVE');
      if (args.task_id !== undefined) {
        const status = ctx.jobs.kill(args.task_id as JobId, agent, 'tool cancel');
        return {
          operation: 'cancel',
          task_id: args.task_id,
          status: status === 'requested' ? 'terminated' : 'already-finished',
          force_used: args.force === true,
        };
      }
      if (args.session_name === undefined || args.command_id === undefined)
        throw new Error('COMMAND_NOT_FOUND');
      const sessionIdValue = sessionId(agent, args.session_name);
      const result = await ctx.betterShell.cancelCommand(
        agent,
        sessionIdValue,
        args.command_id as CommandId,
        args.force === true,
      );
      const session = ctx.betterShell.list(agent).find((entry) => entry.id === sessionIdValue);
      return {
        operation: 'cancel',
        target: { session_name: args.session_name, command_id: args.command_id },
        status:
          result.status === 'killed' || result.status === 'cancelled' ? 'terminated' : 'cancelling',
        force_used: args.force === true,
        session_status: session?.status ?? 'closed',
        session_closed: session?.status !== 'running',
      };
    },
  });

  return [
    withStructuredErrors(shellExecute),
    withStructuredErrors(shellWrite),
    withStructuredErrors(shellRead),
    withStructuredErrors(shellSession),
  ];
}

function installBackgroundNotifications(ctx: Context): void {
  const dispose = ctx.jobs.onJobDone((snapshot, owner) => {
    if (owner === undefined) return;
    const jobs = backgroundJobs.get(owner);
    if (jobs === undefined) return;
    releaseShellJob(owner, snapshot.id);
    const meta = jobs.get(snapshot.id);
    if (meta === undefined) return;
    jobs.delete(snapshot.id);
    let outputPreview = '';
    let outputAvailable = false;
    let outputMore = false;
    try {
      const read = ctx.jobs.read(snapshot.id, owner);
      const limited = limitText(read.text, snapshot.outputLimitBytes ?? 16 * 1024);
      outputPreview = limited.text;
      outputAvailable = outputPreview.length > 0;
      outputMore = limited.truncated;
    } catch {
      // The completion record remains useful even when output was already consumed.
    }
    const status = publicJobStatus(snapshot);
    const notification = {
      notification_type: 'shell_background_result',
      ...(meta.taskId === undefined ? {} : { task_id: meta.taskId }),
      ...(meta.sessionName === undefined ? {} : { session_name: meta.sessionName }),
      ...(meta.commandId === undefined ? {} : { command_id: meta.commandId }),
      command_preview: meta.commandPreview.slice(0, 200),
      status,
      exit_code: extractExitCode(snapshot.detail),
      termination_reason: status === 'completed' ? null : (snapshot.detail ?? snapshot.status),
      output_preview: outputPreview,
      returned_bytes: Buffer.byteLength(outputPreview, 'utf8'),
      output_available: outputAvailable,
      more: outputMore,
    };
    const message = {
      id: randomUUID(),
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: `后台 Shell 命令结果\n${JSON.stringify(notification)}` },
      ],
      source: {
        kind: 'plugin' as const,
        plugin: name,
        form: 'notice' as const,
        summary: '后台 Shell 命令结果',
      },
    } as Parameters<Agent['inject']>[0];
    owner.inject(message);
  });
  ctx.effect(() => dispose, 'better-shell background notifications');
}

export function apply(ctx: Context): void {
  installBackgroundNotifications(ctx);
  for (const definition of createToolDefinitions(ctx)) ctx.tools.register(definition);
}

export const name = 'better-shell-tools';
export const inject = [
  'betterShell',
  'tools',
  'shell',
  'jobs',
  'approval',
  'sandboxPolicy',
] as const;
export default { name, inject, apply };
