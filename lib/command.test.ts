import { describe, expect, it } from "vitest";

import { commandFor, findCommand, quoteArg, windowsToolDirs } from "./command";

const env = {
  Path: "C:\\Windows\\system32;\"C:\\Program Files\\nodejs\";C:\\Users\\sam\\AppData\\Roaming\\npm;C:\\Users\\sam\\.local\\bin",
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
  USERPROFILE: "C:\\Users\\sam",
  APPDATA: "C:\\Users\\sam\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
};
const win = (files: string[], extra: Partial<typeof env> = {}) => ({
  platform: "win32" as const,
  env: { ...env, ...extra },
  cwd: "C:\\Users\\sam\\lockin",
  isFile: (p: string) => files.some((f) => f.toLowerCase() === p.toLowerCase()),
});

/** cmd.exe's reading of a line with no quote mode (every quote is escaped): ^x is x, and a bare space splits. */
function cmdPass(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "^") {
      cur += line[++i] ?? "";
      started = true;
    } else if (ch === " ") {
      if (started) tokens.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

/** How the C runtime (and so node.exe) splits a command line into argv. */
function crtSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    let slashes = 0;
    while (line[i] === "\\") {
      slashes++;
      i++;
    }
    const ch = line[i];
    if (ch === '"') {
      cur += "\\".repeat(Math.floor(slashes / 2));
      started = true;
      if (slashes % 2) cur += '"';
      else if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
      continue;
    }
    cur += "\\".repeat(slashes);
    if (slashes) started = true;
    if (ch === undefined) break;
    if ((ch === " " || ch === "\t") && !inQuotes) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const tricky = [
  "-p",
  "--disallowed-tools",
  "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task",
  "C:\\Users\\Bob & Co (x86)\\AppData\\Roaming\\Lockin\\materials\\abc",
  "100% sure",
  'say "hi"',
  "trailing slash\\",
  "\\\\server\\share\\",
  "^caret! <in|out> ;semi `tick` *?",
  "",
];

describe("findCommand", () => {
  it("leaves the command to spawn() off Windows", () => {
    expect(findCommand("claude", { platform: "darwin" })).toBe("claude");
    expect(findCommand("claude", { platform: "linux" })).toBe("claude");
  });

  it("prefers a native executable anywhere on PATH over an earlier .cmd shim", () => {
    const found = findCommand(
      "claude",
      win(["C:\\Users\\sam\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Users\\sam\\.local\\bin\\claude.exe"]),
    );
    expect(found).toBe("C:\\Users\\sam\\.local\\bin\\claude.exe");
  });

  it("finds npm's .cmd shim when there is no executable", () => {
    const found = findCommand("claude", win(["C:\\Users\\sam\\AppData\\Roaming\\npm\\claude.cmd"]));
    expect(found).toBe("C:\\Users\\sam\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("looks in the usual install folders when PATH does not list them", () => {
    const found = findCommand(
      "claude",
      win(["C:\\Users\\sam\\AppData\\Roaming\\npm\\claude.cmd"], { Path: "C:\\Windows\\system32" }),
    );
    expect(found).toBe("C:\\Users\\sam\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("reads quoted PATH entries", () => {
    expect(findCommand("node", win(["C:\\Program Files\\nodejs\\node.exe"]))).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("takes a path as given, adding an extension if it has none", () => {
    const opts = win(["C:\\tools\\claude.exe", "C:\\Users\\sam\\lockin\\bin\\claude.cmd"]);
    expect(findCommand("C:\\tools\\claude.exe", opts)).toBe("C:\\tools\\claude.exe");
    expect(findCommand("C:/tools/claude", opts)).toBe("C:\\tools\\claude.exe");
    expect(findCommand("bin\\claude", opts)).toBe("C:\\Users\\sam\\lockin\\bin\\claude.cmd");
  });

  it("says when there is nothing to run", () => {
    expect(findCommand("claude", win([]))).toBeNull();
    expect(findCommand("C:\\nowhere\\claude.exe", win([]))).toBeNull();
  });
});

describe("quoteArg", () => {
  it("survives the C runtime's splitting unchanged", () => {
    for (const arg of tricky) expect(crtSplit(quoteArg(arg))).toEqual([arg]);
    expect(crtSplit(tricky.map(quoteArg).join(" "))).toEqual(tricky);
  });
});

describe("commandFor", () => {
  it("is the plain command off Windows", () => {
    expect(commandFor("claude", ["-p"], { platform: "darwin" })).toEqual({ file: "claude", args: ["-p"], verbatim: false });
  });

  it("runs a native executable directly", () => {
    const run = commandFor("claude", ["-p", "a b"], win(["C:\\Users\\sam\\.local\\bin\\claude.exe"]));
    expect(run).toEqual({ file: "C:\\Users\\sam\\.local\\bin\\claude.exe", args: ["-p", "a b"], verbatim: false });
  });

  it("runs a .cmd shim through cmd.exe, every argument arriving intact", () => {
    const shim = "C:\\Program Files (x86)\\npm & co\\claude.cmd";
    const run = commandFor("claude", tricky, win([shim], { Path: "C:\\Program Files (x86)\\npm & co" }));
    expect(run.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(run.verbatim).toBe(true);
    expect(run.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);

    // /s strips the outer quotes; cmd.exe reads the line once to find the command…
    const line = run.args[3];
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    const [command, ...forwarded] = cmdPass(line.slice(1, -1));
    expect(command).toBe(shim);
    // …the shim forwards the rest through %* into node's command line, read once more…
    const nodeLine = cmdPass(forwarded.join(" ")).join(" ");
    // …and node splits it back into exactly what was asked for.
    expect(crtSplit(nodeLine)).toEqual(tricky);
  });

  it("leaves nothing unescaped for cmd.exe to act on", () => {
    const run = commandFor("claude", ["a&b", "x|y", "(z)"], win(["C:\\npm\\claude.cmd"], { Path: "C:\\npm" }));
    expect(run.args[3]).not.toMatch(/(^|[^^])[&|()<>]/);
  });
});

describe("windowsToolDirs", () => {
  it("lists the install folders from the environment, skipping unknown ones", () => {
    const dirs = windowsToolDirs({ USERPROFILE: "C:\\Users\\sam", APPDATA: "C:\\Users\\sam\\AppData\\Roaming" });
    expect(dirs).toContain("C:\\Users\\sam\\.local\\bin");
    expect(dirs).toContain("C:\\Users\\sam\\AppData\\Roaming\\npm");
    expect(dirs.every((d) => !d.includes("undefined"))).toBe(true);
  });
});
