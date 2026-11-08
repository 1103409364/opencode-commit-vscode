"use strict";

// Node 内置模块：execFile 用于执行 git（一次性任务），
// spawn 用于执行 opencode（需要向 stdin 写入提示词的长任务）。
const { execFile, spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

/** 命令 ID，在 package.json 的 contributes.commands 中注册。 */
const COMMAND_ID = "opencodeCommit.generate";
/** 扩展所有配置项所在的配置节（opencodeCommit.*）。 */
const CONFIG_SECTION = "opencodeCommit";
/** 匹配 ANSI 转义序列（如终端颜色码 \e[31m），用于清理子进程输出。 */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/** 输出通道：日志与错误详情显示在 "OpenCode Commit Message" 输出面板中。 */
let outputChannel;
/**
 * 当前正在运行的 opencode 子进程引用。
 * 用于在窗口关闭（deactivate）或再次出错时终止残留进程。
 */
let activeChild;

/**
 * 扩展入口：创建输出通道并注册命令。
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  outputChannel = vscode.window.createOutputChannel("OpenCode Commit Message");
  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand(COMMAND_ID, generateCommitMessage),
  );
}

/** 扩展停用回调：确保正在运行的 opencode 子进程被终止。 */
function deactivate() {
  stopActiveChild();
}

/** 终止当前活动的 opencode 子进程（若存在）。 */
function stopActiveChild() {
  if (!activeChild) return;
  activeChild.kill();
  activeChild = undefined;
}

/**
 * 命令主流程：
 * 1. 选择仓库 → 2. 检查暂存区 → 3. 读取 diff 并组装提示词 →
 * 4. 带 UI 进度提示地调用 opencode → 5. 将生成的消息写入 SCM 输入框。
 * 所有错误统一在 catch 中处理（取消视为正常返回，不弹错误提示）。
 */
async function generateCommitMessage() {
  try {
    // 选择目标仓库；用户未选择 / 没有仓库时直接返回。
    const repository = await pickRepository();
    if (!repository) return;

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const root = repository.rootUri.fsPath;

    // 先用 --stat 快速探测暂存区：没有暂存内容时提示并结束（spare 一次 opencode 调用）。
    const stat = await runGit(root, ["diff", "--cached", "--stat", "--no-color"]);
    if (!stat.trim()) {
      vscode.window.showWarningMessage(
        "OpenCode Commit: there are no staged changes to describe.",
      );
      return;
    }

    // 读取完整暂存 diff。--no-ext-diff 避免外部 diff 工具干扰输出格式。
    const diff = await runGit(root, [
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
    ]);

    // 组装发送给 opencode 的提示词（stat + diff + 用户自定义指令）。
    const prompt = buildPrompt({
      stat,
      diff,
      instructions: config.get("instructions", ""),
      maxDiffChars: config.get("maxDiffChars", 60000),
    });

    // 在 SCM 面板显示可取消的进度条，阻塞期间执行真正的生成调用。
    const message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: "Generating commit message…",
        cancellable: true,
      },
      (_progress, token) => generate({ config, root, prompt, token }),
    );

    // 把结果写入 SCM 输入框，并把 SCM 视图带到前台供用户检查/编辑。
    repository.inputBox.value = message;
    await vscode.commands.executeCommand("workbench.view.scm");
    // 记录生成的消息首行（对应 commit message 的 subject）。
    outputChannel.appendLine(`[generate] ${message.split("\n")[0]}`);
  } catch (error) {
    // 用户从进度条取消：视为正常流程，静默返回。
    if (error && error.name === "AbortError") return;

    // 错误处理：记录首行错误与 stderr 详情，终止可能残留的子进程。
    const detail = firstErrorLine(error);
    outputChannel.appendLine(`[error] ${detail}`);
    if (error && error.stderr) outputChannel.appendLine(stripAnsi(error.stderr).trim());
    stopActiveChild();

    // 弹出错误提示，提供 "Show Output" 按钮跳转到日志。
    const choice = await vscode.window.showErrorMessage(
      `OpenCode Commit: ${detail}`,
      "Show Output",
    );
    if (choice === "Show Output") outputChannel.show(true);
  }
}

/**
 * 根据配置组装 opencode 调用参数并执行，返回清理后的 commit message。
 * CLI 契约：先使用 args 中配置的基础参数（默认 ["run", "--archived"]），
 * 再依次追加 --agent、--model；提示词通过 stdin 发送，stdout 为消息内容。
 * @returns {Promise<string>} 清理后的 commit message（非空）
 */
async function generate({ config, root, prompt, token }) {
  // 基础参数（可配置，兼容不带 --archived 的旧版 opencode），再追加可选的 agent/model。
  const args = [...config.get("args", ["run", "--archived"])];
  const agent = (config.get("agent", "") || "").trim();
  const model = (config.get("model", "") || "").trim();
  if (agent) args.push("--agent", agent);
  if (model) args.push("--model", model);

  // 超时下限 5 秒，默认 120 秒。
  const timeoutSeconds = Math.max(5, config.get("timeoutSeconds", 120));
  const stdout = await runOpencode({
    command: config.get("command", "opencode"),
    args,
    cwd: root,
    input: prompt,
    timeoutMs: timeoutSeconds * 1000,
    token,
  });

  // 清理原始输出；为空说明 opencode 没给出有效消息，视为失败。
  const message = cleanMessage(stdout);
  if (!message) throw new Error("opencode returned an empty message.");
  return message;
}

/**
 * 通过内置 Git 扩展 API 选择目标 Git 仓库：
 * 优先返回 SCM 中当前被选中的仓库，否则回退到列表中的第一个。
 * @returns {Promise<Repository|null>} 无仓库可用时通过抛错表达；未激活时先激活 Git 扩展
 */
async function pickRepository() {
  const extension = vscode.extensions.getExtension("vscode.git");
  if (!extension) throw new Error("the built-in Git extension is not available.");

  // Git 扩展可能尚未激活，需要先激活拿到其 exports。
  const git = extension.isActive ? extension.exports : await extension.activate();
  // 使用 v1 API；仓库发现完全通过扩展 API 完成，不 shell 调用 git。
  const api = git.getAPI(1);
  const repositories = api.repositories || [];
  if (!repositories.length) throw new Error("no Git repository in the current workspace.");

  return repositories.find((repository) => repository.ui && repository.ui.selected)
    || repositories[0];
}

/**
 * 使用 execFile 执行 git 命令并返回 stdout。
 * 使用用户 git.path 配置的可用 git 可执行文件；不经过 shell，避免注入风险。
 * @param {string} cwd 工作目录（仓库根目录）
 * @param {string[]} args git 参数列表
 * @returns {Promise<string>} stdout 内容
 */
function runGit(cwd, args) {
  const gitPath = vscode.workspace.getConfiguration("git").get("path", "git") || "git";
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args,
      // maxBuffer 放大到 64MB 以容纳大型 diff；windowsHide 避免在 Windows 上闪出控制台窗口。
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // 把 stderr 挂到 error 对象上，方便调用方记录详情。
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * 按 candidateCommands 的候选顺序依次尝试执行 opencode，
 * 只有 ENOENT（命令不存在）才继续尝试下一个候选；其他错误立即抛出。
 * @returns {Promise<string>} opencode 的 stdout
 */
async function runOpencode(options) {
  const candidates = candidateCommands(options.command);
  let lastError;

  for (const command of candidates) {
    try {
      return await spawnOpencode(command, options);
    } catch (error) {
      lastError = error;
      if (error.code !== "ENOENT") throw error;
    }
  }

  // 所有候选都不存在：给出可操作的错误提示。
  throw new Error(
    `could not find the opencode executable (tried: ${candidates.join(", ")}). `
      + `Set "${CONFIG_SECTION}.command" to its absolute path.`,
  );
}

/**
 * spawn opencode 子进程，通过 stdin 写入提示词，收集 stdout/stderr，
 * 并处理超时（kill + ETIMEDOUT）和用户取消（kill + AbortError）。
 * 通常不应直接抛同步错误，但 spawn 失败（如权限问题）仍会进入 reject。
 * @returns {Promise<string>} resolve 时返回 stdout
 */
function spawnOpencode(command, { args, cwd, input, timeoutMs, token }) {
  // 超时兜底：非法值统一回退到 120 秒。
  const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    // 暴露给全局，便于 deactivate / 出错时强制结束进程。
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let subscription;

    // 一次性收尾：防止 timeout/cancel/close 等多个事件重复 settle Promise。
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (subscription) subscription.dispose();
      if (activeChild === child) activeChild = undefined;
      settle(value);
    };

    // 超时：杀掉子进程并以 ETIMEDOUT 拒绝。
    timer = setTimeout(() => {
      child.kill();
      const error = new Error(`timed out after ${Math.round(limitMs / 1000)}s`);
      error.code = "ETIMEDOUT";
      finish(reject, error);
    }, limitMs);

    // 用户在进度条上点击取消：杀掉子进程并以 AbortError 拒绝。
    if (token) {
      subscription = token.onCancellationRequested(() => {
        child.kill();
        const error = new Error("cancelled");
        error.name = "AbortError";
        finish(reject, error);
      });
    }

    // 收集标准输出与错误输出（结果取 stdout，stderr 仅用于错误详情）。
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    // 退出码为 0 视为成功；非 0 时把 stderr 附加到错误上以便日志记录。
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, stdout);
        return;
      }
      const error = new Error(`opencode exited with code ${code}`);
      error.stderr = stderr;
      finish(reject, error);
    });

    // stdin 静默忽略写错误（如子进程提前退出导致 EPIPE）。
    child.stdin.on("error", () => {});
    // 提示词写完即关闭 stdin，等待 opencode 输出并退出。
    child.stdin.end(input, "utf8");
  });
}

/**
 * 计算要尝试的 opencode 可执行文件候选列表。
 * - 用户配置了明确路径（与 "opencode" 不同）时只用该路径；
 * - 否则按内置 fallback 顺序尝试（PATH、默认安装位置等），去重。
 * @param {string} configured 来自 opencodeCommit.command 配置
 */
function candidateCommands(configured) {
  const command = (configured || "").trim();
  const home = os.homedir();
  const fallbacks = [
    "opencode", // PATH 中的 opencode
    path.join(home, ".opencode", "bin", "opencode"), // 默认安装位置
    "/usr/local/bin/opencode", // 常见全局安装位置
    "/opt/homebrew/bin/opencode", // macOS Homebrew（Apple Silicon）位置
  ];

  if (command && command !== "opencode") return [command];
  return [...new Set(fallbacks)];
}

/**
 * 组装发送给 opencode 的提示词：
 * 结构为「任务描述 + （可选）用户指令 + git diff --stat + git diff 正文」，
 * diff 超过 maxDiffChars 时截断（下限 1000 字符）并标注 "[diff truncated]"。
 */
function buildPrompt({ stat, diff, instructions, maxDiffChars = 60000 }) {
  const limit = Math.max(1000, Number(maxDiffChars) || 60000);
  const body = diff.length > limit ? `${diff.slice(0, limit)}\n... [diff truncated]` : diff;
  const lines = ["Write the commit message for the staged changes below."];

  if (instructions && instructions.trim()) {
    lines.push("", instructions.trim());
  }

  lines.push("", "--- git diff --stat ---", stat.trim(), "", "--- git diff ---", body.trim());
  return lines.join("\n");
}

/**
 * 清理 opencode 的原始输出，得到可直接放入 SCM 输入框的 commit message：
 * 1. 去掉 ANSI 转义序列；2. 统一换行符；
 * 3. 过滤 markdown 围栏代码块行（```）；
 * 4. 压缩 3 个以上连续空行；5. 去首尾空白；
 * 6. 若整体被一对直引号包裹，则去掉这对引号（仅一次）。
 */
function cleanMessage(raw) {
  const text = stripAnsi(String(raw || ""))
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** 去掉字符串中的 ANSI 转义序列（颜色码等），安全处理空值。 */
function stripAnsi(value) {
  return String(value || "").replace(ANSI_ESCAPE, "");
}

/**
 * 从错误中提取适合展示的单行错误详情：
 * 优先取 stderr 中包含 error/failed/not found/denied 关键字的最后一行，
 * 其次是 stderr 最后一行；stderr 为空时回退到 error.message。
 * 会去掉常见的 "error: " 前缀，因为外层已加 "OpenCode Commit: "。
 */
function firstErrorLine(error) {
  const stderr = stripAnsi(error && error.stderr ? error.stderr : "");
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reported = lines.filter((line) => /error|failed|not found|denied/i.test(line));
  const line = (reported.length ? reported[reported.length - 1] : lines[lines.length - 1])
    || (error && error.message)
    || "unknown error";
  return line.replace(/^error:\s*/i, "");
}

module.exports = {
  activate,
  deactivate,
  // 测试专用导出：smoke-test 通过 _test 直接调用内部函数，无需 VS Code 宿主。
  _test: {
    buildPrompt,
    candidateCommands,
    cleanMessage,
    firstErrorLine,
    generate,
    runOpencode,
  },
};
