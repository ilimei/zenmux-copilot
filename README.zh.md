# 🚀 ZenMux Provider for Copilot

欢迎使用 **ZenMux Provider for Copilot**！这是一个专为 VS Code Copilot 打造的模型 Provider 扩展。通过本扩展，您可以将 [ZenMux](https://zenmux.ai) 强大的模型网关能力无缝集成到 VS Code Copilot 中，自由使用各类顶尖 AI 模型。

## 💡 使用方式

只需简单几步，即可开启您的 ZenMux 之旅：

1.  📥 **安装扩展**：点击 [这里](https://marketplace.visualstudio.com/items?itemName=hugehardzhang.zenmux-copilot) 安装插件。
2.  💬 **打开 Copilot**：在 VS Code 中打开 GitHub Copilot Chat 界面。
3.  ⚙️ **管理模型**：点击聊天输入框上方的模型选择器，选择 "Manage Models..."（管理模型）。
4.  ✅ **选择 ZenMux**：点击 "Add Models" (添加模型)，然后选择 "ZenMux" 提供方。
5.  🔑 **配置密钥**：输入您的 ZenMux API Key（密钥将安全地保存在本地）。
6.  🎯 **挑选模型**：选择您希望在模型选择器中使用的具体模型。

## ℹ️ 扩展信息

- **名称**: ZenMux Provider for Copilot
- **版本**: 参见 `package.json`

## ✅ 使用前提

在开始之前，请确保您满足以下条件：

- 💻 **VS Code 版本**: >= 1.104.0
- 🧩 **Copilot 扩展**: 已安装 `github.copilot-chat` 扩展
- 🔑 **API Key**: 拥有有效的 ZenMux API Key（可从 [zenmux.ai](https://zenmux.ai) 获取）
- 🟢 **Node.js**: (仅开发和构建时需要)

## 🛠️ 安装与构建 (开发指南)

如果您是开发者，想要自行构建或修改本项目：

**1. 安装依赖**

```powershell
npm install
```

**2. 编译 TypeScript**

```powershell
npm run compile
```

**3. 打包 VSIX (可选)**

```powershell
npm run build
```

## 🐛 在扩展开发主机中运行

1.  在 VS Code 中打开此仓库。
2.  按 `F5` 键启动 **扩展开发主机 (Extension Development Host)**。
3.  在开发主机中，打开 Copilot Chat，您应该能看到并使用 `ZenMux Provider`。

## 📝 激活与日志

- **激活事件**: 扩展会在 `package.json` 中声明的事件触发时激活（如 `onStartupFinished` 或执行命令时）。
- **查看日志**:
    1.  打开输出面板 (视图 → 输出 或 `Ctrl+Shift+U`)。
    2.  在右上角下拉菜单中选择 `ZenMux` 通道。

## ⚙️ 配置 (通用)

您可以在 VS Code 设置中调整以下参数：

- `zenmux.baseUrl`: ZenMux 网关的基础 URL（默认：`https://zenmux.ai/api/v1`）。
- `zenmux.anthropic.baseUrl`: 兼容 Anthropic 的后端 URL。
- `zenmux.anthropic.cacheTtl`: Anthropic Messages API 的提示缓存 TTL，可选 `5m` 或 `1h`，默认 `5m`。`1h` 写入成本更高，且只会发送给 Anthropic 兼容模型。
- `zenmux.maxContextTokens`: 暴露给 VS Code 的最大上下文窗口。`0` 表示使用模型完整上下文；例如设置为 `200000` 可将 1M 上下文模型限制到 200K，减少提示上下文消耗。
- `zenmux.retry`: 请求重试策略（是否启用、最大尝试次数、间隔毫秒数）。
- `zenmux.delay`: 请求之间的固定延迟（毫秒）。

## 📊 订阅用量

您可以选择配置 ZenMux Management API Key，在 VS Code 状态栏中查看订阅用量。

- Management API Key 会安全保存在 VS Code SecretStorage 中。
- 普通 ZenMux API Key 不支持查询订阅用量。
- 状态栏会展示 5 小时和 7 天配额用量，并在聊天请求后节流刷新。
- 点击 ZenMux 订阅状态栏项，可以刷新用量、更新 Management API Key、清除密钥或打开 API 文档。

可通过命令面板运行 `ZenMux: Set Management API Key` 来启用此功能。

## ⌨️ 命令

- `zenmux.setApikey`: 通过命令面板 (`Ctrl+Shift+P`) 运行此命令，可随时设置或更新您的 ZenMux API Key。
- `zenmux.setManagementApiKey`: 设置或更新用于订阅用量查询的 ZenMux Management API Key。
- `zenmux.refreshSubscriptionUsage`: 手动刷新订阅用量。
- `zenmux.clearManagementApiKey`: 清除已保存的 Management API Key。
- `zenmux.showSubscriptionUsage`: 打开订阅用量操作菜单。

## 🔍 调试技巧

如果遇到扩展未激活或无日志的情况：

- 🧐 确保您正在查看的是 **扩展开发主机** 的窗口。
- 📄 检查 **输出面板** 中的 `ZenMux` 通道。
- 🐞 打开 **开发者工具** (帮助 → 切换开发人员工具) 查看控制台报错。
- 🔄 尝试 **重载窗口** (`Developer: Reload Window`)。
- 📁 确认 `out/extension.js` 文件是否存在（请确保已运行 `npm run compile`）。

## 🤝 贡献与反馈

我们非常欢迎您的参与！

- 🐛 **提交问题**: [GitHub Issues](https://github.com/ilimei/zenmux-copilot/issues)
- 🔀 **贡献代码**: 欢迎 Fork 本仓库并提交 Pull Request。

## 📄 许可证

[MIT License](LICENSE)
