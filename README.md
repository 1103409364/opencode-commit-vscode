# OpenCode Commit Message

VS Code 扩展：用 [opencode](https://opencode.ai) 生成 Git commit message，替代 GitHub Copilot 的「生成提交信息」按钮。

- 源码控制视图标题栏的 ✨ 按钮 / `Ctrl+Alt+G`
- 读取 `git diff --cached`，调用 `opencode run --agent commit-msg`，把结果直接写进 SCM 输入框
- 支持取消、超时、自定义模型 / 指令 / agent
- 零依赖，无需编译

> 官方 `sst-dev.opencode` 扩展只负责在终端里打开 opencode，不提供 commit message 生成；
> 本扩展补的正是 Copilot 那个 ✨ 按钮。

## 安装

方式一，本地文件夹（改完源码重跑一次即可）：

```sh
./install.sh
```

方式二，安装打包好的 VSIX：

```sh
code --install-extension opencode-commit-message-0.1.0.vsix
```

装完在 VS Code 里执行 `Developer: Reload Window`。

> `install.sh` 会把文件复制到 `~/.vscode/extensions/opencode.opencode-commit-message-<version>/`。
> 修改源码后重新运行一次 `./install.sh` 并 reload。
> 想重新打包：`npm run package`。

## 使用

1. 暂存改动（`git add`）。
2. 点 Source Control 标题栏的 ✨，或按 `Ctrl+Alt+G`。
3. 生成结果写入提交输入框，按需修改后提交。

也可以在命令面板执行 **OpenCode: Generate Commit Message (opencode)**。

## 配置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `opencodeCommit.command` | `opencode` | 可执行文件路径。GUI 启动的 VS Code 常常找不到 `~/.opencode/bin`，这时填绝对路径。 |
| `opencodeCommit.args` | `["run", "--archived"]` | 模型/agent 参数之前的基础参数。老版本 opencode 没有 `--archived` 时改成 `["run"]`。 |
| `opencodeCommit.agent` | `commit-msg` | `--agent` 的值。仓库内的 `.opencode/agents/commit-msg.md` 提供了只输出消息、不调工具的 agent。留空则用默认 agent。 |
| `opencodeCommit.model` | *(空)* | `--model` 的值，例如 `google/gemini-3.8-flash`。留空用默认模型。 |
| `opencodeCommit.instructions` | *(空)* | 附加到 prompt 的额外要求，例如「用中文」「subject 不超过 50 字符」。 |
| `opencodeCommit.maxDiffChars` | `60000` | 发给模型的 diff 字符上限，超出截断。 |
| `opencodeCommit.timeoutSeconds` | `120` | 超时时间。 |

对应项目里的 opencode agent：

```md
<!-- .opencode/agents/commit-msg.md -->
---
description: Writes a Conventional Commits message from a staged diff
mode: primary
steps: 1
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---
```

## 关闭 Copilot 的生成按钮

VS Code 1.124 的内置 Copilot 没有单独的「只关提交信息生成」开关（只有
`github.copilot.chat.commitMessageGeneration.instructions`），所以：

- 想彻底换成 opencode（推荐）：`"chat.disableAIFeatures": true`，Copilot 的输入框
  ✨ 按钮会一起消失，只留下本扩展的按钮。
- 想保留 Copilot 补全：什么都不用改，两个 ✨ 会并排出现（Copilot 的在输入框内，
  本扩展同时也在输入框和标题栏提供按钮）。

本扩展自己在 `scm/title`（标题栏）和 `scm/inputBox`（输入框）各贡献了一个入口，
只想要标题栏那个，删掉 `package.json` 里 `scm/inputBox` 那一段即可。

## 排错

- **找不到 opencode**：把 `opencodeCommit.command` 设成 `which opencode` 的输出（例如 `/home/you/.opencode/bin/opencode`）。
- **生成失败 / 空消息**：扩展会用通知显示 stderr 的最后一条错误（如额度用尽、provider 不可达）。点「Show Output」看完整日志。
- **没有暂存内容**：会提示 `no staged changes`，不会调用模型。
- **agent 不存在**：opencode 会报错；把 `opencodeCommit.agent` 留空，或在仓库里创建对应 `.opencode/agents/*.md`。

## 开发

```sh
node scripts/smoke-test.js
```
