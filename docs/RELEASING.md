# Release process

## Preconditions

1. 确认 `package.json`、`package-lock.json` 根包版本、ACP `CLIENT_VERSION` 与
   `CHANGELOG.md` 中的版本一致。
2. 确认工作树只包含预期的源码和文档变更。
3. 不提交 API Key、Token、会话数据、`release/`、`dist/` 或 `artifacts/`。
4. 检查并记录 Windows 代码签名状态。本项目当前发布 `v0.1.3` 未签名 prerelease，Release
   Notes 必须明确说明可能出现 SmartScreen“未知发布者”提示。

## Verification

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run package:dir
npm run test:electron
npm run package
git diff --check
```

检查安装包签名与 SHA-256：

```powershell
$installer = 'release\Grok-Desktop-Windows-x64-Setup-0.1.3.exe'
$checksum = "$installer.sha256"
$signature = Get-AuthenticodeSignature -LiteralPath $installer
$hash = Get-FileHash -LiteralPath $installer -Algorithm SHA256
$line = '{0}  {1}' -f $hash.Hash.ToUpperInvariant(), (Split-Path $installer -Leaf)
Set-Content -LiteralPath $checksum -Value $line -Encoding ascii
$signature
Get-Content -LiteralPath $checksum
```

`v0.1.3` 的预期签名状态是 `NotSigned`。还应确认 `release/win-unpacked` 中不存在 `grok.exe`，
源码、安装包和隔离默认设置中不存在真实 API URL、API Key 或本机用户数据。全新安装首次打开
时 URL 与 Key 字段必须为空。

## GitHub release

安装包超过 GitHub 普通 Git 单文件限制，因此不得提交到 Git 历史。源码推送完成后，创建
带注释的 `v0.1.3` 标签和公开 prerelease，并且只把以下两个文件作为 GitHub Release 附件上传：

- `Grok-Desktop-Windows-x64-Setup-0.1.3.exe`
- `Grok-Desktop-Windows-x64-Setup-0.1.3.exe.sha256`

不要上传 `release/` 目录、`win-unpacked/`、`dist/`、`artifacts/`、`.blockmap` 或 `latest.yml`，
也不要把它们加入 Git。GitHub 自动生成的源码归档不受此限制。

Release Notes 应说明：

- 这是独立桌面客户端，不包含官方 Grok CLI；
- 用户必须自行安装 Grok CLI；
- 结构化连接只支持用户显式提供的任意兼容 URL + API Key，不提供 Grok 登录 UI 或凭据回退；
- 支持同源 API 路径发现、ACP 多模型获取和 Composer 模型选择；
- `v0.1.3` 安装包未进行 Windows 代码签名，可能触发 SmartScreen；
- 主要能力、已知限制和校验值。

## Post-release checks

- 在没有开发依赖的干净 Windows 用户环境中安装、启动和卸载。
- 验证默认 Grok 发现、手动选择路径、首次打开 URL/Key 为空、任意兼容 URL + 内存 Key 和
  原始终端。
- 验证根 URL 的同源 `/v1` 匹配、多个 ACP 模型、设置页初始模型和 Composer 实际切换模型；
  确认不存在 Grok 登录入口或继承凭据回退。
- 验证一次真实 ACP 对话、权限允许/拒绝、取消任务和异常断线恢复。
