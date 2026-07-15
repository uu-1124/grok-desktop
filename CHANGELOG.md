# Changelog

本项目遵循语义化版本号。尚未发布的变更记录在 `Unreleased`。

## Unreleased

## 0.1.3 - 2026-07-15

### Added

- 设置页新增同源 API 路径检测和基于短生命周期 Grok ACP 的多模型发现。
- 设置页支持启用多个模型、选择初始模型和模型广告的思考强度；Composer 新增当前模型选择器。

### Changed

- 结构化连接现在只接受用户显式提供的任意兼容 API Base URL + API Key，不再提供 Grok
  登录 UI、默认端点或继承凭据回退。
- 根地址优先尝试 `/v1`，其他非版本路径保留原地址并补充同源 `/v1` 候选；成功后保存实际
  解析出的 Base URL。
- 可写会话模型通过 ACP 配置切换，只读或进程模型经过重新验证后使用独立 Grok Agent 重连。
- 模型与路径预检改由短生命周期 Runtime 完成，失败不会替换当前长期连接；权限切换、终端返回
  和普通重连会继续使用仍已启用的当前模型及匹配的思考强度。

### Security

- API Key 继续只保留在当前进程内；修改 URL 或 Key 会使旧模型目录失效，切换 Origin 会清除
  旧凭据草稿。
- 启动 Grok Agent 前按 Windows 不区分大小写的规则清除继承的 Key 与模型端点变量，再把
  Agent API 和模型目录同时绑定到本次显式 URL + Key，阻止旧环境覆盖或跨 Origin 重定向。
- 拒绝 ACP 模型 ID、名称或思考强度反射本次 API Key，避免凭据进入进程命令行、Runtime
  快照或 Renderer 状态。
- Electron smoke 使用运行时随机 Key 和随机回环 Mock API 验证路径匹配与多模型，不访问真实
  服务商或用户设置。

## 0.1.2 - 2026-07-15

### Added

- 建立 GitHub 仓库、CI、安全策略和标准发布流程。

### Changed

- Windows 安装包使用明确的 Windows x64 文件名，并完善自定义 API Base URL 诊断。

### Security

- 采用 PolyForm Noncommercial 1.0.0 源码许可，允许非商业使用并禁止未经授权的商用。

## 0.1.1 - 2026-07-15

### Added

- Composer 附近新增 Codex 风格权限菜单，提供逐项授权、自动和完全授权三档。
- 设置页同步提供三档权限选择，权限偏好会跨桌面端重启保留。

### Fixed

- 自动连接现在显式恢复已保存的权限模式，不再因 Renderer 重载或应用重启回到旧状态。
- `auto` 与完全授权分别使用 Grok 原生启动参数，不由桌面端自行判断工具风险。

### Security

- 完全授权使用危险提示与二次确认；未知或损坏的持久化权限值安全回退逐项授权。
- 任务执行或等待权限期间禁止切换模式，避免运行中的 Agent 权限语义发生漂移。

## 0.1.0 - 2026-07-15

### Added

- 基于官方 Grok ACP 的结构化会话、流式回复、Thought、工具调用、计划和权限请求。
- 官方 Grok CLI 原始终端兼容入口。
- 用户自定义 xAI API Base URL 和仅内存保存的 API Key。
- 动态模型、模式、认证方式和 MCP 能力发现。
- 工作区、最近任务、对话时间线、Composer、Inspector 和权限弹窗。
- Windows NSIS 安装包与隔离 `userData` 的 Electron smoke 验收。

### Security

- Renderer 保持 Node/Electron 隔离，Preload 仅暴露 typed API。
- 不持久化凭据、完整 Prompt、工具结果或 Grok 会话正文。
- 不捆绑、修改或重新分发 `grok.exe`。
