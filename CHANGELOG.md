# Changelog

本项目遵循语义化版本号。尚未发布的变更记录在 `Unreleased`。

## Unreleased

- 建立 GitHub 仓库、CI、安全策略和标准发布流程。
- 采用 PolyForm Noncommercial 1.0.0 源码许可，允许非商业使用并禁止未经授权的商用。

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
