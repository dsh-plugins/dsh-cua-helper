<div align="center">

# DSH CUA Helper

**为 DeepSeek Harness 构建与上游 Release 标签匹配的原生 Computer Use 助手社区版本。**

[English](README.md) | 简体中文

</div>

## 下载

1. 确认正在运行的 DeepSeek Harness（DSH）实例版本。以 `0.2.3-alpha.2` 为例，对应 [Releases](https://github.com/dsh-plugins/dsh-cua-helper/releases) 中的 `dsh-v0.2.3-alpha.2` 标签。助手和 DSH 版本必须匹配。
2. 下载 `cua-helper-<tag>-<target>.zip` 与 `SHA256SUMS`。将 ZIP 的 SHA-256 与清单中的对应行比较，然后把完整 ZIP 解压到 `node_modules` 之外且当前用户可写的持久目录。
3. Windows 必须保留可执行文件及其运行库，macOS 必须保留完整 `.app`。在 DSH 中启用内置 Computer Use 组合包，再按下方配置助手路径。

| 目标 | Runner | 压缩包与检查 |
| --- | --- | --- |
| `win-x64` | `windows-2025` | 自包含 .NET ZIP；未签名；执行 x64 协议测试和 PE 架构检查 |
| `win-arm64` | `windows-2025` | 自包含 .NET ZIP；未签名；交叉构建并检查 PE 架构，未执行 ARM64 运行测试 |
| `darwin-arm64` | `macos-15` | ZIP 内含完整 `.app`；临时签名，未经公证；执行 Swift 测试、签名和 Mach-O 架构检查 |
| `darwin-x64` | `macos-15-intel` | ZIP 内含完整 `.app`；临时签名，未经公证；执行 Swift 测试、签名和 Mach-O 架构检查 |

上游没有 Linux 原生助手。WSL 不是 Linux 构建目标，并且有独立的上游配置和限制。历史标签只构建其源码支持的目标。GitHub 托管构建不会测试交互式桌面访问或系统权限提示。macOS Gatekeeper 可能限制未经公证的社区版本；请遵循 Apple 和管理员的安全要求。需要官方签名的环境应使用上游签名版本。

Windows 可用 `Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\Downloads\cua-helper-dsh-v0.2.3-alpha.2-win-x64.zip'` 输出下载 ZIP 的摘要。macOS 可将 `SHA256SUMS` 放在 ZIP 旁并运行 `shasum -a 256 -c --ignore-missing SHA256SUMS`，也可以直接运行 `shasum -a 256` 计算指定 ZIP 的摘要。

## 配置

找到当前 profile 的 `cordis.patch.yml`。编辑已有的提供方条目；如果 profile 没有该条目，再针对其 ID 添加 patch。patch 会整体替换提供方的 `config`，因此必须保留现有设置并补上 `helperPath`。保持内置组合包启用。以下是 DSH `0.2.3-alpha.2` 的示例，只使用与你的平台对应的一段：

```yaml
- id: cua-windows
  config:
    agentPreset: ptc
    helperPath: 'C:\Users\example\Tools\dsh-cua-helper\dsh-cua-windows.exe'
```

```yaml
- id: cua-macos
  config:
    agentPreset: ptc
    helperPath: '/Users/example/Tools/dsh-cua-helper/DSH Computer Use Dev.app/Contents/MacOS/dsh-cua-native'
```

将路径改成实际解压出的可执行文件，重启 DSH 实例，然后检查 Computer Use 设置。macOS 只在你准备授权时，为助手打开辅助功能和屏幕录制权限。参见上游的 [Windows 配置说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/experimental/cua-windows/README.zh.md#setup) 和 [macOS 配置说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/experimental/cua-macos/native/README.zh.md#build-and-service)。

## 同步与手动构建

[Mirror CUA helpers](https://github.com/dsh-plugins/dsh-cua-helper/actions/workflows/mirror.yml) 每小时 UTC 的第 17 分钟检查上游已发布的 Release（GitHub 调度可能延迟）。它包含预发布版本，从 `dsh-v0.2.3-alpha.2` 开始，并且不会重建已经完整发布的版本。每次任务最多选择八个待处理标签，剩余标签和失败版本会在后续任务中继续处理。要构建指定标签（包括较早版本），在 `main` 上选择 **Run workflow** 并填写 `upstream_tag`，或运行：

```sh
gh workflow run mirror.yml --repo dsh-plugins/dsh-cua-helper --ref main -f upstream_tag=dsh-v0.2.3-alpha.2
```

工作流解析上游的精确提交，只把原生源码、构建输入和许可证写入 `versions/<tag>/`，并在 `source.json` 中记录上游提交和构建目标。同名 Git 标签指向镜像快照；所有预期资产和校验和通过检查后，对应 GitHub Release 才会公开。失败标签可以重试，不会替换已公开资产。只有隔离的发布任务拥有写权限，使用仓库自动提供的 `GITHUB_TOKEN`，不需要额外密钥。发布任务不会执行上游源码或构建出的可执行文件。

## 本地验证

在本仓库运行 `node --test` 和 `actionlint`。在 Windows 上从已提交快照构建时，先安装 .NET 10 SDK，再运行：

```powershell
node scripts/build.mjs versions/dsh-v0.2.3-alpha.2 win-x64 out
```

在安装 Xcode 26.3 和 Python 3 的兼容 macOS 主机上运行：

```sh
node scripts/build.mjs versions/dsh-v0.2.3-alpha.2 darwin-arm64 out
```

输出目录必须为空。脚本会写入 ZIP 及包含摘要和构建身份的 JSON 文件。CI 会发布 ZIP 和汇总的 `SHA256SUMS` 文件。

`dsh-v0.2.3-alpha.2` 的 macOS 构建会在临时副本中应用 Swift 编译兼容修复，将窗口几何读取保留在既有同步辅助功能代码中，并维持原有检查顺序。源码快照保留上游标签的原始文件。

## 许可证

本项目是独立社区项目，不代表 DeepSeek 官方发布。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 保留原始助手源码的权利。每个快照和压缩包都包含上游 MIT 许可证，压缩包还会保留适用的第三方声明。本仓库自动化代码使用 [MIT 许可证](LICENSE)。
