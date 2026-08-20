# 持久级 Shell 插件实现研究

## 1. 结论

Windows-first 的最佳实现路径是创建一个独立的 Cordis 插件组合，通过 package manifest 声明依赖并复用 DSH 的工具、Agent 和后台任务能力；不修改 `@deepseek-ai/dsh-terminal`、`@deepseek-ai/dsh-subprocess-local` 或其他已安装插件：

1. 新增 `@gao-gao-zai/better-shell-terminal`，直接依赖 `node-pty` 并注册自有 `ctx.betterShell` service，创建由 profile 指定的 Windows ConPTY Shell 会话。
2. 新增 `@gao-gao-zai/better-shell-tools`，使用 `ctx.betterShell` 管理 PTY，使用现有 `ctx.shell`/`ctx.jobs` 管理 single 执行和后台通知。
3. Agent 只传 profile 名称；terminal service 从自己的白名单配置解析 executable、args、protocol、cwd 和 env policy。
4. `shell_write` 调用自有 service 的 raw `write()`，可以在命令仍 active 时向同一 PTY 写入，不受现有 `ctx.terminals.startSend()` 互斥模型限制。
5. 命令历史、游标和四工具参数校验属于 tool consumer 的 owner-local 状态；PTY、raw I/O、scrollback 和进程树属于 terminal service。
6. Windows 使用 `node-pty`/ConPTY；正常清理由 Cordis effect 等待，异常 DSH 退出由 Job Object `KILL_ON_JOB_CLOSE` 保证不会遗留子进程。

该方案复用 DSH 已有的 owner 生命周期、后台任务、配置和工具注册机制，同时把 Windows-specific PTY/Shell 细节限制在用户自己的插件内。它不修改、patch 或覆盖任何 `@deepseek-ai/*` 包。

v1 的持久范围固定为同一 DSH Agent/session 生命周期：PTY 跨工具调用持续存在；owner dispose 或 DSH 进程退出时终止。所有会话状态仅保存在进程内，不设计重启恢复、PTY 重连或跨 session 共享。

## 2. 当前 DSH 能力盘点

当前安装的 DSH `0.1.0-rc.7` 已经包含以下相关包：

- `@deepseek-ai/dsh-terminal`
- `@deepseek-ai/dsh-terminal-bash`
- `@deepseek-ai/dsh-subprocess`
- `@deepseek-ai/dsh-subprocess-local`
- `@deepseek-ai/dsh-tool-bash-persistent`
- `@deepseek-ai/dsh-tool-pwsh`
- `@deepseek-ai/dsh-pwsh-local`
- `@deepseek-ai/dsh-jobs-local`
- `@deepseek-ai/dsh-tool-jobs`

本地证据：

- `dsh-terminal` 在 `ctx.terminals` 中负责 owner-scoped session ID、后端注册、发送互斥、scrollback 和完整清理：
  `C:\Users\10403\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-terminal\lib\types\index.d.ts`
- `dsh-terminal-bash` 已经实现了 prompt readiness、OSC 133;D、ANSI 分片解析、UTF-8、bounded scrollback 和会话清理：
  `C:\Users\10403\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-terminal-bash\lib\index.js`
- `dsh-subprocess-local` 已经通过 `node-pty@1.2.0-beta.15` 实现终端进程原语，并在 Windows 使用 `taskkill /PID <pid> /T /F`：
  `C:\Users\10403\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-subprocess-local\README.zh.md`
- `dsh-tool-bash-persistent` 已经展示了 owner 缓存、异步 cleanup、随机完成标记和持久 shell 命令封装：
  `C:\Users\10403\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tool-bash-persistent\lib\index.js`
- `dsh-tool-pwsh` 已经展示了 `ctx.tools.register(defineTool(...))`、`ctx.systemPrompt.section(...)`、`ctx.shell` 和 `ctx.jobs` 的模型工具接入方式。

但现有实现不能直接满足本需求：

- `dsh-tool-bash-persistent` 只有一个自动创建的 Bash shell，超时会重置 shell，不支持显式 session、四工具拆分或 Windows PowerShell。
- `dsh-terminal-bash` 的配置是 Bash 命令和 Bash prompt 语义。
- `TerminalSpawnRequest` 当前只有 `type/name/cwd`，不能承载本插件的 profile/protocol 配置。
- `TerminalBackendSession` 当前没有 active command 期间的公开 raw `write()`；这正是 terminal 包注册自有 `ctx.betterShell` service、而不建立在 `ctx.terminals` 上的原因。
- 当前本地 PTY 前台进程检查器支持 Linux/macOS，Windows 不能依赖 POSIX foreground process group 语义。

## 3. 推荐包分层

### 3.0 包边界和依赖声明

实现拆成两个新包，均作为 profile 的树外依赖安装；不修改任何已安装 DSH 包：

- `@gao-gao-zai/better-shell-terminal`：注册自有 `ctx.betterShell` service，直接拥有 `node-pty`、PTY 会话和 raw I/O，不注册模型工具。
- `@gao-gao-zai/better-shell-tools`：只提供四个模型工具和 owner-local 命令状态，通过 service API 使用 terminal 包，不直接导入 `node-pty`。

建议 `@gao-gao-zai/better-shell-terminal/package.json`：

```json
{
  "name": "@gao-gao-zai/better-shell-terminal",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "node-pty": "1.2.0-beta.15"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "^0.1.0-rc.7"
  }
}
```

建议 `@gao-gao-zai/better-shell-tools/package.json`：

```json
{
  "name": "@gao-gao-zai/better-shell-tools",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "peerDependencies": {
    "@gao-gao-zai/better-shell-terminal": "^0.1.0",
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-jobs": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-shell": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-timeout": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.7"
  }
}
```

依赖规则：

- `peerDependencies` 声明 DSH runtime seam，避免插件私自加载第二份 Cordis 或第二份 service registry；
- `@gao-gao-zai/better-shell-terminal` 的 `node-pty` 是其直接运行时依赖，负责真正的 ConPTY/PTY I/O；
- `@gao-gao-zai/better-shell-tools` 通过 `@gao-gao-zai/better-shell-terminal` 的 peer service 使用 PTY，不重复声明或 import `node-pty`；
- Job Object 原生 helper 若以后加入，应作为 terminal 包的可选依赖或独立可选包声明，不修改 `dsh-subprocess-local`；
- profile 目录的 `package.json` 明确声明两个新插件，`dsh.profile.bundles` 明确声明其加载顺序；
- 版本范围必须与当前 DSH rc 版本兼容，安装时由 pnpm 解析，运行时由 Cordis 注入校验；
- 不通过 `patch` 覆盖现有包源码，不通过 postinstall 修改现有插件文件。

profile 依赖示例：

```json
{
  "dependencies": {
    "@gao-gao-zai/better-shell-terminal": "^0.1.0",
    "@gao-gao-zai/better-shell-tools": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@gao-gao-zai/better-shell-terminal",
        "@gao-gao-zai/better-shell-tools"
      ]
    }
  }
}
```

如果当前 profile manifest 使用 `dsh.profile` 而不是 `package.json.dsh.profile`，应按现有 DSH profile 模板将同样的 bundle 列表写入 `dsh.profile`，不要修改安装目录下的基础 bundle。

### 3.1 自有 `ctx.betterShell` service

terminal 包注册一个独立 Cordis service，不覆盖 `ctx.terminals`：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    betterShell: BetterShellService;
  }
}

interface BetterShellService {
  create(owner: Agent, request: CreateSessionRequest): Promise<SessionSnapshot>;
  list(owner: Agent): SessionSnapshot[];
  execute(owner: Agent, sessionId: SessionId, request: ExecuteRequest): CommandOperation;
  write(owner: Agent, sessionId: SessionId, input: TerminalInput): Promise<WriteResult>;
  read(owner: Agent, sessionId: SessionId, request: ReadRequest): ReadResult;
  cancel(owner: Agent, sessionId: SessionId, force: boolean): Promise<CancelResult>;
  close(owner: Agent, sessionId: SessionId, reason: string): Promise<void>;
}
```

service 必须验证精确 owner 身份，不能只比较可复用的字符串 session ID。每个 owner 的第一个会话在其 Cordis scope 上安装 awaited cleanup effect；owner dispose 会关闭其全部 PTY，但不影响其他 owner。

`write()` 直接进入同一 `node-pty` handle 的串行写队列，因此可以在命令仍 active 时发送文本、Enter、Ctrl-C、Ctrl-D、Esc、Tab 和 Backspace。写入失败、关闭竞态和超时必须返回稳定结果；不能创建第二个 PTY，也不能把写入误记为新命令。

配置中的 profile key 由 service 解析。Agent 和 tools 包都不能传 executable 或启动参数；service 根据 profile 白名单得到 Shell 类型、executable、固定 args、protocol、cwd policy 和 env policy。

### 3.2 `@gao-gao-zai/better-shell-terminal`：Windows PTY service provider

参考 `dsh-terminal-bash` 的输出处理思路，但拥有独立实现，不复制或 patch 官方包：

- `service.ts`：注册 `ctx.betterShell`、owner 授权、session registry 和 awaited cleanup。
- `config.ts`：Shell profiles、默认 rows/cols、scrollback、poll、idle、hard timeout、dispose grace。
- `profile.ts`：白名单 profile 解析和 executable/args/protocol/cwd/env 策略。
- `session.ts`：直接使用 `node-pty` 创建 PTY，负责 raw write、resize、close、状态和 scrollback。
- `protocols/`：按 Shell 类型初始化命令包装、完成 marker 和 readiness；PowerShell、cmd 和 raw/交互式 Shell 使用不同 adapter。
- `sanitize.ts`：跨 chunk 的 UTF-8/ANSI/OSC 处理。
- `job-object.ts`：Windows Job Object 所有权和退出清理；不可用时显式降级并报告。

创建调用只传白名单 profile key：

```ts
ctx.betterShell.create(owner, {
  name: 'build',
  profile: 'pwsh7',
  cwd: 'C:\\workspace'
});
```

service 内部解析 profile。配置热更新只影响新会话，并且不得改写已有会话的 Shell、args、cwd 或初始环境。

### 3.3 `@gao-gao-zai/better-shell-tools`：四工具 consumer

工具层维护 owner-local 状态：

```ts
type OwnerState = {
  sessions: Map<string, SessionState>;
  tasks: Map<string, SingleTaskState>;
};

type SessionState = {
  terminalId: TerminalSessionId;
  profile: string;
  commands: Map<string, CommandRecord>;
  nextCommandSequence: number;
};
```

使用 `WeakMap<Agent, OwnerState>` 或绑定 Agent scope 的 effect，session name 只在 owner 内唯一。PTY 后端只知道不透明的 terminal ID，不持有模型命令历史。

四个工具的职责严格保持：

- `shell_execute`：single 通过 `ctx.shell.run/start`；PTY 通过 `ctx.betterShell.execute`。
- `shell_write`：通过 `ctx.betterShell.write` 写入同一 PTY，即使命令仍 active 也可写入；不能创建第二个会话。
- `shell_read`：通过 `ctx.betterShell.read` 获取输出，同时由 tools 层维护命令记录和绑定游标。
- `shell_session`：通过 `ctx.betterShell.create/list/close/cancel` 管理会话和任务。

PTY command record 需要唯一的后台 pump：terminal service 的输出事件或读取器只能由 pump 消费，tools 层将增量写入 bounded command buffer；工具读取和 job notifier 都只读该 buffer 的非消费式快照或绑定游标。

## 4. PowerShell PTY 协议

### 4.1 启动

profile 至少保存：

- `executable`
- 固定 `args`
- `allowPty`
- 是否允许用户 cwd
- 是否允许额外 env
- 可选平台/版本约束

PowerShell 7 建议默认参数：

```text
-NoLogo -NoProfile -NoExit
```

不要让 Agent 直接传任意 executable 或固定 args。`shell_session create` 只传 profile 名称，后端从已解析配置取实际 argv。

初始化脚本负责：

- 固定 `[Console]::OutputEncoding` 和 `$OutputEncoding` 为 UTF-8；
- 关闭或约束 PSReadLine，避免历史保存、额外 ANSI 和输入回显干扰协议；
- 设置受控 `prompt`；
- 禁用 pager/color 等会破坏模型输出的默认行为；
- 写入一个可验证的初始化完成标记。

### 4.2 就绪检测

PowerShell 没有 Bash 的 `PROMPT_COMMAND`。应在 `prompt` 函数内发出 OSC 133;D 和固定提示符：

```powershell
function global:prompt {
  [Console]::Write("`e]133;D`a")
  return "dsh> "
}
```

实际实现必须用单独 nonce 和严格的 prompt 尾部验证，不能只等待静默：

- marker 和 prompt 可能跨多个 `onData` chunk；
- 忽略旧命令的 prompt；
- 只有最新 command marker 后面的精确 `dsh> ` 才能结束本次 send；
- 保留不完整的 OSC/CSI 序列，超过上限时进入 discard mode；
- 正常输出、命令回显、Shell prompt 和控制序列必须分开记录。

### 4.3 命令完成标记

命令应使用 UTF-8 Base64 或等价无歧义编码注入，避免 Agent 命令中的引号、换行和 PowerShell 语法破坏包装器。推荐语义：

```powershell
$__dsh_code = 0
$__dsh_success = $false
try {
  . ([ScriptBlock]::Create(
    [Text.Encoding]::UTF8.GetString(
      [Convert]::FromBase64String('<command>'))))
  $__dsh_success = $?
  $__dsh_code = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } elseif ($__dsh_success) { 0 } else { 1 }
} catch {
  $__dsh_code = 1
  Write-Error $_
}
[Console]::WriteLine('__DSH_END_<command-id>:' + $__dsh_code)
```

关键点：使用 dot-sourcing 保留 `Set-Location`、变量和环境状态；不能简单使用 `&`，否则命令在子作用域中运行，持久 cwd/env 会失效。`exit`、终止 Shell 或命令自行重置 prompt 必须作为会话退出/协议失败处理。

命令包装器不应依赖用户可覆盖的函数或环境变量。marker nonce、command ID 和固定 prompt 必须由插件生成并在每次命令中唯一。

### 4.4 PSReadLine

PSReadLine 是首个 Windows 集成测试重点。v1 建议在受控 PTY profile 中移除或禁用它，因为 Agent 已经提供完整命令文本，不需要行编辑器。若保留，必须验证：

- PSReadLine 的回显不会进入命令输出；
- Ctrl-C、Ctrl-D、退格和控制序列不会污染 marker parser；
- 历史文件不会写入敏感命令；
- 不同 PowerShell 版本加载行为一致。

## 5. Windows PTY 和终止策略

### 5.1 推荐库

首选 `node-pty`，原因：

- DSH 当前 `@deepseek-ai/dsh-subprocess-local` 已经使用它；
- Microsoft 维护；
- Windows 1809/build 18309+ 通过 ConPTY；
- 暴露 `spawn`、`write`、`resize`、`kill` 和 `onData`，足够构建 backend；
- DSH 已有 native addon 的打包和 postinstall 路径。

不建议引入第二个 PTY npm wrapper。`@homebridge/node-pty-prebuilt-multiarch` 等预构建 fork 可以降低用户本机编译成本，但会造成 ABI、Node/Electron 版本、更新滞后和安全供应链重复，除非 DSH 的发布渠道明确需要，否则不作为首选。

### 5.2 ConPTY 限制

`node-pty` 的 Windows 支持依赖 ConPTY；最低目标为 Windows 10 1809 级别。应在 spawn 前检查平台和失败类型，给出可诊断的 `PTY_UNAVAILABLE`，不要把它伪装成 Shell 命令失败。

ConPTY 是终端流，不是结构化进程协议：

- stdout/stderr 已合并；
- 控制序列可能被拆 chunk；
- 全屏备用缓冲区、颜色、光标和回显都可能出现在流中；
- PTY 不能可靠地给出每个前台子进程的退出码，因此退出码必须由包装器 marker 提供；
- window resize 必须传播，否则交互 CLI 的换行和布局会错误。

### 5.3 终止优先级

v1 先复用 DSH `dsh-subprocess-local`：Windows 使用 `taskkill /PID <pid> /T /F`，并等待可观察进程树停稳。它比 `tree-kill` 额外手写一套实现更一致，但属于尽力而为：脱离进程树的 daemon 仍可能存活。

生产强化阶段推荐增加 Windows Job Object helper：

- 创建 Job Object；
- 将 PTY root/可观察子进程纳入 Job；
- 设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；
- 优雅取消时先写入/发送控制信号，再等待 grace；
- 超时或 force 时调用 `TerminateJobObject`；
- 仍保留 `taskkill` 作为 Job Object 不可用时的 fallback。

Job Object helper 应该是小型 N-API/WASM 之外的原生模块，并为 Node ABI 提供可验证的预构建包；不建议在 TypeScript 中模拟进程树扫描作为最终方案。

## 6. 单次执行与 PTY 执行的统一方式

single 不需要 PTY：

- PowerShell single 继续使用 `@deepseek-ai/dsh-pwsh-local` / `ctx.shell`；
- `run` 对接 wait 语义；
- `start` 适配 `ctx.jobs`；
- `ctx.jobs` 负责 owner、job ID、取消、完成通知和 dispose；
- 不重复实现 stdout/stderr、spill 和 task lifecycle。

PTY 命令不直接套用 `ctx.shell`，因为 `ctx.shell` 没有运行中 stdin 和终端会话概念。PTY 通过 `ctx.betterShell` 执行和写入；后台完成通知仍适配到 `ctx.jobs`。

等待模型建议：

- 工具调用自己的 `wait_timeout_ms` 只控制当前工具响应；
- PTY command pump 持续运行；
- wait 到期将 command 保持为 running/background；
- `background_timeout_ms` 和 `max_runtime_ms` 在 command record 中由工具层计时；
- `shell_write` 成功后只重置活动计时，不重置绝对边界；
- command 完成时由唯一 owner-context 通知器提交最终摘要。

## 7. 配置与安全

配置层建议分为：

```yaml
shell:
  profiles:
    pwsh7:
      executable: C:\\Program Files\\PowerShell\\7\\pwsh.exe
      args: [-NoLogo, -NoProfile, -NoExit]
      allowPty: true
      cwdPolicy: session-workspace
      envPolicy: safe-overlay
    cmd:
      executable: C:\\Windows\\System32\\cmd.exe
      args: [/Q]
      allowPty: true
```

实现规则：

- 配置路径和固定参数只由配置文件/WebUI 写入；Agent 只能传 profile 名称；
- profile 的 executable 必须是绝对路径或受控解析结果；
- profile 创建和更新时验证 `allowPty`、参数长度、环境策略和平台；
- cwd 通过已有 DSH session/sandbox policy 解析，不能直接绕过 workspace root；
- 额外环境默认关闭，开启时只允许显式、安全 overlay；
- 继承环境必须复用 DSH 的 credential scrub 和 `DSH_*` 管理规则；
- permission/confirmation 仍在工具层执行，PTY profile 白名单始终生效；
- 配置更新影响新会话，新会话不改变已存在 PTY 的 executable、args、cwd 和环境；
- 对原生 node addon 和 Job Object helper 做版本、架构和签名/完整性验证。

## 8. 测试计划

### P0 协议单元测试

- marker 和 prompt 被拆成任意 chunk；
- UTF-8 多字节字符被拆分；
- OSC/CSI 被拆分或超过 pending buffer；
- 命令含引号、反引号、换行、中文、PowerShell here-string；
- `Set-Location`、`$env:X`、函数和后台任务跨命令保留；
- `exit`、Shell 崩溃和 marker 丢失；
- prompt 被命令覆盖后仍能恢复或明确失败；
- PSReadLine 开启/关闭行为。

### P0 Windows 集成测试

- PowerShell 7 和 Windows PowerShell 5.1；
- Windows 10 1809、Windows 11；
- `cmd.exe` profile（若 profile 设计支持通用 Shell）；
- ConPTY spawn、write、resize、close；
- Ctrl-C、Ctrl-D、force cancel；
- 子进程、管道、交互式安装器和 REPL；
- 进程树终止和后台 daemon 的已知边界；
- Agent dispose、插件 reload 和 harness shutdown 清理。

### P0 工具契约测试

- session name/profile 白名单和 owner 隔离；
- PTY 单并发命令和 `shell_write` 并发写入；
- full/incremental cursor 绑定、失效和输出截断；
- wait 到期转后台而不是误杀；
- 活动超时和绝对最长运行时间分别结算；
- single 使用 `task_id`，PTY 使用 `session_name + command_id`；
- `ctx.jobs` 完成通知只投递一次；
- schema cache 不因配置热更新而改变，运行时上限仍即时生效。

## 9. 实施优先级

### P0

1. 实现独立 `@gao-gao-zai/better-shell-terminal`：profile 映射、Shell-specific prompt、marker、scrollback、raw write、命令 readiness、Job Object 和 session lifecycle；只依赖 DSH 的 Cordis/Agent 基础，不修改 DSH PTY 插件。
2. 实现独立 `@gao-gao-zai/better-shell-tools`：四工具、owner 状态、命令 pump、PTY service 调用和 wait/background 语义。
3. 在 profile `package.json` 和 `dsh.profile` 中声明两个新 bundle 及其版本依赖。
4. 建立 Windows CI/integration test matrix，覆盖 ConPTY、PowerShell 7/5.1、cmd.exe、交互输入和清理。
5. 对异常 DSH 进程退出验证 Job Object kill-on-close；不能用仅在 JavaScript 仍可运行时才触发的 cleanup 代替它。

### P1

- PTY resize 工具参数；
- PowerShell 5.1 兼容性和 profile 迁移；
- 配置 WebUI；
- 完整输出 spill 和持久命令历史诊断；
- 多种 Shell profile 的通用 wrapper。

### P2

- 远程 PTY backend；
- 多观察者 output stream；
- 全屏 TUI/终端模拟器级输出模型。

明确不规划跨 DSH 进程重启恢复 PTY。进程退出意味着所有会话终止；后续启动创建全新状态。

## 10. 外部证据

- [Microsoft node-pty](https://github.com/microsoft/node-pty)：Microsoft 维护的 Node PTY bindings；Windows 使用 ConPTY。
- [node-pty README](https://github.com/microsoft/node-pty#readme)：Windows 1809/build 18309+、native build、权限和线程安全注意事项。
- [Microsoft ConPTY: Creating a pseudoconsole session](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)：Windows Pseudo Console 的官方 API 和生命周期说明。
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)：Windows 进程组管理、限制和 kill-on-job-close 能力。
- [VS Code Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration)：OSC 133 shell integration 标记约定，包含 PowerShell prompt 集成方向。
- [tree-kill](https://github.com/pkrumins/node-tree-kill)：Windows `taskkill /T /F` 的第三方封装，可作对比，不建议替代 DSH 现有 subprocess seam。

## 11. 语法检查和测试工具链

当前环境证据：Node.js `v24.19.0`、pnpm `11.22.0`；已安装 DSH 包中可见 TypeScript `^6.0.3`、Vitest `^4.1.8`、Playwright `^1.49.0` 和 tsx `^4.19.2`。因此 Vitest 4/tsx 4 与当前生态一致；项目仍应通过 lockfile 固定实际解析版本，并单独验证 `node-pty` native addon 对 Node 24 ABI 的安装和运行。

### 12.1 推荐基线

项目采用 TypeScript ESM，推荐一套工具链，不同时维护 ESLint/Jest/Biome 等多套重复体系：

- `typescript`：编译、语法和类型检查的最终门禁，使用 `tsc --noEmit`。
- `eslint` + `typescript-eslint`：启用 type-aware 规则，检查浮空 Promise、错误 await、危险 any、资源未处理等问题。
- `prettier`：仅负责格式化；不承担代码正确性判断。
- `vitest`：单元、组件、Cordis service 和 Windows PTY 集成测试。
- `@vitest/coverage-v8`：使用 V8 原生覆盖率，不再额外安装 Istanbul/nyc。
- `tsx`：仅用于一次性开发脚本和测试探针，不作为生产运行入口。
- `publint`：检查两个 npm 包的 exports、main、types 和发布文件。
- `@arethetypeswrong/cli`：检查 ESM 包的类型声明和 Node 模块解析结果。

建议开发依赖：

```json
{
  "devDependencies": {
    "@arethetypeswrong/cli": "^0.18.0",
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^4.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.0.0",
    "publint": "^0.3.0",
    "tsx": "^4.0.0",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.0.0"
  }
}
```

这些是兼容范围示例，不应在未运行安装测试前视为最终锁定版本。创建项目时由 pnpm 生成并提交 lockfile；CI 和发布必须使用 `pnpm install --frozen-lockfile`。如果目标 DSH 发布版本对 Node/TypeScript 有更窄要求，以它的 `engines`、peer range 和实际 loader smoke test 为准。

### 12.2 不推荐作为默认项

- Jest 可以使用，但不推荐：项目是原生 ESM，Vitest 与 TypeScript/ESM 配置更直接，也与当前 DSH 仓库的测试生态更接近。
- Biome 可以替代 ESLint + Prettier，但首版不推荐混装。PTY 生命周期代码需要 type-aware lint，ESLint + typescript-eslint 的检查面更完整。
- Mocha 可以测试 `node-pty`，但会重复搭建断言、mock、coverage 和 TypeScript loader。
- Playwright 不用于后端 PTY 测试；只有实现配置 WebUI 后，才安装 `@playwright/test` 做浏览器端到端测试。
- `nyc`/`c8` 不与 `@vitest/coverage-v8` 同时安装。
- ESLint 和 Prettier 不配置相互冲突的格式规则；ESLint 管正确性，Prettier 管排版。

### 12.3 可选专项检查器

- PowerShell adapter 含独立 `.ps1` 文件时，在 Windows CI 安装并运行 `PSScriptAnalyzer` 的 `Invoke-ScriptAnalyzer`。
- 后续增加 Bash adapter 时使用 `shellcheck` 检查 `.sh` 初始化脚本。
- 配置 WebUI 加入后使用 `@playwright/test`；如果只测试纯 UI 组件，可在 Vitest 中增加 `jsdom`，但不要让 Node PTY 测试进入 jsdom 环境。
- 对公共 TypeScript 类型做编译期契约测试时，优先使用 Vitest 的 `expectTypeOf`；只有需要独立 npm 消费者类型测试时再增加 `tsd`。
- 可增加 `knip` 检查未使用文件、exports 和依赖，但 native helper、Cordis 动态加载及 bundle manifest 必须配置显式 entry，避免误报后直接删除运行时入口。
- Job Object 使用 N-API helper 时增加 `node-addon-api`、`node-gyp` 和预构建发布工具；该原生包应有独立的 ABI/架构测试矩阵，不与普通 TypeScript 单测混为一个 job。

### 12.4 推荐脚本

仓库根 `package.json` 建议：

```json
{
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "lint": "eslint . --max-warnings 0",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run --exclude '**/*.integration.test.ts'",
    "test:coverage": "vitest run --coverage --exclude '**/*.integration.test.ts'",
    "test:integration:windows": "vitest run --config vitest.integration.config.ts",
    "check:packages": "pnpm -r exec publint && pnpm -r exec attw --pack",
    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  }
}
```

`attw` 命令来自 `@arethetypeswrong/cli`。`typecheck` 可与 `build` 共享 TypeScript project references；如果 build 会写入 `lib/`，CI 应先 typecheck/test，再 build/package check，避免旧产物掩盖源码错误。

### 12.5 测试分层

#### 纯单元测试

不启动真实 PTY，任何平台均可运行：

- profile/schema 校验；
- command/task/short ID 生成；
- UTF-8 字节裁剪；
- full/incremental cursor；
- ANSI/OSC 跨 chunk parser；
- PowerShell、cmd wrapper 和 marker parser；
- 活动超时、绝对超时和 write 后 timer reset；
- 状态机和错误映射。

使用 Vitest fake timers 测计时，不在测试中真实等待 30 秒。

#### Service 测试

使用 fake PTY adapter，而不是 mock `node-pty` 的内部实现：

- owner 隔离；
- create/write/read/cancel/close；
- active command 期间 raw write；
- 并发写队列顺序；
- owner dispose 等待清理；
- tools 插件对 `ctx.betterShell`、`ctx.shell` 和 `ctx.jobs` 的适配；
- 配置更新只影响新会话。

生产 service 构造器应接受内部 `PtyFactory` 接口；默认实现包装 `node-pty`，测试实现由内存 fake 提供。这比 Vitest module mock 更稳定，也避免 native addon 在普通单测进程中加载。

#### Windows PTY 集成测试

只在真实 Windows runner 上串行执行，不使用 fake：

- `node-pty`/ConPTY 创建、输出、raw write、resize 和关闭；
- PowerShell 7、Windows PowerShell 5.1 和 cmd.exe profiles；
- cwd/env/function 状态跨工具调用持续；
- 中文及拆分 UTF-8、ANSI/OSC、PSReadLine；
- 交互提示、Ctrl-C/Ctrl-D/Esc；
- 管道和子进程树；
- Agent/session dispose；
- DSH 正常退出；
- Job Object helper 进程被强制结束后，PTY 子进程没有遗留。

集成测试必须使用独立 helper 子进程承载插件。验证 Job Object 时由父测试强制终止 helper，再通过 PID/进程身份检查子进程消失；不能在 Vitest 主进程中自杀。每个测试使用唯一临时目录、session 名和 marker，失败时记录有界诊断，不保存敏感命令环境。

#### 包和安装测试

- 对打包后的 tarball 运行 `publint` 和 `attw --pack`；
- 在空 profile 中安装两个 tarball，验证 peer dependency 和 Cordis 注入；
- 执行 DSH loader smoke test，确认 bundle 顺序和 service 可用；
- Windows x64/arm64（若发布）分别验证 `node-pty` 与 Job Object native artifact；
- 使用不受源码路径影响的临时目录测试，防止测试误用 workspace 文件。

### 12.6 CI 门禁

每个提交必须通过：

1. `format:check`
2. `lint`
3. `typecheck`
4. 非 Windows 单元/service 测试
5. Windows 单元/service/PTY 集成测试
6. coverage 门禁
7. build
8. tarball package checks
9. 临时 DSH profile 安装和 loader smoke test

初始覆盖率建议按高风险核心设置，而不是全仓库追求同一数字：状态机、cursor、parser、timeout 和 profile validation 的 branch coverage 至少 90%；Cordis 接线和平台错误分支可单独设较低阈值，但必须有 Windows 集成测试覆盖。任何 coverage 排除项都要写明原因，不能排除难测的 lifecycle 代码来满足数字。

## 12. 风险与未决项

- ConPTY 输出和 OSC 133 在目标 Windows/PowerShell 版本中的组合行为必须通过真实 Windows CI 验证，不能只依赖 Linux 单元测试。
- PowerShell prompt 可能被用户命令、模块或 PSReadLine 改写；后端需要明确恢复策略。
- `LASTEXITCODE`、`$?`、terminating error 和 native child exit code 的组合语义需要固定测试矩阵。
- Job Object 对已处于其他 Job 的进程、breakaway、第三方安装器和后台 daemon 有平台限制。
- `node-pty` 是 native addon，Node ABI、pnpm 依赖布局和 Windows 发布包需要单独验证。
- 当前 DSH 的 `TerminalSignal` 词汇偏 POSIX；Windows 取消应先增加显式 control/write 语义，再决定是否扩展通用 signal 枚举。
