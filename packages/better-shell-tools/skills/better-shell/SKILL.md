---
name: better-shell
description: Use BetterShell's persistent Windows shell tools with the exact profile names and argument contracts.
whenToUse: Use when creating a persistent PTY session, executing a command through an existing session, writing to a session, or reading shell output with shell_session, shell_execute, shell_write, or shell_read.
---

# BetterShell

BetterShell provides four DSH tools for Windows shell execution:

- `shell_session`: create, list, delete, and cancel owner-scoped PTY sessions.
- `shell_execute`: run a single command or execute inside an existing PTY session.
- `shell_write`: write text or control input to an existing PTY session.
- `shell_read`: list commands for a specified session and read full or incremental command output.

## Exact Profiles

Use one of these exact `shell_profile` values:

- `cmd`: Windows `cmd.exe`.
- `pwsh7`: PowerShell 7, using `pwsh.exe`.
- `windowsPowerShell`: Windows PowerShell 5.1, using `powershell.exe`.

There are no `default`, `powershell`, `pwsh`, `bash`, `git-bash`, or `wsl` profiles in this plugin.

## Persistent Session Workflow

Create a session first. Both `session_name` and `shell_profile` are required for `create`:

```json
{
  "operation": "create",
  "session_name": "main",
  "shell_profile": "cmd"
}
```

Then execute through that session. In `execute` mode, pass `session_name` and do not pass `shell_profile`:

```json
{
  "mode": "execute",
  "command": "echo BETTER_SHELL_OK",
  "session_name": "main",
  "run_mode": "wait"
}
```

Use `run_mode: "background"` for a command that should continue after the tool call returns. For `single` mode, the result includes a `task_id`; use `shell_session` with `operation: "cancel"` to stop it. For persistent `execute` mode, the result includes `session_name` and `command_id`; use `shell_read` to inspect output or `shell_session` cancellation to stop it.

## Single Commands

For an independent process, omit `session_name` and use the default `single` mode:

```json
{
  "mode": "single",
  "command": "Get-Location",
  "shell_profile": "pwsh7",
  "run_mode": "wait"
}
```

`session_name` is invalid in `single` mode. `shell_profile` is optional in `single` mode and defaults to `pwsh7`.

## Session Tools

List sessions:

```json
{
  "operation": "list"
}
```

Write to a session. Pass exactly one of `text` or `control`; `control` is one of `CTRL_C`, `CTRL_D`, `ESC`, `ENTER`, `TAB`, or `BACKSPACE`:

```json
{
  "session_name": "main",
  "text": "echo next\r"
}
```

Use `shell_session` with `operation: "list"` to list sessions. Use `shell_session` with `operation: "delete"` and `session_name` to close a session. Use `shell_session` with `operation: "cancel"` either with `task_id` for a single/background job or with both `session_name` and `command_id` for a persistent command.

Read command output:

```json
{
  "operation": "command",
  "session_name": "main",
  "command_id": "001",
  "read_mode": "incremental"
}
```

Use the returned `next_cursor` for the next incremental read. Do not invent alternate field names such as `profile`, `shell`, `action`, `name`, or `command_text`.

## Permission Behavior

In `workspace-write` or `read-only`, session creation and shell execution use the DSH approval service. In effective `danger-full-access`, BetterShell executes directly without an approval prompt. If the effective Sandbox mode cannot be resolved, the plugin keeps the approval path and fails closed.

Sessions belong to the exact DSH Agent object and do not survive Agent or DSH process disposal.
