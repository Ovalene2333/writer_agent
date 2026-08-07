import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const MANIFEST_NAME = "writer-backup.json";
const BACKUP_FORMAT = "writer-backup-v1" as const;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".cache",
  "__pycache__",
]);

export type ProjectBackupManifest = {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  title: string;
  projectRootName: string;
  fileCount: number;
  totalBytes: number;
  sha256: string;
};

export type CreateProjectBackupResult = {
  path: string;
  manifest: ProjectBackupManifest;
};

export type RestoreProjectBackupResult = {
  targetRoot: string;
  manifest: ProjectBackupManifest;
  fileCount: number;
};

function isSkippedPath(projectRoot: string, absolutePath: string): boolean {
  const rel = relative(projectRoot, absolutePath).split(/[/\\]/).filter(Boolean);
  if (!rel.length) return false;
  return rel.some(part => SKIP_DIR_NAMES.has(part));
}

function listProjectFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (isSkippedPath(projectRoot, absolute)) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.isFile()) files.push(absolute);
    }
  };
  walk(projectRoot);
  files.sort((left, right) =>
    relative(projectRoot, left).localeCompare(relative(projectRoot, right), "en"));
  return files;
}

function defaultBackupPath(projectRoot: string, outputDir?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `writer-backup-${basename(projectRoot) || "project"}-${stamp}.tgz`;
  const dir = outputDir
    ? resolve(outputDir)
    : resolve(projectRoot, ".writer", "backups");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function readProjectTitle(projectRoot: string): string {
  try {
    const text = readFileSync(join(projectRoot, "writer.yaml"), "utf8");
    const match = text.match(/^\s*title:\s*(.+)\s*$/m);
    if (match) return match[1].replace(/^["']|["']$/g, "").trim() || basename(projectRoot);
  } catch { /* ignore */ }
  return basename(projectRoot);
}

function runTar(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("tar", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => {
      reject(new Error(`无法启动 tar：${error.message}（请确认系统已安装 tar）`));
    });
    child.on("close", code => {
      if (code === 0) resolveRun();
      else reject(new Error(`tar 失败（${code}）：${stderr.trim() || "unknown"}`));
    });
  });
}

/**
 * Create a gzipped tar archive of a Writer project (resource + .writer + config).
 * Excludes node_modules / .git / dist. Requires system `tar`.
 */
export async function createProjectBackup(projectRoot: string, options: {
  outputPath?: string;
  outputDir?: string;
  title?: string;
} = {}): Promise<CreateProjectBackupResult> {
  const root = resolve(projectRoot);
  if (!existsSync(join(root, "writer.yaml")) && !existsSync(join(root, ".writer"))) {
    throw new Error("目标不是 Writer 项目目录（缺少 writer.yaml 或 .writer/）");
  }
  const files = listProjectFiles(root);
  if (!files.length) throw new Error("项目目录为空，无法备份");

  const hash = createHash("sha256");
  let totalBytes = 0;
  const relativeFiles: string[] = [];
  for (const absolute of files) {
    const st = statSync(absolute);
    if (!st.isFile()) continue;
    const name = relative(root, absolute).split(sep).join("/");
    relativeFiles.push(name);
    totalBytes += st.size;
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(absolute));
  }

  const manifest: ProjectBackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    title: options.title?.trim() || readProjectTitle(root),
    projectRootName: basename(root),
    fileCount: relativeFiles.length,
    totalBytes,
    sha256: hash.digest("hex"),
  };

  const outputPath = options.outputPath
    ? resolve(options.outputPath)
    : defaultBackupPath(root, options.outputDir);
  mkdirSync(dirname(outputPath), { recursive: true });

  // Write manifest into project private dir so it is packed with the archive,
  // then remove the staged copy after tar finishes.
  const stagedManifest = join(root, ".writer", MANIFEST_NAME);
  mkdirSync(dirname(stagedManifest), { recursive: true });
  writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const temporary = `${outputPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const excludes = [...SKIP_DIR_NAMES].flatMap(name => ["--exclude", name]);
  try {
    await runTar([
      "-czf", temporary,
      ...excludes,
      "-C", root,
      ".",
    ]);
    try {
      renameSync(temporary, outputPath);
    } catch {
      writeFileSync(outputPath, readFileSync(temporary), { mode: 0o600 });
      try { rmSync(temporary, { force: true }); } catch { /* ignore */ }
    }
  } finally {
    try { rmSync(stagedManifest, { force: true }); } catch { /* ignore */ }
    try { rmSync(temporary, { force: true }); } catch { /* ignore */ }
  }

  return { path: outputPath, manifest };
}

/**
 * Restore a backup archive into targetRoot (must be empty or non-existent).
 */
export async function restoreProjectBackup(archivePath: string, targetRoot: string): Promise<RestoreProjectBackupResult> {
  const archive = resolve(archivePath);
  const target = resolve(targetRoot);
  if (!existsSync(archive)) throw new Error(`备份文件不存在：${archive}`);
  if (existsSync(target)) {
    const children = readdirSync(target);
    if (children.length) throw new Error(`恢复目标目录非空：${target}`);
  } else {
    mkdirSync(target, { recursive: true });
  }

  await runTar(["-xzf", archive, "-C", target]);

  const manifestPath = join(target, ".writer", MANIFEST_NAME);
  let manifest: ProjectBackupManifest;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProjectBackupManifest;
    if (manifest.format !== BACKUP_FORMAT) {
      throw new Error(`不支持的备份格式：${String((manifest as { format?: string }).format)}`);
    }
  } else {
    // Older or hand-made archives without a manifest still restore the tree.
    manifest = {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      title: basename(target),
      projectRootName: basename(target),
      fileCount: listProjectFiles(target).length,
      totalBytes: 0,
      sha256: "",
    };
  }

  return {
    targetRoot: target,
    manifest,
    fileCount: listProjectFiles(target).length,
  };
}
