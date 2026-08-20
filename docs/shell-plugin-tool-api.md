# Shell 插件工具 API 设计

## 1. 设计原则

本文件定义 Shell 插件对 Agent 暴露的四个工具参数和工具描述。字段名以 JSON Schema 风格表示，实际注册时可以转换为 DSH 使用的工具 schema。

插件提供四个工具：

- `shell_execute`：单次执行或在已有 PTY 会话中执行命令。
- `shell_write`：向已有 PTY 会话写入文本或结构化控制输入。
- `shell_read`：查询命令列表、命令状态和合并后的终端输出。
- `shell_session`：创建、列出、删除终端会话，以及取消 PTY 命令或 single 后台任务。

所有工具均绑定当前 DSH 会话。工具调用中的会话名、命令 ID、任务 ID 和游标不能跨 DSH 会话使用。

## 2. 动态上限占位符

工具描述在 Agent 会话创建时生成，描述中必须填入当前配置值。以下占位符表示运行时生成的具体数字：

- `{{single_wait_max_ms}}`：single 等待模式本次调用的最大等待时间。
- `{{single_background_max_ms}}`：single 后台任务的最大活动超时。
- `{{pty_wait_max_ms}}`：PTY execute 等待模式本次调用的最大等待时间。
- `{{pty_background_max_ms}}`：PTY 后台任务的最大活动超时。
- `{{read_wait_max_ms}}`：shell_read 的最大阻塞等待时间。
- `{{write_timeout_max_ms}}`：shell_write 的最大写入等待时间。
- `{{max_return_bytes}}`：单个工具响应允许返回的绝对最大字节数。
- `{{max_output_bytes}}`：单个命令允许保留的最大合并输出字节数。
- `{{max_list_items}}`：列表类请求允许返回的最大项目数。

工具实现必须在执行时重新校验这些限制。Agent 请求超过上限时应返回稳定错误，不得静默扩大、裁剪或绕过上限。

## 3. 工具一：`shell_execute`

### 3.1 工具描述

建议注册描述：

> 执行 Shell 命令。默认使用 `single` 模式创建临时进程；也可以使用 `execute` 模式在当前 DSH 会话中已创建的 PTY 终端会话里执行命令。`wait` 模式只等待指定时间，等待时间到期后命令不会被终止，而是转为后台运行并返回任务标识；`background` 模式立即返回。PTY 会话中的命令只能串行执行，但可以用 `shell_write` 交互输入。当前上限：single 等待 `{{single_wait_max_ms}} ms`，single 后台活动超时 `{{single_background_max_ms}} ms`，PTY 等待 `{{pty_wait_max_ms}} ms`，PTY 后台活动超时 `{{pty_background_max_ms}} ms`，单次返回最多 `{{max_return_bytes}}` bytes。调用值超过上限会失败。

### 3.2 参数

```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": ["single", "execute"],
      "default": "single",
      "description": "single 创建临时执行进程；execute 在已存在的 PTY 会话中执行。"
    },
    "command": {
      "type": "string",
      "description": "交给 Shell 的命令文本。支持当前 Shell 的管道、重定向、变量、内建命令和多行语义。"
    },
    "shell_profile": {
      "type": "string",
      "description": "仅 single 模式可用。配置中的 Shell profile 名称，不是可执行文件路径。省略时使用默认 profile。execute 模式不得传入。"
    },
    "session_name": {
      "type": "string",
      "description": "仅 execute 模式必填。当前 DSH 会话中已经存在的终端会话名。"
    },
    "run_mode": {
      "type": "string",
      "enum": ["wait", "background"],
      "default": "wait",
      "description": "wait 等待命令完成或等待上限到期；background 提交后立即返回。"
    },
    "wait_timeout_ms": {
      "type": "integer",
      "minimum": 0,
      "description": "仅 wait 模式有意义。本次工具调用最多等待多少毫秒。到期后命令转后台，不会被终止。上限由模式决定。"
    },
    "background_timeout_ms": {
      "type": "integer",
      "minimum": 1,
      "description": "命令进入后台后的活动超时。PTY 中每次成功 shell_write 会重置活动计时；不能超过对应后台上限。"
    },
    "max_runtime_ms": {
      "type": "integer",
      "minimum": 1,
      "description": "可选的绝对最长运行时间，从命令启动时计算，不会因 shell_write 重置。不能超过插件硬上限。用于防止持续交互任务无限运行。"
    },
    "max_output_bytes": {
      "type": "integer",
      "minimum": 0,
      "description": "本次响应最多返回多少输出字节。只能小于或等于当前用户级返回上限；服务端命令历史仍按历史保留上限处理。"
    }
  },
  "required": ["command"],
  "additionalProperties": false
}
```

### 3.3 参数约束

- `mode` 省略时为 `single`。
- `command` 必须是非空字符串；是否允许多行由 Shell profile 配置决定。
- `shell_profile` 只能引用白名单 profile。Agent 不能传入可执行文件路径或任意 Shell 参数。
- `shell_profile`、`session_name` 的互斥关系由模式决定：
  - `single`：允许 `shell_profile`，禁止 `session_name`。
  - `execute`：必须有 `session_name`，禁止 `shell_profile`。
- `execute` 指向不存在的会话时返回 `SESSION_NOT_FOUND`，不自动创建。
- `run_mode: "wait"` 时使用 `wait_timeout_ms`；省略时使用对应默认值。
- `run_mode: "background"` 时忽略 `wait_timeout_ms` 并建议 schema 层拒绝该字段，避免 Agent 误解；使用 `background_timeout_ms`。
- `background_timeout_ms` 是活动超时。对 PTY 命令，成功的 `shell_write` 会重新开始活动计时。
- `max_runtime_ms` 是绝对时间边界，不能被写入重置；省略时使用插件配置的绝对运行上限。
- 等待超时返回 `status: "background"`、`wait_expired: true`、`detached_to_background: true` 和任务标识，不返回命令失败。
- single 后台任务使用 `task_id`；PTY 命令使用 `session_name` 和 `command_id`。

### 3.4 返回结构

#### single 完成

```json
{
  "mode": "single",
  "status": "completed",
  "task_id": null,
  "exit_code": 0,
  "wait_expired": false,
  "timed_out": false,
  "output": "...",
  "truncated": false,
  "duration_ms": 128
}
```

#### wait 转后台

```json
{
  "mode": "single",
  "status": "background",
  "task_id": "T00A",
  "wait_expired": true,
  "detached_to_background": true,
  "message": "等待时间已到，命令未被终止，现已转为后台运行；完成后将注入最终结果通知。"
}
```

#### PTY execute 完成

```json
{
  "mode": "execute",
  "session_name": "build",
  "command_id": "00A",
  "status": "completed",
  "exit_code": 0,
  "wait_expired": false,
  "timed_out": false,
  "output": "...",
  "truncated": false,
  "duration_ms": 128
}
```

## 4. 工具二：`shell_write`

### 4.1 工具描述

建议注册描述：

> 向已存在的 PTY 终端会话写入原始文本或结构化控制输入，用于回答交互式 CLI 的提示、发送换行或发送 Ctrl-C/Ctrl-D/Esc 等控制输入。不会创建会话，不会创建命令记录。成功写入正在运行的命令后会重置该命令的活动超时，但不会延长绝对最长运行时间。当前写入超时上限为 `{{write_timeout_max_ms}} ms`，响应最多返回 `{{max_return_bytes}}` bytes。

### 4.2 参数

```json
{
  "type": "object",
  "properties": {
    "session_name": {
      "type": "string",
      "description": "当前 DSH 会话中已经存在的 PTY 终端会话名。"
    },
    "text": {
      "type": "string",
      "description": "原样写入 PTY 的文本。换行不会自动追加；需要回车时应显式传入。与 control 二选一。"
    },
    "control": {
      "type": "string",
      "enum": ["CTRL_C", "CTRL_D", "ESC", "ENTER", "TAB", "BACKSPACE"],
      "description": "结构化控制输入。与 text 二选一。实际支持枚举由 Shell profile 和终端后端共同决定。"
    },
    "write_timeout_ms": {
      "type": "integer",
      "minimum": 1,
      "description": "本次 PTY 写入最多等待多少毫秒，不能超过 {{write_timeout_max_ms}}。"
    },
    "include_output": {
      "type": "boolean",
      "default": true,
      "description": "是否在写入响应中附带写入后的近期合并终端输出摘要。"
    },
    "max_output_bytes": {
      "type": "integer",
      "minimum": 0,
      "description": "近期输出摘要最多返回多少字节，不能超过当前返回上限。"
    }
  },
  "required": ["session_name"],
  "additionalProperties": false
}
```

实现校验要求：`text` 和 `control` 必须恰好提供一个；会话不存在返回 `SESSION_NOT_FOUND`；没有运行中的命令时写入不创建计时器；成功写入运行中命令时返回 `timer_reset: true`。

在不修改现有 DSH 插件的实现中，`shell_write` 通过 `ctx.betterShell.write()` 写入同一 `session_name` 绑定的 PTY handle，可以在命令仍 active 时发送文本或控制字节。写入由 terminal service 串行化；不会创建第二个 PTY，也不会创建新的命令记录。会话关闭或写入失败时返回稳定错误。
### 4.3 返回结构

```json
{
  "session_name": "build",
  "status": "written",
  "bytes_written": 2,
  "timer_reset": true,
  "session_status": "busy",
  "output": "Continue? [Y/N] ",
  "truncated": false
}
```

## 5. 工具三：`shell_read`

### 5.1 工具描述

建议注册描述：

> 读取当前 DSH 会话中 PTY 终端的命令概览、命令状态和合并后的终端输出。命令读取默认使用 `full` 模式；需要只读取上次位置之后的新内容时使用 `incremental` 和该命令返回的游标。可以设置 `wait_ms` 在新输出、状态变化、命令结束或等待时间到期前阻塞。读取等待到期不会取消或改变命令。当前读取等待上限为 `{{read_wait_max_ms}} ms`，单次响应最多返回 `{{max_return_bytes}}` bytes。

### 5.2 参数

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "string",
      "enum": ["list", "command"],
      "description": "list 获取终端会话最近命令概览；command 获取指定命令状态和输出。"
    },
    "session_name": {
      "type": "string",
      "description": "目标 PTY 终端会话名。"
    },
    "command_id": {
      "type": "string",
      "description": "operation=command 时必填的命令短 ID。"
    },
    "read_mode": {
      "type": "string",
      "enum": ["full", "incremental"],
      "default": "full",
      "description": "command 操作的输出模式。full 返回指定命令当前保存的全部输出；incremental 返回游标之后新增的输出。"
    },
    "cursor": {
      "type": "string",
      "description": "incremental 模式使用的上一次返回游标，只能用于同一 DSH 会话、终端会话和命令。"
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "description": "incremental 模式的字节偏移。cursor 和 offset 二选一；优先使用 cursor。"
    },
    "wait_ms": {
      "type": "integer",
      "minimum": 0,
      "description": "command 操作最多阻塞多少毫秒等待目标事件，不能超过 {{read_wait_max_ms}}。0 或省略表示立即返回。"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "description": "operation=list 时最多返回多少条命令，不能超过 {{max_list_items}}。"
    },
    "list_cursor": {
      "type": "string",
      "description": "operation=list 的分页游标，与 command 的输出 cursor 不同。"
    },
    "max_output_bytes": {
      "type": "integer",
      "minimum": 0,
      "description": "本次响应最多返回多少输出字节，不能超过 {{max_return_bytes}}。"
    }
  },
  "required": ["operation", "session_name"],
  "additionalProperties": false
}
```

### 5.3 参数约束

- `operation: "list"`：禁止 `command_id`、`read_mode`、`cursor`、`offset` 和 `wait_ms`；允许 `limit`、`list_cursor`。
- `operation: "command"`：必须提供 `command_id`；允许 `read_mode`、`cursor`、`offset`、`wait_ms`；禁止 `limit`、`list_cursor`。
- `read_mode` 省略时为 `full`。
- `full` 模式禁止 `cursor` 和 `offset`；返回指定命令当前保存的全部合并输出。
- `incremental` 模式允许 `cursor` 或 `offset`，但不能同时提供；首次没有游标时从输出起点开始。
- `wait_ms` 等待以下任一事件：
  - `full` 模式：命令状态变化、出现任意新增输出、命令结束或等待到期。
  - `incremental` 模式：游标之后出现新增输出、命令状态变化、命令结束或等待到期。
- 事件提前发生时可以提前返回；等待到期返回 `wait_expired: true`，不改变命令状态。
- 游标绑定 DSH 会话、终端会话、命令短 ID 和输出版本。游标失效时返回 `INVALID_CURSOR`，提示重新使用 `full`。

### 5.4 返回结构

#### 命令概览

```json
{
  "operation": "list",
  "session_name": "build",
  "items": [
    {
      "command_id": "00A",
      "command_preview": "npm run build",
      "status": "completed",
      "started_at": "...",
      "finished_at": "...",
      "exit_code": 0,
      "output_length": 2048,
      "output_available": true
    }
  ],
  "next_cursor": null,
  "truncated": false
}
```

#### 命令全量读取

```json
{
  "operation": "command",
  "session_name": "build",
  "command_id": "00A",
  "status": "running",
  "read_mode": "full",
  "wait_expired": false,
  "output": "current full output...",
  "output_length": 2048,
  "truncated": false
}
```

#### 命令增量读取等待到期

```json
{
  "operation": "command",
  "session_name": "build",
  "command_id": "00A",
  "status": "running",
  "read_mode": "incremental",
  "wait_ms": 30000,
  "wait_expired": true,
  "output": "",
  "next_cursor": "...",
  "truncated": false
}
```

## 6. 工具四：`shell_session`

### 6.1 工具描述

建议注册描述：

> 管理当前 DSH 会话隔离的 PTY 终端。可以创建、列出、删除终端会话，也可以取消 PTY 命令或 single 后台任务。创建会话时只能引用配置中的 Shell profile；会话创建后 Shell、固定参数、工作目录和环境策略不可切换。取消默认优雅终止，传入 `force` 后可强制终止。响应最多返回 `{{max_return_bytes}}` bytes。

### 6.2 参数

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "string",
      "enum": ["create", "list", "delete", "cancel"],
      "description": "create 创建；list 列出；delete 删除；cancel 取消命令或 single 后台任务。"
    },
    "session_name": {
      "type": "string",
      "description": "目标或新建终端会话名。只允许 ASCII 字母、数字、_、-，长度 1-64。"
    },
    "shell_profile": {
      "type": "string",
      "description": "仅 create 使用。配置中的 Shell profile 名称。不能传入可执行文件路径或任意参数。"
    },
    "cwd": {
      "type": "string",
      "description": "仅 create 可选。初始工作目录，必须通过路径权限和工作目录白名单校验。"
    },
    "env": {
      "type": "object",
      "additionalProperties": {"type": "string"},
      "description": "仅 create 可选。额外环境变量，受变量名、数量、长度和敏感信息策略限制。"
    },
    "command_id": {
      "type": "string",
      "description": "仅 cancel 使用。PTY 会话内命令短 ID。与 task_id 二选一。"
    },
    "task_id": {
      "type": "string",
      "description": "仅 cancel 使用。single 后台任务 ID。与 session_name + command_id 二选一。"
    },
    "force": {
      "type": "boolean",
      "default": false,
      "description": "仅 cancel 使用。优雅终止失败或超过终止等待时间后是否强制终止进程树。"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "description": "仅 list 使用。最多返回多少个终端会话。"
    },
    "list_cursor": {
      "type": "string",
      "description": "仅 list 使用的分页游标。"
    }
  },
  "required": ["operation"],
  "additionalProperties": false
}
```

### 6.3 参数约束

- `create` 必须有 `session_name` 和 `shell_profile`，禁止 `command_id`、`task_id`、`force`。
- `list` 不接受具体会话或任务操作参数，只允许 `limit` 和 `list_cursor`。
- `delete` 必须有 `session_name`，删除会话后 PTY、命令历史和输出立即清理。
- `cancel` 必须满足以下二选一：
  - `session_name` + `command_id`，取消 PTY 命令；
  - `task_id`，取消 single 后台任务。
- `cancel` 不接受同时出现两类目标。
- `session_name` 在当前 DSH 会话内唯一；会话不存在、命令不存在或任务不存在时返回稳定错误。

### 6.4 返回结构

#### 创建

```json
{
  "operation": "create",
  "session_name": "build",
  "shell_profile": "pwsh-default",
  "status": "idle",
  "cwd": "E:\\DeepSeekHarness\\BetterShell"
}
```

#### 取消

```json
{
  "operation": "cancel",
  "target": {
    "session_name": "build",
    "command_id": "00A"
  },
  "status": "terminated",
  "force_used": false,
  "message": "命令已终止，终端会话仍保留。"
}
```

## 7. 公共返回和错误约定

### 7.1 返回长度

所有工具响应都必须先构造完整的结构化状态，再对文本字段截断；不能截断 JSON 结构、状态字段、ID、游标或错误代码。响应至少保留：

- 工具操作类型
- 状态
- 目标标识
- 错误代码（如果有）
- 截断标记
- 下一游标（如果有）

`output`、命令预览、错误说明和路径摘要可以截断。截断时返回 `truncated: true` 和实际返回长度。

### 7.2 错误代码

至少支持：

- `SHELL_NOT_ALLOWED`
- `SESSION_NAME_REQUIRED`
- `SESSION_NAME_DUPLICATE`
- `SESSION_NOT_FOUND`
- `SESSION_BUSY`
- `SESSION_CLOSED`
- `SESSION_START_FAILED`
- `COMMAND_START_FAILED`
- `COMMAND_NOT_FOUND`
- `INVALID_COMMAND_ID`
- `INVALID_CURSOR`
- `TASK_NOT_FOUND`
- `TASK_CANCELLED`
- `COMMAND_CANCELLED`
- `COMMAND_TIMEOUT`
- `TIMEOUT_LIMIT_EXCEEDED`
- `OUTPUT_LIMIT_EXCEEDED`
- `RESOURCE_LIMIT_EXCEEDED`
- `CONFIG_INVALID`
- `PERMISSION_CONFIRMATION_REQUIRED`
- `PERMISSION_DENIED`

`COMMAND_WAIT_DETACHED` 是正常状态代码，不是失败错误：它表示等待调用结束、命令已经转后台。

每个错误都应包含：

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "终端会话不存在，请先使用 shell_session create 创建会话。",
    "retryable": true
  }
}
```

## 8. 配置更新与工具描述

- 工具描述中的 `{{...}}` 占位符只在新建 Agent 会话或重新生成工具描述时替换。
- 已建立的 Agent 会话不能通过修改工具 schema 结构来更新上限。
- 配置文件或 WebUI 更新后，工具实现立即使用新上限做运行时校验。
- 更新后向上下文末尾注入配置提示，至少说明变化项、新上限、生效时间和已有 PTY 会话是否受影响。
- 已有终端会话的 Shell profile、固定启动参数、cwd 和初始环境不因配置热更新而隐式改变。
