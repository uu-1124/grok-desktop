# Contributing

感谢参与 Grok Desktop。修改前请先阅读 [AGENTS.md](AGENTS.md) 和
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 工程边界

- Grok 必须保持为外部运行时，不复制、修改或重新分发 `grok.exe`。
- ACP 是产品 API；PTY 只作为兼容入口，不能成为会话数据模型。
- Renderer 不得导入 Node.js 或 Electron 模块。
- Preload 只能暴露 `src/shared/contracts.ts` 定义的 typed API。
- 不持久化 API Key、Token、完整 Prompt、工具结果或 Grok 会话正文。
- 模型、模式、认证方式和扩展能力必须从 ACP 响应发现，不能硬编码。
- 未知或失败的权限决定必须回退为取消。

## 本地验证

提交前至少运行：

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

修改 Electron 集成、权限 UI、认证或打包配置时，还应运行：

```powershell
npm run package:dir
npm run test:electron
```

Electron smoke 使用隔离的临时 `userData`，不得发送真实 Prompt 或触发登录。

## 提交要求

- 保持变更聚焦，不顺带重构无关模块。
- 协议、状态和安全行为变化必须补聚焦测试。
- 不提交 `release/`、`dist/`、`artifacts/`、本地日志或任何凭据。
- 安装包通过 GitHub Release 发布，不进入 Git 历史。
- 提交贡献即表示同意按项目当前的 PolyForm Noncommercial 1.0.0 许可提供该贡献。
