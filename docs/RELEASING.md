# Release process

## Preconditions

1. 确认 `package.json` 与 `CHANGELOG.md` 中的版本一致。
2. 确认工作树只包含预期的源码和文档变更。
3. 不提交 API Key、Token、会话数据、`release/`、`dist/` 或 `artifacts/`。
4. 正式公开发布前配置 Windows 代码签名证书。

## Verification

```powershell
npm ci
npm run typecheck
npm test
npm run package:dir
npm run test:electron
npm run package
```

检查安装包签名与 SHA-256：

```powershell
$installer = 'release\Grok-Desktop-Windows-x64-Setup-0.1.0.exe'
Get-AuthenticodeSignature -LiteralPath $installer
Get-FileHash -LiteralPath $installer -Algorithm SHA256
```

还应确认 `release/win-unpacked` 中不存在 `grok.exe`。

## GitHub release

安装包超过 GitHub 普通 Git 单文件限制，因此不得提交到 Git 历史。源码推送完成后，
创建带注释的版本标签，并把以下文件作为 GitHub Release 附件上传：

- `Grok-Desktop-Windows-x64-Setup-<version>.exe`
- `Grok-Desktop-Windows-x64-Setup-<version>.exe.sha256`

Release Notes 应说明：

- 这是独立桌面客户端，不包含官方 Grok CLI；
- 用户必须自行安装 Grok CLI；
- 安装包是否已经进行 Windows 代码签名；
- 主要能力、已知限制和校验值。

## Post-release checks

- 在没有开发依赖的干净 Windows 用户环境中安装、启动和卸载。
- 验证默认 Grok 发现、手动选择路径、API Base URL、内存 API Key 和原始终端。
- 验证一次真实 ACP 对话、权限允许/拒绝、取消任务和异常断线恢复。
