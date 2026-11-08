"use strict";

const { execFile, spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const COMMAND_ID = "opencodeCommit.generate";
const CONFIG_SECTION = "opencodeCommit";
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

let outputChannel;
let activeChild;

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("OpenCode Commit Message");
  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand(COMMAND_ID, generateCommitMessage),
  );
}

function deactivate() {
  stopActiveChild();
}

function stopActiveChild() {
  if (!activeChild) return;
  activeChild.kill();
  activeChild = undefined;
}

async function generateCommitMessage() {
  try {
    const repository = await pickRepository();
    if (!repository) return;

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const root = repository.rootUri.fsPath;

    const stat = await runGit(root, ["diff", "--cached", "--stat", "--no-color"]);
    if (!stat.trim()) {
      vscode.window.showWarningMessage(
        "OpenCode Commit: there are no staged changes to describe.",
      );
      return;
    }

    const diff = await runGit(root, [
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
    ]);

    const prompt = buildPrompt({
      stat,
      diff,
      instructions: config.get("instructions", ""),
      maxDiffChars: config.get("maxDiffChars", 60000),
    });

    const message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: "Generating commit message…",
        cancellable: true,
      },
      (_progress, token) => generate({ config, root, prompt, token }),
    );

    repository.inputBox.value = message;
    await vscode.commands.executeCommand("workbench.view.scm");
    outputChannel.appendLine(`[generate] ${message.split("\n")[0]}`);
  } catch (error) {
    if (error && error.name === "AbortError") return;

    const detail = firstErrorLine(error);
    outputChannel.appendLine(`[error] ${detail}`);
    if (error && error.stderr) outputChannel.appendLine(stripAnsi(error.stderr).trim());
    stopActiveChild();

    const choice = await vscode.window.showErrorMessage(
      `OpenCode Commit: ${detail}`,
      "Show Output",
    );
    if (choice === "Show Output") outputChannel.show(true);
  }
}

async function generate({ config, root, prompt, token }) {
  const args = [...config.get("args", ["run", "--archived"])];
  const agent = (config.get("agent", "") || "").trim();
  const model = (config.get("model", "") || "").trim();
  if (agent) args.push("--agent", agent);
  if (model) args.push("--model", model);

  const timeoutSeconds = Math.max(5, config.get("timeoutSeconds", 120));
  const stdout = await runOpencode({
    command: config.get("command", "opencode"),
    args,
    cwd: root,
    input: prompt,
    timeoutMs: timeoutSeconds * 1000,
    token,
  });

  const message = cleanMessage(stdout);
  if (!message) throw new Error("opencode returned an empty message.");
  return message;
}

async function pickRepository() {
  const extension = vscode.extensions.getExtension("vscode.git");
  if (!extension) throw new Error("the built-in Git extension is not available.");

  const git = extension.isActive ? extension.exports : await extension.activate();
  const api = git.getAPI(1);
  const repositories = api.repositories || [];
  if (!repositories.length) throw new Error("no Git repository in the current workspace.");

  return repositories.find((repository) => repository.ui && repository.ui.selected)
    || repositories[0];
}

function runGit(cwd, args) {
  const gitPath = vscode.workspace.getConfiguration("git").get("path", "git") || "git";
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

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

  throw new Error(
    `could not find the opencode executable (tried: ${candidates.join(", ")}). `
      + `Set "${CONFIG_SECTION}.command" to its absolute path.`,
  );
}

function spawnOpencode(command, { args, cwd, input, timeoutMs, token }) {
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

    activeChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let subscription;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (subscription) subscription.dispose();
      if (activeChild === child) activeChild = undefined;
      settle(value);
    };

    timer = setTimeout(() => {
      child.kill();
      const error = new Error(`timed out after ${Math.round(limitMs / 1000)}s`);
      error.code = "ETIMEDOUT";
      finish(reject, error);
    }, limitMs);

    if (token) {
      subscription = token.onCancellationRequested(() => {
        child.kill();
        const error = new Error("cancelled");
        error.name = "AbortError";
        finish(reject, error);
      });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

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

    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

function candidateCommands(configured) {
  const command = (configured || "").trim();
  const home = os.homedir();
  const fallbacks = [
    "opencode",
    path.join(home, ".opencode", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
  ];

  if (command && command !== "opencode") return [command];
  return [...new Set(fallbacks)];
}

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

function stripAnsi(value) {
  return String(value || "").replace(ANSI_ESCAPE, "");
}

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
  _test: {
    buildPrompt,
    candidateCommands,
    cleanMessage,
    firstErrorLine,
    generate,
    runOpencode,
  },
};
