# Grok Desktop

面向本机 Grok 编码智能体的 Windows 桌面客户端。应用不会复制、修改或重新分发
`grok.exe`，而是在运行时发现现有安装，并通过 Grok 官方 Agent Client Protocol
（ACP）建立结构化连接。

> 当前版本：`0.1.6` 内测版。核心功能、自动化测试和 Windows 安装包已经可用；安装包
> 尚未进行 Windows 代码签名，公开分发时可能触发 SmartScreen 的未知发布者提示。

源码与版本说明托管在 GitHub；Windows 安装包通过
[GitHub Releases](https://github.com/uu-1124/grok-desktop/releases) 发布，不进入源码历史。

## 设计边界

- ACP 是主交互路径：会话、流式回复、Thought、工具调用、计划和权限请求。
- ConPTY 是兼容路径：仅用于尚未映射到 ACP 的原始 TUI 功能。
- Composer 附近提供逐项授权、自动和完全授权三档权限入口，并映射到 Grok 原生
  `default`、`auto` 与 `bypassPermissions + --always-approve`。默认仍为逐项授权；
  用户选择会保存到桌面设置，完全授权始终使用危险状态并要求显式确认。
- 每次 ACP 连接使用独立的 Grok Agent，不复用共享 Leader，保证用户在桌面端选择的
  API 地址、用户凭据、模型和权限策略确实作用于当前连接。
- 结构化连接只接受用户明确提供的兼容 API Base URL 与 API Key，不使用默认端点、Grok
  登录或父进程凭据回退。远程地址必须使用 HTTPS，本机回环开发服务可使用 HTTP；Base URL
  可以保存；成功连接后的 API Key 使用 Electron `safeStorage` 加密，只保存到当前用户的
  `userData`，且按 API Origin 绑定。Windows 使用 DPAPI；不安全的 Linux `basic_text` 后端
  会被拒绝，不会降级为明文。
- 设置页使用短生命周期 Grok ACP 连接检测地址并获取模型。检测只尝试同一 Origin 的候选路径：
  根地址优先尝试 `/v1`，非版本路径保留原路径并补充 `/v1` 候选，已带版本路径则保持原样。
  修改 URL 或 Key 会立即作废旧模型目录。
- 模型只来自成功连接的 ACP 响应。设置页可以同时启用多个模型并选择初始模型；Composer
  附近的模型选择器优先使用 Grok 广告的会话配置能力，否则会重新验证模型并真实重连。
  思考强度同样只显示当前模型明确广告的档位，不假定任何模型或档位始终可用。
- Grok 明确广告能力后，桌面端可配置 HTTP、SSE 或 stdio MCP 服务器。URL、Header、
  本地可执行文件、参数和环境变量仅保存在当前桌面进程，并随 `session/new` 与
  `session/load` 交给外部 Grok 进程；当前不开放 MCP-over-ACP。
- stdio MCP 只接受本机 canonical `.exe` 与结构化参数数组，不经过 shell。应用要求用户
  在设置页和 Main 原生确认框中两次确认本地执行，并把 Grok 启动环境里未显式授权的
  非必要变量置空；这项隔离只覆盖桌面端通过 ACP 注入的 stdio MCP。Grok CLI 自行管理的
  MCP 属于外部运行时配置，不受桌面端环境 mask 管理。stdio 程序仍拥有当前 Windows 用户
  权限，不提供 OS 沙箱。
- 外部 HTTPS 链接只允许交给本机 Google Chrome，不加载远程网页到应用窗口。
- Composer 可引用当前工作区文件：路径会在主进程重新验证；Grok 广告 embedded context
  时，小型 UTF-8 文本仅随本次 prompt 内嵌，二进制或超大文件退回 ACP ResourceLink。
- 渲染进程没有 Node.js 权限；进程、文件选择和持久化均由 Electron 主进程负责。
- API Key 不写入普通配置、日志、快照或事件；Token 和 Grok 会话正文不进入桌面端存储。

更详细的模块边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 本机要求

- Windows 10 或更高版本
- 已安装 Grok CLI；默认发现位置为 `%USERPROFILE%\.grok\bin\grok.exe`
- Node.js 24+ 与 npm 11+（仅开发和打包需要）

## 开发

```powershell
npm install
npm run dev
```

## 项目结构

```text
src/main/       Electron 主进程、Grok 运行时、ACP 与安全边界
src/renderer/   React 界面、对话视图和交互状态
src/shared/     Main、Preload 与 Renderer 共用的类型契约
scripts/        构建清理和打包态 Electron smoke 验收
docs/           架构与发布文档
build/          应用图标等打包资源
```

`dist/`、`release/`、`artifacts/` 和 `node_modules/` 都是本机构建产物，不进入 Git。
Windows 安装包应作为 GitHub Release 附件发布，不直接提交到源码历史。

Electron 运行时首次下载较慢时，可在当前 PowerShell 会话使用镜像后重新安装：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm run postinstall
```

## 验证与打包

```powershell
npm run typecheck
npm test
npm run build
npm run package:dir
npm run test:electron
npm run package
```

`npm run package` 生成 NSIS 安装包到 `release/`。安装程序默认按当前用户安装，
并创建桌面及开始菜单快捷方式。打包固定复用当前项目已安装的
`node_modules/electron/dist`，不会在构建阶段再次下载 Electron。

`npm run test:electron` 直接启动 `release/win-unpacked/Grok Desktop.exe`，使用系统临时目录中的
隔离 `userData`、运行时随机 API Key、本机已安装的 Grok 和随机回环 Mock API。Electron CDP
会验证根地址自动匹配 `/v1`、ACP 获取多个模型、Composer 使用所选模型、登录入口不存在，
以及历史任务失败恢复、错误文案、键盘焦点、本地最近记录移除、三档权限菜单、浅色权限弹窗
和原始终端入口。权限视觉检查只会临时注入无行为的 DOM 夹具，并在 1280×720 下使用完整
四选项验证取消入口和末尾选项仍可访问。测试不会发送 Prompt、不会访问真实 API 服务商，
也不会使用用户真实的桌面端设置。
若尚未生成 unpacked 应用，可运行：

```powershell
npm run test:electron:package
```

默认使用 `%USERPROFILE%\.grok\bin\grok.exe` 和当前项目目录。需要覆盖时可设置
`GROK_E2E_EXECUTABLE`、`GROK_E2E_WORKSPACE` 或 `GROK_E2E_APP`；设置
`GROK_E2E_KEEP_USER_DATA=1` 可在成功后保留隔离目录以便诊断。

## 运行时数据

桌面端只在 Electron 的 `userData` 目录保存以下非敏感信息：

- Grok 可执行文件路径
- 最近使用的项目目录
- 由桌面端打开过的会话 ID、标题与时间戳
- 窗口和界面偏好

API Key 不写入 `settings.json`；成功连接后只以 `safeStorage` 密文写入独立凭据文件，
并可在设置页清除。模型目录、模型启用选择、MCP 服务器配置（含命令、参数与环境变量）及 Header
不写入 `userData`。MCP 配置在当前桌面进程内按工作区隔离：切换项目不会携带其他项目的
Header，切回原项目可继续使用，退出应用后全部清除。若界面进程单独重载，主进程只返回
“当前连接存在 MCP 配置”的非敏感标记，不会把服务器 URL 或 Header 回传给新界面；设置页
会提示详情无法恢复，应用空配置并重新连接后会清除原配置。

Grok 的配置、凭据、日志与完整会话仍由 Grok 自己管理，位置通常为
`%USERPROFILE%\.grok`；桌面端不会读取或把其中凭据作为结构化连接的回退来源。

## 品牌说明

这是连接本机 Grok CLI 的独立桌面客户端工程，不包含或重新分发 xAI/Grok
二进制。Grok 与 xAI 的名称和商标归其各自权利人所有。

## 许可

源码按照 [PolyForm Noncommercial License 1.0.0](LICENSE) 开放，允许个人学习、研究、
测试和其他非商业用途，禁止未经授权的商业使用。需要商业使用时应另行取得许可。

## 参与开发与安全问题

- 开发约束和提交前检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中提交密钥、
  Prompt、工具结果或会话数据。
- 版本变化见 [CHANGELOG.md](CHANGELOG.md)，发布步骤见
  [docs/RELEASING.md](docs/RELEASING.md)。
