# BetterShell

Windows-first persistent shell tools for DeepSeek Shell (DSH).

BetterShell provides two plugins:

- `@gao-gao-zai/better-shell-terminal`: owner-scoped persistent PTY and single-process service.
- `@gao-gao-zai/better-shell-tools`: the `shell_execute`, `shell_write`, `shell_read`, and `shell_session` tools.

## Features

- Persistent PTY sessions across tool calls within the same DSH Agent lifecycle.
- Windows PowerShell 7, Windows PowerShell 5.1, and `cmd.exe` profiles.
- Agent-identity isolation for sessions, commands, cursors, and jobs.
- Foreground, background, timeout, cancellation, and completion notifications.
- UTF-8-safe bounded output with incremental cursors.
- Windows Job Object process-tree cleanup with fallback termination.
- Official DSH settings integration with live resource limits.
- Optional user approval integration for shell commands.
- Environment and working-directory validation, including optional `allowedCwdRoots`.
- Owner-scoped concurrent job admission and lifecycle cleanup.

## Requirements

- Windows 10/11 or Windows Server with the configured shell profiles available.
- Node.js 24 or newer.
- pnpm 11 or newer.
- DSH with the compatible `@deepseek-ai/*` peer dependencies.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration:windows
pnpm build
pnpm check:packages
```

The Windows integration suite exercises the configured PowerShell and `cmd.exe` profiles, PTY persistence, and process-tree cleanup.

## Packages

### Terminal service

`@gao-gao-zai/better-shell-terminal` exposes `LocalBetterShellService`, profile helpers, configuration schemas, and the terminal service types. PTY sessions are scoped by the exact `Agent` object and are closed when the owner or DSH process is disposed.

The optional `allowedCwdRoots` terminal configuration restricts session and single-process working directories to existing directories below the configured roots. Without this option, working directories must still be absolute, NUL-free, existing directories.

### Tool plugin

`@gao-gao-zai/better-shell-tools` registers:

- `shell_execute`: run a single process or execute inside an existing PTY session.
- `shell_write`: write text or control input to a PTY session.
- `shell_read`: list sessions/commands and read full or incremental output.
- `shell_session`: create, list, delete, and cancel sessions or commands.

Tool responses use structured error objects and bounded JSON output. Background jobs can inject a completion notice into the owning Agent conversation.

## Release artifacts

Release tarballs are generated under `.artifacts/` by the package checks and publish commands. The packages are intended to be installed into a compatible DSH host rather than run as standalone applications.

## License

MIT. See [LICENSE](./LICENSE).
