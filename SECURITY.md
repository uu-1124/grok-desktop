# Security policy

## Supported version

当前仅维护最新的 `0.1.x` 内测版本。项目进入稳定发布后会在此补充长期支持范围。

## Reporting a vulnerability

请使用 GitHub Security Advisory 的私密报告入口联系维护者。不要在公开 Issue、讨论、
日志或截图中提交以下内容：

- API Key、Token、Cookie 或认证码；
- 完整 Prompt、工具结果或 Grok 会话正文；
- 包含个人目录、私有仓库或内部服务地址的未脱敏日志；
- 可直接利用的漏洞复现数据。

报告中请尽量提供受影响版本、复现步骤、预期与实际行为，以及经过脱敏的诊断信息。

## Security boundaries

Grok Desktop 不捆绑 `grok.exe`，也不为 Grok CLI 或用户启动的本地工具提供操作系统级
沙箱。所有本地进程仍具有当前 Windows 用户的权限。桌面端负责保持 ACP/PTY 边界、
Renderer 隔离、结构化进程启动、权限提示和敏感配置不落盘。
