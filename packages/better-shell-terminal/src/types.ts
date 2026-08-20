import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BetterShellSettings } from './config.js';

export type SessionId = string & { readonly __sessionId: unique symbol };
export type CommandId = string & { readonly __commandId: unique symbol };

export type ShellKind = 'powershell' | 'cmd' | 'raw';

export interface ShellProfile {
  readonly kind: ShellKind;
  readonly executable: string;
  readonly args: readonly string[];
  readonly singleArgs?: readonly string[];
  readonly allowSingle?: boolean;
  readonly allowPty?: boolean;
  readonly encoding?: string;
}

export interface TerminalConfig {
  readonly profiles: Readonly<Record<string, ShellProfile>>;
  readonly defaultProfile?: string;
  readonly defaultRows: number;
  readonly defaultCols: number;
  readonly maxOutputBytes: number;
  readonly maxCommandOutputBytes: number;
  readonly maxCommandHistory?: number;
  readonly maxSessions?: number;
  readonly maxWriteBytes?: number;
  readonly allowedCwdRoots?: readonly string[];
  readonly writeTimeoutMs: number;
}

export interface CreateSessionRequest {
  readonly name: string;
  readonly profile: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly rows?: number;
  readonly cols?: number;
}

export interface SessionSnapshot {
  readonly id: SessionId;
  readonly name: string;
  readonly profile: string;
  readonly cwd?: string;
  readonly status: 'running' | 'exited' | 'closed';
  readonly pid: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly activeCommandId?: CommandId;
}

export interface CommandSnapshot {
  readonly id: CommandId;
  readonly sessionId: SessionId;
  readonly command: string;
  readonly status:
    | 'queued'
    | 'running'
    | 'background'
    | 'completed'
    | 'failed'
    | 'timeout'
    | 'cancelled'
    | 'killed';
  readonly exitCode?: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly output: string;
  readonly truncated: boolean;
}

export interface CommandOperation {
  readonly id: CommandId;
  readonly done: Promise<CommandSnapshot>;
  snapshot(): CommandSnapshot;
  activityAt(): number;
  read(
    cursor?: number,
    maxBytes?: number,
  ): {
    readonly text: string;
    readonly cursor: number;
    readonly truncated: boolean;
    readonly generation: number;
  };
}

export interface WriteRequest {
  readonly text?: string;
  readonly control?: 'CTRL_C' | 'CTRL_D' | 'ESC' | 'ENTER' | 'TAB' | 'BACKSPACE';
  readonly timeoutMs?: number;
}

export interface WriteResult {
  readonly bytesWritten: number;
  readonly timerReset: boolean;
  readonly session: SessionSnapshot;
}

export interface ReadRequest {
  readonly commandId?: CommandId;
  readonly cursor?: number;
  readonly generation?: number;
  readonly maxBytes?: number;
}

export interface ReadResult {
  readonly text: string;
  readonly cursor: number;
  readonly truncated: boolean;
  readonly generation: number;
  readonly totalBytes: number;
  readonly command?: CommandSnapshot;
}

export interface PtyProcess {
  readonly pid: number;
  readonly supportsJobObject?: true;
  readonly onData: (listener: (data: string) => void) => () => void;
  readonly onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnRequest {
  readonly profile: ShellProfile;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly rows: number;
  readonly cols: number;
}

export type PtyFactory = (request: PtySpawnRequest) => PtyProcess;

export interface SingleProcessRead {
  readonly delta: string;
  readonly truncated: boolean;
}

export interface SingleProcess {
  readonly profile: string;
  readonly pid: number;
  readonly startedAt: number;
  activityAt(): number;
  readonly done: Promise<{ exitCode: number | null; finishedAt: number }>;
  readOutput(): SingleProcessRead;
  kill(): void;
}

export interface StartSingleRequest {
  readonly command: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
}

export interface CleanupSummary {
  readonly sessionsClosed: number;
  readonly singleProcessesStopped: number;
  readonly commandsCancelled: number;
  readonly completedAt: number;
}

export interface BetterShellService {
  settings(): BetterShellSettings;
  startSingle(owner: Agent, request: StartSingleRequest): Promise<SingleProcess>;
  create(owner: Agent, request: CreateSessionRequest): Promise<SessionSnapshot>;
  list(owner: Agent): readonly SessionSnapshot[];
  execute(owner: Agent, sessionId: SessionId, command: string): CommandOperation;
  write(owner: Agent, sessionId: SessionId, request: WriteRequest): Promise<WriteResult>;
  read(owner: Agent, sessionId: SessionId, request: ReadRequest): ReadResult;
  waitForChange(
    owner: Agent,
    sessionId: SessionId,
    commandId: CommandId,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<void>;
  listCommands(owner: Agent, sessionId: SessionId): readonly CommandSnapshot[];
  cancelCommand(
    owner: Agent,
    sessionId: SessionId,
    commandId: CommandId,
    force?: boolean,
  ): Promise<CommandSnapshot>;
  cancel(owner: Agent, sessionId: SessionId, force?: boolean): Promise<SessionSnapshot>;
  close(owner: Agent, sessionId: SessionId, reason?: string): Promise<void>;
  cleanupOwner(owner: Agent, reason?: string): Promise<CleanupSummary>;
  closeOwner(owner: Agent, reason?: string): Promise<void>;
}
