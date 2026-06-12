# 🚀 ZenMux Provider for Copilot

Welcome to **ZenMux Provider for Copilot**! This is a model provider extension designed specifically for VS Code Copilot. With this extension, you can seamlessly integrate the powerful model gateway capabilities of [ZenMux](https://zenmux.ai) into VS Code Copilot, giving you the freedom to use top-tier AI models.

## 💡 Usage

Just a few simple steps to start your ZenMux journey:

1.  📥 **Install Extension**: Click [here](https://marketplace.visualstudio.com/items?itemName=hugehardzhang.zenmux-copilot) to install the extension.
2.  💬 **Open Copilot**: Open the GitHub Copilot Chat interface in VS Code.
3.  ⚙️ **Manage Models**: Click the model picker below the chat input box and select "Manage Models...".
4.  ✅ **Select ZenMux**: Click "Add Models" and then select the "ZenMux" provider.
5.  🔑 **Configure Key**: Enter your ZenMux API Key (the key will be securely saved locally).
6.  🎯 **Pick Models**: Select the specific models you wish to use in the model picker.

## ℹ️ Extension Information

- **Name**: ZenMux Provider for Copilot
- **Version**: See `package.json`

## ✅ Prerequisites

Before you begin, please ensure you meet the following requirements:

- 💻 **VS Code Version**: >= 1.104.0
- 🧩 **Copilot Extension**: `github.copilot-chat` extension installed
- 🔑 **API Key**: A valid ZenMux API Key (get it from [zenmux.ai](https://zenmux.ai))
- 🟢 **Node.js**: (Required only for development and building)

## 🛠️ Installation & Build (Development Guide)

If you are a developer and want to build or modify this project yourself:

**1. Install Dependencies**

```powershell
npm install
```

**2. Compile TypeScript**

```powershell
npm run compile
```

**3. Package VSIX (Optional)**

```powershell
npm run build
```

## 🐛 Run in Extension Development Host

1.  Open this repository in VS Code.
2.  Press `F5` to launch the **Extension Development Host**.
3.  In the development host, open Copilot Chat; you should be able to see and use the `ZenMux Provider`.

## 📝 Activation & Logging

- **Activation Events**: The extension activates when events declared in `package.json` are triggered (e.g., `onStartupFinished` or when running a command).
- **View Logs**:
    1.  Open the Output Panel (View → Output or `Ctrl+Shift+U`).
    2.  Select the `ZenMux` channel from the dropdown menu in the top right corner.

## ⚙️ Configuration (Common)

You can adjust the following parameters in VS Code Settings:

- `zenmux.baseUrl`: Base URL for the ZenMux gateway (Default: `https://zenmux.ai/api/v1`).
- `zenmux.anthropic.baseUrl`: Anthropic-compatible backend URL.
- `zenmux.anthropic.cacheTtl`: Prompt cache TTL for the Anthropic Messages API, either `5m` or `1h` (default: `5m`). `1h` cache writes cost more and are only sent to Anthropic-compatible models.
- `zenmux.retry`: Request retry policy (enabled, max attempts, interval in ms).
- `zenmux.delay`: Fixed delay between requests (in milliseconds).

## 📊 Subscription Usage

You can optionally configure a ZenMux Management API Key to show subscription usage in the VS Code status bar.

- The Management API Key is stored securely in VS Code SecretStorage.
- Standard ZenMux API Keys are not supported for subscription usage.
- The status bar shows 5-hour and 7-day quota usage, and refreshes after chat requests with throttling.
- Click the ZenMux subscription status bar item to refresh usage, update the Management API Key, clear the key, or open the API docs.

Use `ZenMux: Set Management API Key` from the Command Palette to enable this feature.

## ⌨️ Commands

- `zenmux.setApikey`: Run this command via the Command Palette (`Ctrl+Shift+P`) to set or update your ZenMux API Key at any time.
- `zenmux.setManagementApiKey`: Set or update the ZenMux Management API Key for subscription usage.
- `zenmux.refreshSubscriptionUsage`: Refresh subscription usage manually.
- `zenmux.clearManagementApiKey`: Clear the stored Management API Key.
- `zenmux.showSubscriptionUsage`: Open subscription usage actions.

## 🔍 Debugging Tips

If the extension does not activate or shows no logs:

- 🧐 Ensure you are viewing the **Extension Development Host** window.
- 📄 Check the `ZenMux` channel in the **Output Panel**.
- 🐞 Open **Developer Tools** (Help → Toggle Developer Tools) to check for console errors.
- 🔄 Try **Reload Window** (`Developer: Reload Window`).
- 📁 Confirm that the `out/extension.js` file exists (ensure you have run `npm run compile`).

## 🤝 Contributing & Feedback

We welcome your participation!

- 🐛 **Submit Issues**: [GitHub Issues](https://github.com/ilimei/zenmux-copilot/issues)
- 🔀 **Contribute Code**: Feel free to Fork this repository and submit a Pull Request.

## 📄 License

[MIT License](LICENSE)
