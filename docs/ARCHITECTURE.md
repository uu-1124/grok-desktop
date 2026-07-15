# Architecture

## 目标

把 Grok CLI 已经提供的编码智能体能力安全地映射为 Windows 桌面工作流，同时保持
Grok 的升级、配置和会话存储边界不变。桌面结构化连接只接受用户显式提供的兼容 API
Base URL 与 API Key，不读取或继承 Grok CLI 的身份凭据。

## 进程与数据流

```text
React renderer (sandboxed)
        │ typed, allow-listed IPC
        ▼
Electron main process
  ├─ Grok discovery and settings
  ├─ ACP runtime supervisor ── stdio/JSON-RPC ── grok agent stdio
  └─ PTY compatibility host ── Windows ConPTY ── grok TUI
```

### Renderer

- 只负责视图状态、输入和结构化事件渲染。
- 不拥有 Node.js、文件系统、子进程或通用 IPC 能力。
- 对未知 ACP 更新使用兼容展示，不把未知字段解释为可执行指令。
- ACP `TimelineItem[]` 保留消息、Thought、工具和计划的原始顺序；Codex 风格的“执行过程”
  只由 Renderer 展示投影聚合连续执行项，不回写协议状态，也不吞掉工具结果。计划项按回合保存
  快照并绑定 Grok 返回的 `planId`，陈旧删除通知不能清除当前计划。
- Grok 文本只渲染受控 Markdown 子集，不执行原始 HTML，也不加载远程图片。可点击外链只接受
  HTTPS，并继续通过 typed preload 请求 Main 使用本机 Google Chrome 打开。

### Preload

- 通过 `contextBridge` 暴露 `DesktopApi` 中列出的精确方法。
- 不直接暴露 `ipcRenderer`、事件对象或任意通道调用。
- 所有订阅回调只接收经过主进程构造的可序列化数据。

### Main process

- 直接启动经过验证的 `grok.exe`，不通过 shell 拼接命令。
- 验证来自渲染进程的路径、尺寸、字符串长度和权限响应。
- 单实例管理 ACP 和 PTY 生命周期；窗口关闭时清理子进程与待处理审批。
- 使用原子替换保存非敏感设置，不读取 Grok 的凭据或会话正文。

### ACP runtime

- 启动参数：`grok agent [options] stdio`，当前首选 stdio，不开放本地端口。
- 桌面端显式使用 `--no-leader` 启动独立 Agent，确保本次连接选择的 API Base URL、
  内存态 API Key、模型和权限模式不会被已有共享 Leader 的配置替代。
- 权限偏好保存为 `default | auto | always_approve`。启动时分别映射到 Grok 原生
  `default`、`auto` 和 `bypassPermissions + --always-approve`；旧设置或未知值安全回退
  `default`，不会由桌面端自行判断工具风险。
- 生命周期：`initialize → session/new|session/load → session/prompt → updates`。
- “新任务”先进入 Renderer 的工作区草稿态，第一次实际发送时才调用 `session/new`，避免
  仅浏览或误触就制造空 Grok 会话。若 Grok 尚未返回标题，Renderer 只提交固定分类式临时
  标题，最多附加用户明确选择的上下文文件名，不复制 Prompt 正文。后续
  `session_info_update` 或 `x.ai/sessionDetail.title` 始终覆盖该临时标题。
- 最近任务列表只是桌面端保存的非敏感便利元数据。用户可以把未被当前 Grok 进程加载、
  且未执行的历史任务从桌面端列表移除；该操作只原子删除 `recentSessions` 条目，不调用
  `session/delete`，不删除、修改或定位 Grok 原始会话文件。当前进程已加载的任务会被
  Main 拒绝移除，避免 Renderer 重载或后续会话更新把记录无提示地重新加入列表。
- 基于 `initialize` 返回做能力发现，不静态假定模型、模式或扩展方法存在。主进程把
  `agentCapabilities` 归一化为固定布尔 DTO；标准布尔只接受显式 `true`，session
  lifecycle 逐项验证 `{}` marker。未知 capability 与任意 `_meta` 不跨 preload。
- Grok 0.2.101 会在 `agentCapabilities._meta` 广告 `x.ai/fs_notify: true`，但公开文档与
  当前 TypeScript SDK 未定义该私有通知的参数结构和可靠语义。桌面端目前只暴露能力布尔
  值，不猜测 payload、不启动工作区 watcher；获得 xAI 的明确契约后再通过 SDK 的
  `agent.notify(...)` 接入。
- 产品界面不提供 Grok 登录入口，也不调用 ACP `authenticate`。Agent 返回的认证元数据不会
  被解释为登录 UI 或连接回退；结构化连接缺少 URL 或 Key 时直接拒绝连接。
- Prompt 文件上下文只接受用户从当前工作区选择的普通文件；主进程使用 canonical path
  再验证工作区边界。Agent 广告 `embeddedContext` 时仅内嵌有界 UTF-8 文本，其他文件
  使用 ACP ResourceLink，不把正文返回 Renderer 或写入设置。
- 每次结构化连接必须显式提供 API Base URL 与 API Key。远程地址只接受 HTTPS，HTTP 仅接受
  回环主机；禁止 URL credentials、query 和 fragment。Base URL 是唯一持久化的连接字段，
  API Key 通过子进程环境副本传给本次独立 Grok Agent，不进入快照、事件或设置。
- 地址检测通过短生命周期 Grok ACP Runtime 完成，Renderer 和 Main 不直接请求第三方
  `/models`。候选始终保持协议、主机、端口和 Origin 不变：根路径依次尝试 `/v1` 与原地址，
  非版本路径依次尝试原地址与其 `/v1` 子路径，已以版本段结尾的路径只尝试原地址。只有成功
  完成 ACP 初始化的候选才能返回解析后的 Base URL 和该连接广告的模型。
- 创建 Grok 子进程时按 Windows 不区分大小写的环境变量语义清除继承的 API Key、旧 Key
  别名、模型 Base URL 与模型列表覆盖，再通过参数和 `GROK_MODELS_BASE_URL` 把 Agent 与模型
  管理器绑定到同一个显式端点；用户 Key 只写入该子进程环境副本。
- Runtime 快照只额外暴露规范化 Base URL 和“当前进程是否显式配置 API Key”的布尔值，
  从不回传 Key 原文。Renderer 重载后若无法恢复内存 Key，会阻止同 Origin 的静默重连并
  要求用户重新输入；切换到其他 Origin 时不会沿用旧凭据。
- 对话 Composer 只从 Runtime 非敏感快照展示当前 API host 和“内存 Key”存在状态，点击可
  返回连接设置；它不展示、复制或持久化 Key 原文。
- 设置页的模型目录来自当前 URL + Key 成功连接后的 ACP 响应；编辑 URL 或 Key 会使旧目录
  立即失效。用户可以在进程内启用多个模型并选择初始模型；正式连接前由独立短生命周期
  Runtime 针对同一 URL + Key 重新验证选择，验证失败不会触碰当前长期 Runtime。Composer
  切换模型时，若 Agent 提供可写会话模型配置则调用 `session/set_config_option`；只读或进程级
  模型通过带 `--model=<id>` 的独立 Agent 重连生效。权限切换、终端返回与普通重连会继续携带
  当前仍启用的模型及其匹配思考强度。
- ACP 广告的模型 ID、名称、描述与思考强度在进入 Runtime 快照或进程参数前检查凭据反射；
  任何包含本次 API Key 原文、JSON 转义或 URL 编码变体的控制值都会使连接安全失败。
- `modelState.availableModels[*]._meta.reasoningEfforts` 仅在 Grok 明确广告时才被归一化为
  Renderer DTO。选择值必须同时属于同一 `grok.exe` 和同一广告模型，并通过绑定的
  `--reasoning-effort=<value>` 参数启动；模型目录、启用选择与思考强度均不写入设置，也不接受
  任意自定义值。
- MCP 配置只接受 Grok 在 `initialize` 中显式广告的 HTTP/SSE/stdio 传输。Main 在初始化
  后做权威 capability gate，再把内存态配置的独立副本传给 `session/new` 和
  `session/load`；未广告的传输与 MCP-over-ACP 不进入产品接口。
- stdio MCP 是显式本地执行边界：只接受每次连接和会话创建前重新 `realpath/stat` 的本机
  `.exe`，参数始终保持数组且不经过 shell；UNC、设备路径与脚本文件被拒绝。Renderer 勾选
  只构成产品意图，Main 仍要求 literal consent 并显示 Electron 原生警告，默认按钮为取消；
  单个工作区最多配置 8 个 stdio 服务器。映射网络盘和文件验证至 Grok 真正启动之间的
  TOCTOU 仍属于本机信任边界，当前不宣称签名、哈希绑定或 OS 沙箱保证。
- Grok 0.2.101 会把自身环境继承给 stdio MCP。Main 因此以本次真实 `launch.env` 的名称集合
  为权威，为未显式配置且不属于最小运行 allow-list 的变量生成同名空覆盖，并固定覆盖
  `XAI_API_KEY` 与 `GROK_CODE_XAI_API_KEY`。Runtime 只保留环境变量名称 mask，不复制父环境值；
  用户显式配置的 env 名称和值、命令和参数进入内存脱敏集合，断连后与 MCP 配置一起清除。
  这项 mask 只作用于桌面端通过 ACP 注入的 stdio 配置。Grok CLI 自行管理的 MCP 属于用户
  预先信任的外部运行时配置，桌面端无法在 Grok 启动前发现或隔离它们。
- Grok 0.2.101 兼容性探针已验证 `session/new`、`session/load`、正常断连和强制终止 Grok：
  同一会话链路不会重复泄漏 Mock 进程，Grok 退出后 stdio 子进程也退出。真实 Electron E2E
  另行验证了 Main 原生确认、固定 xAI 环境空覆盖和 `initialize → tools/list`。操作系统或
  Electron 进程被直接崩溃终止仍是所有外部子进程共有的剩余风险，不能宣传为 Job Object
  级别的崩溃隔离。
- Grok 的 `_x.ai/mcp/servers_updated` 运行时通知只归一化为有上限的服务器数量，用于提示
  用户外部 Grok 仍可能拥有 CLI 自管 MCP。名称、命令、URL、Header 和任意原始 payload
  不进入快照、事件、Renderer 或磁盘。畸形通知会被忽略而不会清除最后一个有效状态；超过
  检查上限时界面只显示有界下限，且仅在设置目标与当前运行时工作区一致时展示。实测 Grok
  0.2.101 不会为 `session/new` 注入的 MCP 发送此通知，因此该状态主要用于 Grok CLI 自管
  服务器，不能用来判断会话注入是否成功。
- Renderer 以 Main 返回的 canonical workspace path 为权威键，在当前进程内维护相互
  隔离的 MCP 配置。连接项目时只读取该工作区条目；Settings 草稿仅在连接成功后提交并
  迁移到 canonical key，失败不会覆盖旧配置。空配置删除条目，不存在跨项目默认值。
- canonical path 作为不透明工作区标识使用：边界只用 `trim()` 判断是否为空，不会改写
  原字符串中的合法空白，避免两个真实目录被合并为同一 MCP 凭据作用域。
- Renderer 单独重载时，Main 只在 `RuntimeSnapshot` 暴露 `mcpConfigured` 布尔值，不回传
  MCP 名称、URL 或 Header。当前 Grok 连接可继续使用原内存配置，设置页明确提示详情无法
  恢复；下一次按空表单重连会清除它。
- MCP 远程 URL 必须使用 HTTPS，HTTP 仅允许回环主机；禁止 credentials、query、
  fragment、hop-by-hop Header、控制字符和非 ASCII Header 值，并限制服务器数量、
  单服务器及总 Header 字节预算。用户把 URL 改到新 Origin 时，Renderer 会从设置草稿
  移除旧 Header；真正网络请求仍由外部 `grok.exe` 执行。
- 权限决定完全使用 Agent 返回的 option ID；三档进程策略仅映射 Grok 原生模式，桌面端
  不自行批准单次 ACP 权限请求，也不伪造 `allow_always`。
- 未识别事件可以记录为诊断信息，但不能导致崩溃或静默授权。

### PTY compatibility host

- 只在用户明确进入“原始终端”时创建。
- 直接启动 Grok，可执行文件和工作目录与 ACP 路径使用同一验证逻辑。
- `node-pty` 使用包内 Windows x64 预编译模块；`electron-builder` 禁止自动重编译，
  避免 Electron ABI 与本机 MSVC 组件造成不可复现构建。

## 安全约束

1. `nodeIntegration` 关闭，`contextIsolation` 和 renderer sandbox 开启。
2. 禁止任意 URL 导航和新窗口；允许的 HTTPS 链接交给本机 Chrome。
3. 禁止 shell 插值，所有子进程都使用可执行文件与参数数组。
4. Always-approve 必须由用户明确选择且常驻显示风险状态。
5. Rewind、worktree apply、discard 等文件破坏性操作必须二次确认。
6. 待处理权限请求在断连、窗口关闭或超时后按取消处理。
7. 不把 Windows 权限提示宣传为 OS 沙箱；Grok 当前文档未声明 Windows 沙箱支持。
8. MCP Header、URL、stdio 命令/参数/显式 env 和 API Key 都按敏感值处理；Main 在错误、stderr、快照和事件出界前覆盖
   已知原文、Authorization credential、JSON 转义及 URL 编码形式。未被 Runtime 复制的普通父环境值不在
   该脱敏集合内，因此这不是对任意编码、拆分或外部 Grok 日志的完整 DLP。异常终止必须在发出
   最后一个脱敏快照和通知后才能释放密钥列表。

## 持久化边界

桌面端设置与最近列表写入 Electron `userData`。以下数据不进入桌面端存储：

- API Key、Token、认证码
- ACP 模型目录、模型启用选择与思考强度
- MCP 服务器名称、URL、Header、stdio 命令、参数与环境变量
- Grok 配置文件内容
- 完整会话消息或工具结果
- 项目文件内容与 Diff 正文

## 兼容策略

- 记录 Grok 与 ACP 协议版本，并在初始化失败时给出明确诊断。
- 模型、模式、配置项和命令按 Agent 响应动态渲染；扩展能力只有经过主进程明确
  allow-list 和归一化的 feature flag 才能进入 Renderer。
- 忽略未知通知，保留原始终端入口。
- Grok 可执行文件每次连接前重新验证；路径失效时回到发现流程。
- 打包应用的 Electron smoke harness 只启动 `release/win-unpacked` 中的桌面端，并使用系统
  临时目录下的隔离 `userData`、运行时随机 Key 与随机回环 Mock API。它验证根地址到 `/v1`
  的同源匹配、ACP 多模型和 Composer 选择，不发送 Prompt、不访问真实服务商、不提供登录
  入口，也不读取用户真实设置；CDP 端口由 Chromium 动态分配，完成后先关闭窗口，超时才按
  根 PID 清理测试进程树。
