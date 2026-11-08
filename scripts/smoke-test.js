"use strict";

// Smoke test without a VS Code host: the `vscode` module is stubbed before
// extension.js is loaded, then the exported _test helpers are exercised.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const fakeVscode = {
  window: {},
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
  ProgressLocation: { SourceControl: 3 },
  extensions: { getExtension: () => undefined },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const { _test } = require("../extension.js");
const { buildPrompt, candidateCommands, cleanMessage, firstErrorLine, generate, runOpencode } = _test;

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function makeFakeBin(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-ext-"));
  const bin = path.join(dir, "fake-opencode");
  fs.writeFileSync(bin, source, { mode: 0o755 });
  return bin;
}

check("buildPrompt includes stat and diff", () => {
  const prompt = buildPrompt({
    stat: " src/a.js | 2 ++",
    diff: "diff --git a/src/a.js b/src/a.js\n+hello",
    instructions: "",
  });
  assert.match(prompt, /Write the commit message/);
  assert.match(prompt, /src\/a\.js \| 2 \+\+/);
  assert.match(prompt, /\+hello/);
});

check("buildPrompt truncates large diffs", () => {
  const prompt = buildPrompt({
    stat: "big",
    diff: "x".repeat(5000),
    maxDiffChars: 1000,
  });
  assert.match(prompt, /\[diff truncated\]/);
  assert.ok(prompt.length < 3000);
});

check("buildPrompt appends custom instructions", () => {
  const prompt = buildPrompt({ stat: "s", diff: "d", instructions: "Use Chinese." });
  assert.match(prompt, /Use Chinese\./);
  assert.ok(prompt.indexOf("Use Chinese.") < prompt.indexOf("--- git diff --stat ---"));
});

check("cleanMessage removes fences, ANSI and wrapping quotes", () => {
  const raw = "\u001b[0m\n```\nfeat(a): b\n\nbody\n```\n\n\n";
  assert.equal(cleanMessage(raw), "feat(a): b\n\nbody");
  assert.equal(cleanMessage('"fix: quoted"'), "fix: quoted");
  assert.equal(cleanMessage(""), "");
});

check("candidateCommands honours an explicit path", () => {
  assert.deepEqual(candidateCommands("/opt/bin/opencode"), ["/opt/bin/opencode"]);
  assert.ok(candidateCommands("opencode").includes("opencode"));
});

check("firstErrorLine prefers reported errors", () => {
  const error = new Error("boom");
  error.stderr = "\u001b[0m\n> banner\nError: Free usage limit reached.\n";
  assert.equal(firstErrorLine(error), "Free usage limit reached.");
});

async function asyncChecks() {
  const bin = makeFakeBin("#!/bin/sh\ncat > /dev/null\nprintf 'feat: from fake\\n'\n");
  const stdout = await runOpencode({
    command: bin,
    args: ["run"],
    cwd: os.tmpdir(),
    input: "prompt",
    timeoutMs: 5000,
  });
  assert.equal(stdout.trim(), "feat: from fake");
  console.log("ok   runOpencode returns stdout");

  const failing = makeFakeBin("#!/bin/sh\ncat > /dev/null\necho 'Error: nope' >&2\nexit 3\n");
  await assert.rejects(
    runOpencode({ command: failing, args: [], cwd: os.tmpdir(), input: "", timeoutMs: 5000 }),
    (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /exited with code 3/);
      assert.match(error.stderr, /Error: nope/);
      return true;
    },
  );
  console.log("ok   runOpencode reports nonzero exits");

  await assert.rejects(
    runOpencode({
      command: "opencode-command-that-does-not-exist",
      args: [],
      cwd: os.tmpdir(),
      input: "",
      timeoutMs: 5000,
    }),
    /could not find the opencode executable/,
  );
  console.log("ok   runOpencode explains a missing executable");

  const slow = makeFakeBin("#!/bin/sh\nsleep 5\n");
  await assert.rejects(
    runOpencode({ command: slow, args: [], cwd: os.tmpdir(), input: "", timeoutMs: 300 }),
    /timed out after 0s/,
  );
  console.log("ok   runOpencode times out");

  const argsFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "opencode-args-")),
    "args.txt",
  );
  process.env.OPENCODE_ARGS_FILE = argsFile;
  const echoBin = makeFakeBin(
    '#!/bin/sh\nprintf "%s" "$*" > "$OPENCODE_ARGS_FILE"\ncat > /dev/null\nprintf "feat(x): y\\n\\nbody\\n"\n',
  );
  const config = {
    get(key, fallback) {
      const values = {
        command: echoBin,
        args: ["run", "--archived"],
        agent: "commit-msg",
        model: "google/gemini-3.8-flash",
        timeoutSeconds: 5,
      };
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
    },
  };
  const message = await generate({ config, root: os.tmpdir(), prompt: "p" });
  assert.equal(message, "feat(x): y\n\nbody");
  assert.equal(
    fs.readFileSync(argsFile, "utf8"),
    "run --archived --agent commit-msg --model google/gemini-3.8-flash",
  );
  console.log("ok   generate assembles args and cleans output");

  const emptyBin = makeFakeBin("#!/bin/sh\ncat > /dev/null\n");
  await assert.rejects(
    generate({
      config: {
        get: (key, fallback) => {
          if (key === "command") return emptyBin;
          if (key === "args") return ["run"];
          if (key === "timeoutSeconds") return 5;
          return fallback;
        },
      },
      root: os.tmpdir(),
      prompt: "p",
    }),
    /empty message/,
  );
  console.log("ok   generate rejects an empty message");
}

asyncChecks()
  .catch((error) => {
    failures.push({ name: "async checks", error });
    console.log(`FAIL async checks: ${error.message}`);
  })
  .finally(() => {
    if (failures.length) {
      console.error(`\n${failures.length} check(s) failed`);
      process.exitCode = 1;
      return;
    }
    console.log("\nall checks passed");
  });
