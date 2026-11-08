# OpenCode 2.2.6 自定义模型配置方法

OpenCode 2.2.6 允许您通过编辑 `opencode.jsonc` 配置文件来配置自定义模型。您可以在项目级别或全局级别（位于 `~/.config/opencode/opencode.jsonc`）进行此操作。

以下是配置自定义模型的方法：

1. **创建或编辑配置文件**:
    在您的项目根目录或全局配置目录 (`~/.config/opencode/`) 中创建或编辑 `opencode.jsonc` 文件。

2. **添加 `$schema`**:
    为了获得编辑器验证和自动完成功能，请在文件顶部添加 `$schema` 字段：

    ```jsonc
    {
      "$schema": "https://opencode.ai/config.json",
      // ... 您的配置
    }
    ```

3. **配置 `providers` 字段**:
    使用 `providers` 顶级字段来配置您的提供商和模型。在 `providers` 下，指定您要配置的提供商 ID（例如 `openai`）。

4. **定义自定义模型**:
    在特定提供商的配置中，使用 `models` 字段来定义或覆盖模型设置。对于每个自定义模型，您需要提供一个唯一的 `modelID` 作为键，并为其设置以下属性：
    - `modelID`: 这是提供商实际使用的模型 ID（例如，如果您为 `gpt-6.1-sol` 创建自定义配置，则此字段仍为 `gpt-6.1-sol`）。
    - `name`: 这是您为自定义模型指定的易读名称。
    - `limit` (可选): 您可以设置 `context`（上下文）和 `output`（输出）的 token 限制。

**示例**:

假设您想为 OpenAI 提供商的 `gpt-6.1-sol` 模型创建一个自定义配置，并将其命名为 "GPT-6.1 Sol Custom"，同时调整其上下文和输出限制。您的 `opencode.jsonc` 文件可能如下所示：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "openai": {
      "models": {
        "gpt-6.1-sol-custom": {
          // 您的自定义模型 ID
          "modelID": "gpt-6.1-sol", // 提供商的实际模型 ID
          "name": "GPT-6.1 Sol Custom", // 自定义名称
          "limit": {
            "context": 200000, // 自定义上下文 token 限制
            "output": 32000, // 自定义输出 token 限制
          },
        },
      },
    },
    // 您还可以配置其他提供商，例如 Anthropic
    // "anthropic": {
    //   "models": {
    //     "claude-sonnet-5-5-custom": {
    //       "modelID": "claude-sonnet-5-5",
    //       "name": "Claude Sonnet Custom",
    //       "limit": {
    //         "context": 180000,
    //         "output": 28000
    //       }
    //     }
    //   }
    // }
  },
}
```

通过这种方式，您可以在 OpenCode 中定义和使用具有特定名称和限制的自定义模型配置。

**重要提示**:

- 配置文件支持 JSONC 格式，这意味着您可以使用注释。
- 配置更改通常会立即生效，无需重启 OpenCode 服务。
- 如果遇到问题，请查阅 OpenCode 的官方文档或检查日志以获取更多信息。
