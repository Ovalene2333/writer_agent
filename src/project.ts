import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type { WriterConfig } from "./types.js";
import { getStyleTemplate } from "./templates.js";

const DEFAULT_CONFIG: WriterConfig = {
  title: "未命名作品",
  language: "zh-CN",
  chapters: ["chapters/chapter-001.md"],
  style: "",
};

/** Document role inferred from path conventions under resource/. */
export type DocumentKind = "lore" | "outline" | "chapter" | "archive" | "side" | "other";

export function documentKind(path: string): DocumentKind {
  const normalized = normalizeDocumentPath(path);
  if (normalized.startsWith("lore/") || normalized.startsWith("story/")) {
    return /(?:^|\/)(?:outline|大纲)[^/]*\.md$/i.test(normalized) ? "outline" : "lore";
  }
  if (normalized.startsWith("outline/") || /(?:^|\/)(?:outline|大纲)[^/]*\.md$/i.test(normalized)) return "outline";
  if (normalized.startsWith("chapters/")) return "chapter";
  if (normalized.startsWith("archive/") || normalized.startsWith("屏蔽/")) return "archive";
  if (normalized.startsWith("side/") || normalized.startsWith("涩涩/")) return "side";
  return "other";
}

/** Resolve the primary outline markdown path for structured outline tools. */
export function resolveOutlineSourcePath(project: WriterProject, preferred?: string): string {
  if (preferred && project.documentExists(preferred)) return preferred;
  for (const candidate of ["outline/outline.md", "story/outline.md"]) {
    if (project.documentExists(candidate)) return candidate;
  }
  const underOutline = project.listDocuments()
    .filter((path) => path.startsWith("outline/") && path.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (underOutline.length) return underOutline[0];
  const named = project.listDocuments()
    .filter((path) => {
      const kind = documentKind(path);
      return kind === "outline" || /大纲/.test(path);
    })
    .filter((path) => !path.startsWith("archive/") && !path.startsWith("屏蔽/") && !path.startsWith("side/") && !path.startsWith("涩涩/"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (named.length) return named[0];
  return preferred ?? "outline/outline.md";
}

export class WriterProject {
  readonly root: string;
  readonly privateDir: string;
  readonly resourceDir: string;
  readonly charactersDir: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.privateDir = resolve(this.root, ".writer");
    this.resourceDir = resolve(this.root, "resource");
    this.charactersDir = resolve(this.root, "characters");
  }

  static init(root: string, title?: string): WriterProject {
    const project = new WriterProject(root);
    const config = { ...DEFAULT_CONFIG, title: title?.trim() || DEFAULT_CONFIG.title };
    mkdirSync(resolve(project.resourceDir, "lore"), { recursive: true });
    mkdirSync(resolve(project.resourceDir, "outline"), { recursive: true });
    mkdirSync(resolve(project.resourceDir, "chapters"), { recursive: true });
    mkdirSync(resolve(project.resourceDir, "archive"), { recursive: true });
    mkdirSync(resolve(project.resourceDir, "side"), { recursive: true });
    mkdirSync(resolve(project.root, "characters"), { recursive: true });
    mkdirSync(project.privateDir, { recursive: true });
    project.writeRaw("writer.yaml", YAML.stringify(config));
    project.writeRaw("lore/world.md", "# 故事设定\n\n世界规则、专名、组织、力量体系等**事实**写在 `lore/` 下；不要写成章节正文。\n\n");
    project.writeRaw("outline/outline.md", "# 故事大纲\n\n情节计划写在 `outline/` 下。场景节点推荐字段：摘要、前因、行动、结果、状态变化、角色ID、地点、时间、情节线、伏笔、回收、状态、文档、正文章节。\n\n");
    project.writeRaw("chapters/chapter-001.md", "# 第一章\n\n");
    project.writeCharacterCardsJsonl("");
    return project;
  }

  exists(): boolean {
    try {
      return statSync(resolve(this.root, "writer.yaml")).isFile();
    } catch {
      return false;
    }
  }

  documentExists(path: string): boolean {
    try { return statSync(this.resolveSafe(path)).isFile(); }
    catch { return false; }
  }

  folderExists(path: string): boolean {
    try { return statSync(this.resolveFolderSafe(path)).isDirectory(); }
    catch { return false; }
  }

  config(): WriterConfig {
    const parsed = YAML.parse(this.readRaw("writer.yaml")) as Partial<WriterConfig> | null;
    if (!parsed || typeof parsed.title !== "string" || !Array.isArray(parsed.chapters)) {
      throw new Error("writer.yaml 格式无效");
    }
    return {
      title: parsed.title,
      language: parsed.language || "zh-CN",
      chapters: parsed.chapters.filter((item): item is string => typeof item === "string"),
      style: typeof parsed.style === "string" ? parsed.style : "",
    };
  }

  resolveSafe(path: string): string {
    if (!path || isAbsolute(path)) throw new Error("文档路径必须是项目内的相对路径");
    if (path === "writer.yaml") return resolve(this.root, path);
    const documentPath = normalizeDocumentPath(path);
    const absolute = resolve(this.resourceDir, documentPath);
    const rel = relative(this.resourceDir, absolute);
    if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(".writer")) {
      throw new Error("禁止访问项目范围外或内部数据库中的文件");
    }
    if (extname(absolute).toLowerCase() !== ".md") {
      throw new Error("只允许访问 Markdown 文档");
    }
    return absolute;
  }

  resolveFolderSafe(path: string): string {
    const normalized = normalizeFolderPath(path).replace(/^resource(?:\/|$)/, "");
    if (!normalized || isAbsolute(normalized)) throw new Error("文件夹路径必须是项目内的相对路径");
    const absolute = resolve(this.resourceDir, normalized);
    const rel = relative(this.resourceDir, absolute);
    if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(".writer")) {
      throw new Error("禁止访问项目范围外或内部数据库中的文件夹");
    }
    return absolute;
  }

  readRaw(path: string): string {
    return readFileSync(this.resolveSafe(path), "utf8");
  }

  read(path: string): string {
    if (extname(path).toLowerCase() !== ".md") throw new Error("Agent 只能读取 Markdown 文档");
    return this.readRaw(path);
  }

  writeRaw(path: string, content: string): void {
    const target = this.resolveSafe(path);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.writer-tmp-${process.pid}`;
    writeFileSync(temp, content, "utf8");
    try {
      renameSync(temp, target);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      // Windows 上防病毒软件可能短暂阻止原子重命名，回退后仍保证内容完整写入。
      writeFileSync(target, content, "utf8");
      try { unlinkSync(temp); } catch { /* 临时文件不影响正文，下次启动时可覆盖。 */ }
    }
  }

  registerChapter(path: string): void {
    path = normalizeDocumentPath(path);
    if (!path.startsWith("chapters/") || !path.endsWith(".md")) return;
    const config = this.config();
    if (config.chapters.includes(path)) return;
    config.chapters.push(path);
    this.writeRaw("writer.yaml", YAML.stringify(config));
  }

  removeDocument(path: string): void {
    path = normalizeDocumentPath(path);
    unlinkSync(this.resolveSafe(path));
    if (path.startsWith("chapters/")) {
      const config = this.config();
      config.chapters = config.chapters.filter((chapter) => chapter !== path);
      this.writeRaw("writer.yaml", YAML.stringify(config));
    }
  }

  renameDocument(fromPath: string, toPath: string): void {
    fromPath = normalizeDocumentPath(fromPath);
    toPath = normalizeDocumentPath(toPath);
    if (fromPath.includes("\\") || toPath.includes("\\")) throw new Error("文档路径请使用 / 作为分隔符");
    const from = this.resolveSafe(fromPath);
    const to = this.resolveSafe(toPath);
    const wasHidden = this.hiddenDocuments().includes(fromPath);
    if (fromPath === toPath) return;
    if (!existsSync(from)) throw new Error("原文档不存在");
    if (existsSync(to)) throw new Error("目标文档已经存在");
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    const config = this.config();
    config.chapters = config.chapters.map(path => path === fromPath ? toPath : path);
    this.writeRaw("writer.yaml", YAML.stringify(config));
    if (wasHidden) this.writeVisibility([...this.hiddenDocuments(), toPath].filter(path => path !== fromPath).sort(), this.hiddenFolders());
  }

  hiddenDocuments(): string[] {
    return this.visibility().hidden;
  }

  hiddenFolders(): string[] {
    return this.visibility().hiddenFolders;
  }

  private visibility(): { hidden: string[]; hiddenFolders: string[] } {
    const path = resolve(this.privateDir, "agent-visibility.json");
    if (!existsSync(path)) return { hidden: [], hiddenFolders: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { hidden?: unknown; hiddenFolders?: unknown };
      const hidden = Array.isArray(parsed.hidden)
        ? parsed.hidden
          .filter((item): item is string => typeof item === "string")
          .map(normalizeDocumentPath)
          .filter((item, index, array) => item && this.documentExists(item) && array.indexOf(item) === index)
        : [];
      const hiddenFolders = Array.isArray(parsed.hiddenFolders)
        ? parsed.hiddenFolders
          .filter((item): item is string => typeof item === "string")
          .map(normalizeFolderPath)
          .filter((item, index, array) => item && this.folderExists(item) && array.indexOf(item) === index)
          .sort()
        : [];
      return { hidden, hiddenFolders };
    } catch { return { hidden: [], hiddenFolders: [] }; }
  }

  setDocumentHidden(path: string, hidden: boolean): string[] {
    path = normalizeDocumentPath(path);
    if (!this.documentExists(path)) throw new Error("文档不存在");
    const paths = new Set(this.hiddenDocuments());
    hidden ? paths.add(path) : paths.delete(path);
    const result = [...paths].sort();
    this.writeVisibility(result, this.hiddenFolders());
    return result;
  }

  setFolderHidden(path: string, hidden: boolean): string[] {
    const folder = normalizeFolderPath(path);
    if (!folder) throw new Error("文件夹路径不能为空");
    if (!this.folderExists(folder)) throw new Error("文件夹不存在");
    const folders = new Set(this.hiddenFolders());
    hidden ? folders.add(folder) : folders.delete(folder);
    const result = [...folders].sort();
    this.writeVisibility(this.hiddenDocuments(), result);
    return result;
  }

  isDocumentHidden(path: string): boolean {
    path = normalizeDocumentPath(path);
    return this.hiddenDocuments().includes(path)
      || this.hiddenFolders().some(folder => path === folder || path.startsWith(`${folder}/`));
  }

  private writeHiddenDocuments(paths: string[]): void {
    this.writeVisibility(paths, this.hiddenFolders());
  }

  private writeVisibility(paths: string[], folders: string[]): void {
    mkdirSync(this.privateDir, { recursive: true });
    writeFileSync(resolve(this.privateDir, "agent-visibility.json"), `${JSON.stringify({ hidden: paths, hiddenFolders: folders }, null, 2)}\n`, "utf8");
  }

  listDocuments(): string[] {
    const results: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".writer") continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
          results.push(relative(this.resourceDir, absolute).split(sep).join("/"));
        }
      }
    };
    if (!existsSync(this.resourceDir)) return [];
    visit(this.resourceDir);
    return results.sort();
  }

  createFolder(path: string): string {
    const folder = normalizeFolderPath(path);
    if (!folder) throw new Error("文件夹路径不能为空");
    mkdirSync(this.resolveFolderSafe(folder), { recursive: true });
    return folder;
  }

  renameFolder(fromPath: string, toPath: string): void {
    const fromFolder = normalizeFolderPath(fromPath);
    const toFolder = normalizeFolderPath(toPath);
    if (!fromFolder || !toFolder) throw new Error("文件夹路径不能为空");
    if (fromFolder === toFolder) return;
    const from = this.resolveFolderSafe(fromFolder);
    const to = this.resolveFolderSafe(toFolder);
    if (!existsSync(from)) throw new Error("原文件夹不存在");
    if (existsSync(to)) throw new Error("目标文件夹已经存在");
    if (toFolder.startsWith(`${fromFolder}/`)) throw new Error("不能把文件夹移动到自身的子文件夹内");
    const hiddenDocuments = this.hiddenDocuments();
    const hiddenFolders = this.hiddenFolders();
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);

    const rewritePath = (path: string) => path === fromFolder || path.startsWith(`${fromFolder}/`)
      ? `${toFolder}${path.slice(fromFolder.length)}`
      : path;
    const config = this.config();
    config.chapters = config.chapters.map(rewritePath);
    this.writeRaw("writer.yaml", YAML.stringify(config));
    this.writeVisibility(
      hiddenDocuments.map(rewritePath).sort(),
      hiddenFolders.map(rewritePath).sort(),
    );
  }

  removeFolder(path: string): void {
    const folder = normalizeFolderPath(path);
    if (!folder) throw new Error("文件夹路径不能为空");
    rmdirSync(this.resolveFolderSafe(folder));
    this.writeVisibility(
      this.hiddenDocuments().filter(item => item !== folder && !item.startsWith(`${folder}/`)),
      this.hiddenFolders().filter(item => item !== folder && !item.startsWith(`${folder}/`)),
    );
  }

  listDocumentFolders(): string[] {
    const results: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".writer") continue;
        const absolute = resolve(directory, entry.name);
        if (!entry.isDirectory()) continue;
        results.push(relative(this.resourceDir, absolute).split(sep).join("/"));
        visit(absolute);
      }
    };
    if (!existsSync(this.resourceDir)) return [];
    visit(this.resourceDir);
    return results.sort();
  }

  listCharacterCardFiles(): string[] {
    mkdirSync(this.charactersDir, { recursive: true });
    return readdirSync(this.charactersDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === ".json")
      .map(entry => entry.name).sort();
  }

  readCharacterCardsJsonl(): string {
    const target = resolve(this.charactersDir, "characters.jsonl");
    return existsSync(target) ? readFileSync(target, "utf8") : "";
  }

  writeCharacterCardsJsonl(content: string): void {
    mkdirSync(this.charactersDir, { recursive: true });
    const target = resolve(this.charactersDir, "characters.jsonl");
    const temporary = `${target}.writer-tmp-${process.pid}`;
    writeFileSync(temporary, content, "utf8");
    try { renameSync(temporary, target); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      writeFileSync(target, content, "utf8");
      try { unlinkSync(temporary); } catch { /* 临时文件不影响角色数据。 */ }
    }
  }

  readCharacterCard(file: string): string {
    return readFileSync(this.resolveCharacterCard(file), "utf8");
  }

  writeCharacterCard(file: string, content: string): void {
    mkdirSync(this.charactersDir, { recursive: true });
    const target = this.resolveCharacterCard(file);
    if (existsSync(target)) {
      writeFileSync(target, content, "utf8");
      return;
    }
    const temporary = `${target}.writer-tmp-${process.pid}`;
    writeFileSync(temporary, content, "utf8");
    try { renameSync(temporary, target); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      writeFileSync(target, content, "utf8");
      try { unlinkSync(temporary); } catch { /* 临时文件不影响角色卡。 */ }
    }
  }

  removeCharacterCard(file: string): void {
    const target = this.resolveCharacterCard(file);
    try { unlinkSync(target); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      const retired = `${target}.deleted-${Date.now()}`;
      renameSync(target, retired);
      try { unlinkSync(retired); } catch { /* 已移出角色卡索引，残留临时文件可在下次清理。 */ }
    }
  }

  private resolveCharacterCard(file: string): string {
    if (!file || file !== file.split(/[\\/]/).at(-1) || extname(file).toLowerCase() !== ".json") {
      throw new Error("角色卡文件名无效");
    }
    const target = resolve(this.charactersDir, file);
    if (relative(this.charactersDir, target).startsWith("..")) throw new Error("角色卡路径越界");
    return target;
  }

  hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  export(format: "md" | "txt"): string {
    const config = this.config();
    const parts = config.chapters.map((path) => this.read(path));
    if (format === "md") return `# ${config.title}\n\n${parts.join("\n\n---\n\n")}`;
    return `${config.title}\n\n${parts
      .join("\n\n")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_`]/g, "")}`;
  }

  exportTo(format: "md" | "txt"): string {
    const target = resolve(this.root, `export.${format}`);
    writeFileSync(target, this.export(format), "utf8");
    return target;
  }

  setStyle(styleId: string): string {
    if (styleId && !getStyleTemplate(styleId)) throw new Error(`未知的风格模板：${styleId}`);
    const config = this.config();
    config.style = styleId || "";
    this.writeRaw("writer.yaml", YAML.stringify(config));
    return config.style;
  }
}

function normalizeFolderPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/").replace(/^resource(?:\/|$)/, "");
}

function normalizeDocumentPath(path: string): string {
  return normalizeFolderPath(path).replace(/^resource(?:\/|$)/, "");
}
