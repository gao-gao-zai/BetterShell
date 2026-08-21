import { randomBytes } from 'node:crypto';
import { statSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { DEFAULT_SETTINGS, type BetterShellSettings } from './config.js';
import { BoundedText, readCursor } from './buffer.js';
import { ShellOutputDecoder } from './encoding.js';
import { stripAnsi } from './ansi.js';
import { DEFAULT_PROFILES, resolveProfile, resolveSingleProfile } from './profiles.js';
import { nodePtyFactory } from './node-pty-factory.js';
import { startSingleProcess } from './single-process.js';
import { startProcessGuardian, type ProcessGuardian } from './job-object.js';
import type {
  BetterShellService,
  CleanupSummary,
  CommandId,
  CommandOperation,
  CommandSnapshot,
  CreateSessionRequest,
  PtyFactory,
  PtyProcess,
  ReadRequest,
  ReadResult,
  SessionId,
  SessionSnapshot,
  ShellKind,
  SingleProcess,
  StartSingleRequest,
  TerminalConfig,
  WriteRequest,
  WriteResult,
} from './types.js';

interface CommandRecord {
  readonly id: CommandId;
  readonly sessionId: SessionId;
  readonly command: string;
  readonly marker: string;
  readonly startMarker: string;
  readonly startedAt: number;
  lastActivityAt: number;
  started: boolean;
  readonly output: BoundedText;
  readonly resolve: (snapshot: CommandSnapshot) => void;
  readonly done: Promise<CommandSnapshot>;
  status: CommandSnapshot['status'];
  exitCode?: number;
  finishedAt?: number;
  readonly changeWaiters: Set<() => void>;
}

interface SessionRecord {
  readonly id: SessionId;
  readonly owner: Agent;
  readonly name: string;
  readonly profile: string;
  readonly kind: ShellKind;
  readonly process: PtyProcess;
  readonly guardian: ProcessGuardian;
  readonly createdAt: number;
  readonly output: BoundedText;
  readonly commands: Map<CommandId, CommandRecord>;
  cwd: string | undefined;
  lastActivityAt: number;
  status: SessionSnapshot['status'];
  active: CommandRecord | undefined;
  disposeData: () => void;
  disposeExit: () => void;
  markerBuffer: string;
  readonly decoder: ShellOutputDecoder;
  nextCommandNumber: number;
  writeChain: Promise<void>;
  readonly changeWaiters: Set<() => void>;
}

const CONTROL_BYTES: Readonly<Record<NonNullable<WriteRequest['control']>, string>> = {
  CTRL_C: '\u0003',
  CTRL_D: '\u0004',
  ESC: '\u001b',
  ENTER: '\r',
  TAB: '\t',
  BACKSPACE: '\u0008',
};

// Sentinel exit code the PowerShell wrapper reports when Ctrl+C interrupts a
// running command. 130 is the conventional SIGINT exit code.
const INTERRUPT_EXIT_CODE = 130;

const DEFAULT_CONFIG: TerminalConfig = {
  profiles: DEFAULT_PROFILES,
  defaultProfile: 'pwsh7',
  defaultRows: 40,
  defaultCols: 160,
  maxOutputBytes: 4 * 1024 * 1024,
  maxCommandOutputBytes: 1024 * 1024,
  maxCommandHistory: 256,
  maxSessions: 32,
  maxWriteBytes: 64 * 1024,
  writeTimeoutMs: 10_000,
};

function id(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

function validateProcessOptions(
  request: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
  allowedCwdRoots: readonly string[] = [],
): void {
  if (request.cwd !== undefined && (!isAbsolute(request.cwd) || request.cwd.includes('\u0000')))
    throw new Error('cwd must be an absolute path without NUL');
  if (request.cwd !== undefined) {
    const cwd = resolve(request.cwd);
    let realCwd: string;
    try {
      if (!statSync(cwd).isDirectory()) throw new Error('CWD_INVALID');
      realCwd = realpathSync(cwd);
    } catch (error) {
      if (error instanceof Error && error.message === 'CWD_INVALID') throw error;
      throw new Error('CWD_INVALID');
    }
    if (allowedCwdRoots.length > 0) {
      const allowed = allowedCwdRoots.some((root) => {
        try {
          const relativePath = relative(realpathSync(resolve(root)), realCwd);
          return (
            relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
          );
        } catch {
          return false;
        }
      });
      if (!allowed) throw new Error('PATH_NOT_ALLOWED');
    }
  }
  if (request.env === undefined) return;
  const entries = Object.entries(request.env);
  if (entries.length > 64) throw new Error('environment overlay exceeds 64 entries');
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
      throw new Error(`invalid environment key: ${key}`);
    if (value.includes('\u0000') || Buffer.byteLength(value, 'utf8') > 4096)
      throw new Error(`environment value is too large or contains NUL: ${key}`);
  }
}

function validateCreateRequest(
  request: CreateSessionRequest,
  allowedCwdRoots: readonly string[] = [],
): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.name)) {
    throw new Error(
      'session name must contain 1-64 ASCII letters, digits, underscores, or hyphens',
    );
  }
  validateProcessOptions(request, allowedCwdRoots);
}

function commandLine(
  kind: ShellKind,
  command: string,
  marker: string,
  startMarker: string,
): string {
  if (kind === 'powershell') {
    const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Write('${startMarker}'); $__dsh_b=[Convert]::FromBase64String('${encodedCommand}'); $__dsh_c=${String(INTERRUPT_EXIT_CODE)}; try { . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($__dsh_b))); $__dsh_c=if($LASTEXITCODE -is [int]){$LASTEXITCODE}elseif($?){0}else{1} } catch { $__dsh_c=1; Write-Error $_ } finally { [Console]::WriteLine(('{0}{1}__' -f '${marker}',$__dsh_c)) }`;
    const encodedScript = Buffer.from(script, 'utf8').toString('base64');
    return `$__dsh_x=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedScript}')); . ([ScriptBlock]::Create($__dsh_x))`;
  }
  if (kind === 'cmd') {
    const split = Math.ceil(startMarker.length / 2);
    const first = startMarker.slice(0, split);
    const second = startMarker.slice(split);
    const markerSplit = Math.ceil(marker.length / 2);
    const markerFirst = marker.slice(0, markerSplit);
    const markerSecond = marker.slice(markerSplit);
    return `set "__dsh_a=${first}"\rset "__dsh_b=${second}"\rset "__dsh_c=${markerFirst}"\rset "__dsh_d=${markerSecond}"\recho %__dsh_a%%__dsh_b%\r${command}\rif errorlevel 1 echo %__dsh_c%%__dsh_d%1__\rif not errorlevel 1 echo %__dsh_c%%__dsh_d%0__\rset "__dsh_a="\rset "__dsh_b="\rset "__dsh_c="\rset "__dsh_d="`;
  }
  if (kind === 'bash') {
    const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
    const script = `__dsh_b=$(printf '%s' '${encodedCommand}' | base64 -d); printf '%s\\n' '${startMarker}'; eval "$__dsh_b"; __dsh_c=$?; printf '%s%s__\\n' '${marker}' "$__dsh_c"`;
    const encodedScript = Buffer.from(script, 'utf8').toString('base64');
    return `__dsh_x=$(printf '%s' '${encodedScript}' | base64 -d); eval "$__dsh_x"`;
  }
  throw new Error('raw profiles do not support wrapped command execution');
}

function outputSnapshot(command: CommandRecord): CommandSnapshot {
  const output = command.output.snapshot();
  return {
    id: command.id,
    sessionId: command.sessionId,
    command: command.command,
    status: command.status,
    ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
    startedAt: command.startedAt,
    ...(command.finishedAt === undefined ? {} : { finishedAt: command.finishedAt }),
    output: output.text,
    truncated: output.truncated,
  };
}

function sessionSnapshot(session: SessionRecord): SessionSnapshot {
  return {
    id: session.id,
    name: session.name,
    profile: session.profile,
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    status: session.status,
    pid: session.process.pid,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    ...(session.active === undefined ? {} : { activeCommandId: session.active.id }),
  };
}

export class LocalBetterShellService implements BetterShellService {
  private readonly owners = new WeakMap<Agent, Map<SessionId, SessionRecord>>();
  private readonly singles = new WeakMap<Agent, Set<SingleProcess>>();

  public constructor(
    private readonly config: TerminalConfig = DEFAULT_CONFIG,
    private readonly factory: PtyFactory = nodePtyFactory,
    private readonly settingsSource: () => BetterShellSettings = () => DEFAULT_SETTINGS,
  ) {}

  public settings(): BetterShellSettings {
    return this.settingsSource();
  }

  public async startSingle(owner: Agent, request: StartSingleRequest): Promise<SingleProcess> {
    validateProcessOptions(request, this.config.allowedCwdRoots);
    const outputLimit = Math.min(this.config.maxOutputBytes, this.settings().outputBytes);
    const maxOutputBytes = request.maxOutputBytes ?? outputLimit;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > outputLimit)
      throw new Error('OUTPUT_LIMIT_EXCEEDED');
    this.ownerSessions(owner);
    const startup = this.beginOwnerStart(owner);
    try {
      const profileName = request.profile ?? this.config.defaultProfile ?? 'pwsh7';
      const profile = resolveSingleProfile(this.config.profiles, profileName);
      const cwd = request.cwd === undefined ? undefined : resolve(request.cwd);
      const process = await startSingleProcess({
        name: profileName,
        profile,
        command: request.command,
        ...(cwd === undefined ? {} : { cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
        maxOutputBytes,
      });
      if (this.closingOwners.has(owner)) {
        process.kill();
        await process.done;
        throw new Error('owner is closing');
      }
      let processes = this.singles.get(owner);
      if (processes === undefined) {
        processes = new Set();
        this.singles.set(owner, processes);
      }
      processes.add(process);
      void process.done.then(() => {
        processes.delete(process);
      });
      return process;
    } finally {
      startup.done();
    }
  }

  public async create(owner: Agent, request: CreateSessionRequest): Promise<SessionSnapshot> {
    validateCreateRequest(request, this.config.allowedCwdRoots);
    const sessions = this.ownerSessions(owner);
    if (sessions.size >= this.settings().maxSessions)
      throw new Error('RESOURCE_LIMIT_EXCEEDED: sessions');
    for (const existing of sessions.values()) {
      if (existing.name === request.name && existing.status !== 'closed')
        throw new Error(`session name already exists: ${request.name}`);
    }
    const startup = this.beginOwnerStart(owner);
    try {
      const profile = resolveProfile(this.config.profiles, request.profile);
      const cwd = request.cwd === undefined ? undefined : resolve(request.cwd);
      const process = this.factory({
        profile,
        ...(cwd === undefined ? {} : { cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
        rows: request.rows ?? this.config.defaultRows,
        cols: request.cols ?? this.config.defaultCols,
      });
      let guardian: ProcessGuardian;
      try {
        guardian = startProcessGuardian(process.supportsJobObject === true ? process.pid : 0);
      } catch (error) {
        process.kill();
        throw error;
      }
      try {
        await guardian.ready;
      } catch (error) {
        process.kill();
        await guardian.close();
        throw error;
      }
      if (this.closingOwners.has(owner)) {
        process.kill();
        await guardian.close();
        throw new Error('owner is closing');
      }
      const session: SessionRecord = {
        id: id('session') as SessionId,
        owner,
        name: request.name,
        profile: request.profile,
        kind: profile.kind,
        process,
        guardian,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        output: new BoundedText(this.config.maxOutputBytes),
        commands: new Map(),
        cwd,
        status: 'running',
        active: undefined,
        disposeData: () => {
          // Listener is assigned immediately after construction.
        },
        disposeExit: () => {
          // Listener is assigned immediately after construction.
        },
        markerBuffer: '',
        decoder: new ShellOutputDecoder(profile.encoding ?? 'utf-8'),
        nextCommandNumber: 1,
        writeChain: Promise.resolve(),
        changeWaiters: new Set(),
      };
      session.disposeData = process.onData((data) => {
        this.onData(session, data);
      });
      session.disposeExit = process.onExit((event) => {
        this.onExit(session, event.exitCode);
      });
      sessions.set(session.id, session);
      return sessionSnapshot(session);
    } finally {
      startup.done();
    }
  }

  public list(owner: Agent): readonly SessionSnapshot[] {
    const sessions = this.owners.get(owner);
    return sessions === undefined ? [] : [...sessions.values()].map(sessionSnapshot);
  }

  public execute(owner: Agent, sessionId: SessionId, command: string): CommandOperation {
    if (command.trim().length === 0) throw new Error('command must be non-empty');
    const session = this.getSession(owner, sessionId);
    if (session.status !== 'running') throw new Error('session is not running');
    if (session.active !== undefined) throw new Error('session is busy');
    const commandId = session.nextCommandNumber
      .toString(36)
      .toUpperCase()
      .padStart(3, '0') as CommandId;
    session.nextCommandNumber += 1;
    const marker = `__DSH_DONE_${randomBytes(10).toString('hex')}_`;
    const startMarker = `__DSH_START_${randomBytes(10).toString('hex')}_`;
    let resolveDone!: (snapshot: CommandSnapshot) => void;
    const done = new Promise<CommandSnapshot>((resolve) => {
      resolveDone = resolve;
    });
    const commandRecord: CommandRecord = {
      id: commandId,
      sessionId,
      command,
      marker,
      startMarker,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      started: false,
      output: new BoundedText(this.config.maxCommandOutputBytes),
      resolve: resolveDone,
      done,
      status: 'running',
      changeWaiters: new Set(),
    };
    session.commands.set(commandId, commandRecord);
    session.active = commandRecord;
    session.markerBuffer = '';
    try {
      session.process.write(`${commandLine(session.kind, command, marker, startMarker)}\r`);
    } catch (error) {
      this.finishCommand(session, commandRecord, 'failed', undefined, String(error));
    }
    return {
      id: commandId,
      done,
      snapshot: () => outputSnapshot(commandRecord),
      activityAt: () => commandRecord.lastActivityAt,
      read: (cursor, maxBytes) =>
        readCursor(commandRecord.output.snapshot(), cursor, maxBytes ?? this.config.maxOutputBytes),
    };
  }

  public write(owner: Agent, sessionId: SessionId, request: WriteRequest): Promise<WriteResult> {
    const hasText = request.text !== undefined;
    const hasControl = request.control !== undefined;
    if (hasText === hasControl) throw new Error('exactly one of text or control is required');
    const session = this.getSession(owner, sessionId);
    if (session.status !== 'running') throw new Error('session is not running');
    let text: string;
    if (request.text !== undefined) {
      text = request.text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
    } else {
      const control = request.control;
      if (control === undefined) throw new Error('exactly one of text or control is required');
      text = CONTROL_BYTES[control];
    }
    if (Buffer.byteLength(text, 'utf8') > this.settings().maxWriteBytes)
      throw new Error('WRITE_LIMIT_EXCEEDED');
    const writeLimit = Math.min(this.config.writeTimeoutMs, this.settings().writeTimeoutMs);
    const timeoutMs = Math.min(request.timeoutMs ?? writeLimit, writeLimit);
    const timerReset = session.active !== undefined;
    const write = session.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('WRITE_TIMEOUT'));
          }, timeoutMs);
          try {
            session.process.write(text);
            clearTimeout(timer);
            session.lastActivityAt = Date.now();
            if (session.active !== undefined)
              session.active.lastActivityAt = session.lastActivityAt;
            resolve();
          } catch (error) {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
    session.writeChain = write.catch(() => {
      // Keep the queue usable after a failed write.
    });
    return write.then(() => ({
      bytesWritten: Buffer.byteLength(text, 'utf8'),
      timerReset,
      session: sessionSnapshot(session),
    }));
  }

  public read(owner: Agent, sessionId: SessionId, request: ReadRequest): ReadResult {
    const session = this.getSession(owner, sessionId);
    const command =
      request.commandId === undefined ? session.active : session.commands.get(request.commandId);
    if (request.commandId !== undefined && command === undefined)
      throw new Error('command not found');
    const output = command === undefined ? session.output.snapshot() : command.output.snapshot();
    if (request.generation !== undefined && request.generation !== output.generation) {
      throw new Error('INVALID_CURSOR');
    }
    const result = readCursor(
      output,
      request.cursor,
      request.maxBytes ?? this.config.maxOutputBytes,
    );
    return {
      ...result,
      totalBytes: output.endBytes,
      ...(command === undefined ? {} : { command: outputSnapshot(command) }),
    };
  }

  public waitForChange(
    owner: Agent,
    sessionId: SessionId,
    commandId: CommandId,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<void> {
    const session = this.getSession(owner, sessionId);
    const command = session.commands.get(commandId);
    if (command === undefined) throw new Error('command not found');
    if (command.status !== 'running') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        command.changeWaiters.delete(onChange);
        signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      const onChange = (): void => {
        finish();
      };
      const onAbort = (): void => {
        command.changeWaiters.delete(onChange);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('tool call aborted'));
      };
      command.changeWaiters.add(onChange);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      if (!signal?.aborted && timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(finish, timeoutMs);
      }
    });
  }

  public listCommands(owner: Agent, sessionId: SessionId): readonly CommandSnapshot[] {
    const session = this.getSession(owner, sessionId);
    return [...session.commands.values()].map(outputSnapshot);
  }

  public async cancelCommand(
    owner: Agent,
    sessionId: SessionId,
    commandId: CommandId,
    force = false,
  ): Promise<CommandSnapshot> {
    const session = this.getSession(owner, sessionId);
    const command = session.commands.get(commandId);
    if (command === undefined) throw new Error('command not found');
    if (command.status === 'running') {
      try {
        if (force) {
          session.process.write('\u0003');
          await Promise.race([
            command.done,
            new Promise<void>((resolve) => {
              setTimeout(resolve, 2_000);
            }),
          ]);
          const stillRunning = outputSnapshot(command).status === 'running';
          if (stillRunning) {
            this.finishCommand(session, command, 'cancelled', undefined, 'force cancellation');
            session.status = 'closed';
            session.process.kill();
          }
        } else {
          session.process.write('\u0003');
          await Promise.race([
            command.done,
            new Promise<void>((resolve) => {
              setTimeout(resolve, 2_000);
            }),
          ]);
        }
      } catch (error) {
        if (session.status !== 'running') throw new Error('SESSION_CLOSED');
        throw new Error(
          `COMMAND_CANCELLED: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return outputSnapshot(command);
  }

  public cancel(owner: Agent, sessionId: SessionId, force = false): Promise<SessionSnapshot> {
    const session = this.getSession(owner, sessionId);
    if (force) {
      session.process.kill();
      session.status = 'closed';
      if (session.active !== undefined) this.finishCommand(session, session.active, 'cancelled');
    } else if (session.active !== undefined) {
      try {
        session.process.write('\u0003');
      } catch (error) {
        if (session.status !== 'running') throw new Error('SESSION_CLOSED');
        throw new Error(
          `COMMAND_CANCELLED: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return Promise.resolve(sessionSnapshot(session));
  }

  public async close(owner: Agent, sessionId: SessionId, reason = 'closed'): Promise<void> {
    void reason;
    const session = this.getSession(owner, sessionId);
    session.disposeData();
    session.disposeExit();
    if (session.active !== undefined) this.finishCommand(session, session.active, 'cancelled');
    session.status = 'closed';
    session.process.kill();
    await session.guardian.close();
    this.owners.get(owner)?.delete(sessionId);
  }

  public async cleanupOwner(owner: Agent, reason = 'owner disposed'): Promise<CleanupSummary> {
    this.closingOwners.add(owner);
    await this.waitOwnerStarts(owner);

    const singles = this.singles.get(owner);
    const singleProcessesStopped = singles?.size ?? 0;
    if (singles !== undefined) {
      for (const process of singles) process.kill();
      await Promise.all([...singles].map((process) => process.done));
      this.singles.delete(owner);
    }

    const sessions = this.owners.get(owner);
    const sessionList = sessions === undefined ? [] : [...sessions.values()];
    const commandsCancelled = sessionList.reduce(
      (count, session) => count + (session.active === undefined ? 0 : 1),
      0,
    );
    await Promise.all(sessionList.map((session) => this.close(owner, session.id, reason)));
    this.owners.delete(owner);
    this.ownerIndex.delete(owner);
    return {
      sessionsClosed: sessionList.length,
      singleProcessesStopped,
      commandsCancelled,
      completedAt: Date.now(),
    };
  }

  public async closeOwner(owner: Agent, reason = 'owner disposed'): Promise<void> {
    await this.cleanupOwner(owner, reason);
  }

  public async closeAll(reason = 'service disposed'): Promise<void> {
    const owners: Agent[] = [];
    // WeakMap is intentionally non-enumerable; owner cleanup normally closes these.
    // Service teardown also closes sessions held by the explicit owner index below.
    for (const owner of this.ownerIndex) owners.push(owner);
    await Promise.all(owners.map((owner) => this.closeOwner(owner, reason)));
  }

  private readonly ownerIndex = new Set<Agent>();
  private readonly ownerCleanupInstalled = new WeakSet<Agent>();

  private readonly pendingStarts = new WeakMap<Agent, Set<Promise<void>>>();
  private readonly closingOwners = new WeakSet<Agent>();

  private beginOwnerStart(owner: Agent): { readonly done: () => void } {
    if (this.closingOwners.has(owner)) throw new Error('owner is closing');
    let resolveDone!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let starts = this.pendingStarts.get(owner);
    if (starts === undefined) {
      starts = new Set();
      this.pendingStarts.set(owner, starts);
    }
    starts.add(settled);
    return {
      done: () => {
        starts.delete(settled);
        resolveDone();
      },
    };
  }

  private async waitOwnerStarts(owner: Agent): Promise<void> {
    const starts = this.pendingStarts.get(owner);
    if (starts !== undefined) await Promise.all([...starts]);
  }

  private ownerSessions(owner: Agent): Map<SessionId, SessionRecord> {
    let sessions = this.owners.get(owner);
    if (sessions === undefined) {
      sessions = new Map();
      this.owners.set(owner, sessions);
      this.ownerIndex.add(owner);
      if (!this.ownerCleanupInstalled.has(owner)) {
        this.ownerCleanupInstalled.add(owner);
        owner.ctx.effect(
          () => async () => {
            await this.closeOwner(owner, 'owner disposed');
          },
          'better-shell owner cleanup',
        );
      }
    }
    return sessions;
  }

  private getSession(owner: Agent, sessionId: SessionId): SessionRecord {
    const session = this.owners.get(owner)?.get(sessionId);
    if (session === undefined) throw new Error('session not found');
    return session;
  }

  private notifyChange(session: SessionRecord): void {
    const sessionWaiters = [...session.changeWaiters];
    session.changeWaiters.clear();
    for (const resolve of sessionWaiters) resolve();
    const command = session.active;
    if (command !== undefined) {
      const commandWaiters = [...command.changeWaiters];
      command.changeWaiters.clear();
      for (const resolve of commandWaiters) resolve();
    }
  }

  private onData(session: SessionRecord, data: string | Uint8Array): void {
    const decoded = session.decoder.decode(data);
    if (decoded.length === 0) return;
    session.lastActivityAt = Date.now();
    const clean = stripAnsi(decoded);
    session.output.append(clean);
    const command = session.active;
    if (command === undefined) {
      this.notifyChange(session);
      return;
    }
    command.lastActivityAt = session.lastActivityAt;
    session.markerBuffer += clean;

    if (!command.started) {
      const startIndex = session.markerBuffer.indexOf(command.startMarker);
      if (startIndex < 0) {
        const keepCharacters = Math.max(0, command.startMarker.length - 1);
        if (session.markerBuffer.length > keepCharacters) {
          session.markerBuffer = session.markerBuffer.slice(-keepCharacters);
        }
        this.notifyChange(session);
        return;
      }
      command.started = true;
      session.markerBuffer = session.markerBuffer.slice(startIndex + command.startMarker.length);
    }

    let searchFrom = 0;
    let markerIndex = -1;
    let completion: RegExpExecArray | null = null;
    while (searchFrom <= session.markerBuffer.length) {
      const candidate = session.markerBuffer.indexOf(command.marker, searchFrom);
      if (candidate < 0) break;
      const candidateTail = session.markerBuffer.slice(candidate + command.marker.length);
      const parsed = /^(-?\d+)__/.exec(candidateTail);
      if (parsed !== null) {
        markerIndex = candidate;
        completion = parsed;
        break;
      }
      searchFrom = candidate + command.marker.length;
    }
    if (markerIndex < 0 || completion === null) {
      const keepCharacters = command.marker.length + 32;
      const emitLength = Math.max(0, session.markerBuffer.length - keepCharacters);
      if (emitLength > 0) command.output.append(session.markerBuffer.slice(0, emitLength));
      session.markerBuffer = session.markerBuffer.slice(emitLength);
      this.notifyChange(session);
      return;
    }
    const markerTail = session.markerBuffer.slice(markerIndex + command.marker.length);
    command.output.append(session.markerBuffer.slice(0, markerIndex));
    session.markerBuffer = markerTail.slice(completion[0].length);
    const code = Number.parseInt(completion[1] ?? '1', 10);
    this.finishCommand(
      session,
      command,
      code === 0 ? 'completed' : code === INTERRUPT_EXIT_CODE ? 'cancelled' : 'failed',
      code,
    );
    session.markerBuffer = '';
    this.notifyChange(session);
  }

  private onExit(session: SessionRecord, exitCode: number): void {
    if (session.status !== 'closed') session.status = 'exited';
    void session.guardian.close();
    if (session.active !== undefined)
      this.finishCommand(
        session,
        session.active,
        'failed',
        exitCode,
        'PTY exited before command marker',
      );
  }

  private finishCommand(
    session: SessionRecord,
    command: CommandRecord,
    status: CommandSnapshot['status'],
    exitCode?: number,
    extraOutput?: string,
  ): void {
    if (command.status !== 'running') return;
    if (extraOutput !== undefined) command.output.append(`\n${extraOutput}`);
    command.status = status;
    if (exitCode !== undefined) command.exitCode = exitCode;
    command.finishedAt = Date.now();
    if (session.active === command) session.active = undefined;
    const waiters = [...command.changeWaiters];
    command.changeWaiters.clear();
    for (const resolve of waiters) resolve();
    this.notifyChange(session);
    command.resolve(outputSnapshot(command));
    if (session.commands.size > this.settings().maxCommandHistory) {
      const oldest = session.commands.keys().next().value;
      if (oldest !== undefined && oldest !== command.id) session.commands.delete(oldest);
    }
  }
}

export function createDefaultConfig(config?: Partial<TerminalConfig>): TerminalConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    profiles: config?.profiles ?? DEFAULT_CONFIG.profiles,
  };
}
