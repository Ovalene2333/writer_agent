import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type { StyleTemplate, WriterConfig } from "./types.js";
import { getStyleTemplate, listStyleTemplates, normalizeStyleTemplate } from "./templates.js";

const DEFAULT_CONFIG: WriterConfig = {
  title: "未命名作品",
  language: "zh-CN",
  style: "",
};

export const DEFAULT_WRITER_INSTRUCTIONS = `# 项目指令

本文件会被 Writer Agent 自动加载（也支持 AGENTS.md / CLAUDE.md / .writer/instructions.md）。

## 作者偏好

- 语言：与 writer.yaml 一致
- 禁止事项：（在此填写硬性约束）
- 风格要点：（在此填写节奏、对白、视角等）

## 协作约定

- 多步任务用 manage_todos 维护清单
- 局部修改优先 propose_document_patch
- 设定进 lore/，大纲进 outline/，正文进 chapters/
`;

/** Document role inferred from path conventions under resource/. */
export type DocumentKind = "lore" | "outline" | "chapter" | "archive" | "side" | "other";

export function isSupportedTextFilePath(path: string): boolean {
  const name = basename(path.trim());
  return Boolean(name && name !== "." && name !== ".." && !name.includes("\0"));
}

/**
 * Archive / 屏蔽区路径：仅供人工浏览，Agent 一律不可 list/search/read。
 * 不依赖 agent-visibility 开关，取消「对 Agent 隐藏」也不能放行。
 */
export function isArchivePath(path: string): boolean {
  const normalized = normalizeDocumentPath(path);
  return normalized === "archive"
    || normalized.startsWith("archive/")
    || normalized === "屏蔽"
    || normalized.startsWith("屏蔽/");
}

export function documentKind(path: string): DocumentKind {
  const normalized = normalizeDocumentPath(path);
  if (normalized.startsWith("lore/") || normalized.startsWith("story/")) {
    return /(?:^|\/)(?:outline|大纲)[^/]*\.md$/i.test(normalized) ? "outline" : "lore";
  }
  if (normalized.startsWith("outline/") || /(?:^|\/)(?:outline|大纲)[^/]*\.md$/i.test(normalized)) return "outline";
  if (normalized.startsWith("chapters/")) return "chapter";
  if (isArchivePath(normalized)) return "archive";
  if (normalized.startsWith("side/") || normalized.startsWith("涩涩/")) return "side";
  return "other";
}

/** Long-form narrative documents assembled through the causal scene pipeline. */
export function isScenePipelineDocument(path: string): boolean {
  const kind = documentKind(path);
  return kind === "chapter" || kind === "side";
}

/** Chapter documents in the natural path order exposed by the file manager. */
export function orderedChapterPaths(project: WriterProject): string[] {
  return project.listDocuments()
    .filter(path => documentKind(path) === "chapter" && !project.isDocumentHidden(path));
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
    project.writeRaw("WRITER.md", DEFAULT_WRITER_INSTRUCTIONS);
    mkdirSync(resolve(project.privateDir, "skills"), { recursive: true });
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
    if (!parsed || typeof parsed.title !== "string") {
      throw new Error("writer.yaml 格式无效");
    }
    return {
      title: parsed.title,
      language: parsed.language || "zh-CN",
      style: typeof parsed.style === "string" ? parsed.style : "",
    };
  }

  customStyleTemplates(): StyleTemplate[] {
    const path = resolve(this.privateDir, "style-templates.json");
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error(".writer/style-templates.json 格式无效"); }
    if (!Array.isArray(parsed)) throw new Error(".writer/style-templates.json 必须是模板数组");
    return parsed.map((item, index) => {
      try { return normalizeStyleTemplate(item && typeof item === "object" ? item as Partial<StyleTemplate> : {}); }
      catch (error) { throw new Error(`自定义模板第 ${index + 1} 项无效：${error instanceof Error ? error.message : String(error)}`); }
    });
  }

  styleTemplates(): StyleTemplate[] {
    const builtIns = listStyleTemplates();
    const builtInIds = new Set(builtIns.map(template => template.id));
    // Built-ins are read-only: project overrides with the same id are ignored.
    const custom = this.customStyleTemplates().filter(template => !builtInIds.has(template.id));
    return [...builtIns, ...custom];
  }

  styleTemplate(id: string): StyleTemplate | undefined {
    const builtIn = getStyleTemplate(id);
    if (builtIn) return builtIn;
    return this.customStyleTemplates().find(template => template.id === id);
  }

  saveStyleTemplate(input: Partial<StyleTemplate>): StyleTemplate {
    const template = normalizeStyleTemplate(input);
    if (getStyleTemplate(template.id)) {
      throw new Error(`内置模板「${template.id}」不可编辑；请新建自定义模板（使用不同 ID）`);
    }
    const custom = this.customStyleTemplates().filter(item => !getStyleTemplate(item.id));
    const index = custom.findIndex(item => item.id === template.id);
    if (index >= 0) custom[index] = template;
    else custom.push(template);
    mkdirSync(this.privateDir, { recursive: true });
    const target = resolve(this.privateDir, "style-templates.json");
    const temporary = `${target}.writer-tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(custom, null, 2)}\n`, "utf8");
    try { renameSync(temporary, target); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      writeFileSync(target, `${JSON.stringify(custom, null, 2)}\n`, "utf8");
      try { unlinkSync(temporary); } catch { /* 临时文件不影响模板，下次保存时覆盖。 */ }
    }
    return template;
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

  resolveTextFileSafe(path: string): string {
    if (!path || isAbsolute(path)) throw new Error("文本文件路径必须是 resource/ 内的相对路径");
    const normalized = normalizeFolderPath(path).replace(/^resource(?:\/|$)/, "");
    if (!normalized || !isSupportedTextFilePath(normalized)) {
      throw new Error("只允许访问 resource/ 内的 UTF-8 纯文本文件");
    }
    const absolute = resolve(this.resourceDir, normalized);
    const rel = relative(this.resourceDir, absolute);
    if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(".writer")) {
      throw new Error("禁止访问 resource/ 范围外或内部数据库中的文件");
    }
    let cursor = this.resourceDir;
    for (const part of rel.split(sep).filter(Boolean)) {
      cursor = resolve(cursor, part);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
        throw new Error("禁止通过符号链接访问文本文件");
      }
    }
    return absolute;
  }

  textFileExists(path: string): boolean {
    try { return lstatSync(this.resolveTextFileSafe(path)).isFile(); }
    catch { return false; }
  }

  listTextFiles(): string[] {
    const results: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".writer" || entry.isSymbolicLink()) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) {
          const path = relative(this.resourceDir, absolute).split(sep).join("/");
          if (isSupportedTextFilePath(path) && isUtf8TextBuffer(readFileSync(absolute))) results.push(path);
        }
      }
    };
    if (existsSync(this.resourceDir)) visit(this.resourceDir);
    return results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  readTextFile(path: string): string {
    const buffer = readFileSync(this.resolveTextFileSafe(path));
    if (!isUtf8TextBuffer(buffer)) throw new Error("文件不是有效的 UTF-8 纯文本");
    const content = buffer.toString("utf8");
    return content;
  }

  writeTextFile(path: string, content: string): void {
    if (content.includes("\0")) throw new Error("纯文本内容不能包含 NUL 字节");
    const target = this.resolveTextFileSafe(path);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.writer-tmp-${process.pid}`;
    writeFileSync(temp, content, "utf8");
    try { renameSync(temp, target); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      writeFileSync(target, content, "utf8");
      try { unlinkSync(temp); } catch { /* best-effort temporary cleanup */ }
    }
  }

  removeTextFile(path: string): void {
    unlinkSync(this.resolveTextFileSafe(path));
  }

  renameTextFile(fromPath: string, toPath: string): void {
    const from = this.resolveTextFileSafe(fromPath);
    const to = this.resolveTextFileSafe(toPath);
    if (!existsSync(from)) throw new Error("源文本文件不存在");
    if (existsSync(to)) throw new Error("目标文本文件已存在");
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
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

  removeDocument(path: string): void {
    path = normalizeDocumentPath(path);
    unlinkSync(this.resolveSafe(path));
  }

  /**
   * If `desired` is free, return it; otherwise append `-归档` / `-归档2` / `-归档-a3f2`
   * until the path is free. Never overwrites an existing document or folder.
   */
  allocateUniquePath(desired: string, kind: "file" | "folder"): string {
    const basePath = kind === "file" ? normalizeDocumentPath(desired) : normalizeFolderPath(desired);
    if (!basePath) throw new Error("路径不能为空");
    const isTaken = (path: string) => {
      if (kind === "file") return this.documentExists(path) || this.folderExists(path);
      return this.folderExists(path) || this.documentExists(path);
    };
    if (!isTaken(basePath)) return basePath;

    const slash = basePath.lastIndexOf("/");
    const parent = slash >= 0 ? basePath.slice(0, slash + 1) : "";
    const name = slash >= 0 ? basePath.slice(slash + 1) : basePath;
    let stem = name;
    let ext = "";
    if (kind === "file") {
      const match = name.match(/^(.*?)(\.[^.]+)$/u);
      if (match) {
        stem = match[1];
        ext = match[2];
      }
    }

    for (let attempt = 0; attempt < 64; attempt += 1) {
      const suffix = attempt === 0
        ? "-归档"
        : attempt < 20
          ? `-归档${attempt + 1}`
          : `-归档-${createHash("sha1").update(`${basePath}:${attempt}:${Date.now()}`).digest("hex").slice(0, 6)}`;
      const candidate = `${parent}${stem}${suffix}${ext}`;
      if (!isTaken(candidate)) return candidate;
    }
    throw new Error(`无法为「${basePath}」分配不冲突的路径`);
  }

  /** @returns final destination path (may differ from toPath when uniqueIfExists renames). */
  renameDocument(fromPath: string, toPath: string, options?: { uniqueIfExists?: boolean }): string {
    fromPath = normalizeDocumentPath(fromPath);
    toPath = normalizeDocumentPath(toPath);
    if (fromPath.includes("\\") || toPath.includes("\\")) throw new Error("文档路径请使用 / 作为分隔符");
    const from = this.resolveSafe(fromPath);
    if (fromPath === toPath) return toPath;
    if (!existsSync(from)) throw new Error("原文档不存在");
    if (existsSync(this.resolveSafe(toPath))) {
      if (!options?.uniqueIfExists) throw new Error("目标文档已经存在");
      toPath = this.allocateUniquePath(toPath, "file");
    }
    const to = this.resolveSafe(toPath);
    const wasHidden = this.hiddenDocuments().includes(fromPath);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    if (wasHidden) this.writeVisibility([...this.hiddenDocuments(), toPath].filter(path => path !== fromPath).sort(), this.hiddenFolders());
    return toPath;
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
    // Hard block: archive is never agent-visible, regardless of visibility toggles.
    if (isArchivePath(path)) return true;
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

  /** @returns final destination folder path (may differ when uniqueIfExists renames). */
  renameFolder(fromPath: string, toPath: string, options?: { uniqueIfExists?: boolean }): string {
    const fromFolder = normalizeFolderPath(fromPath);
    let toFolder = normalizeFolderPath(toPath);
    if (!fromFolder || !toFolder) throw new Error("文件夹路径不能为空");
    if (fromFolder === toFolder) return toFolder;
    const from = this.resolveFolderSafe(fromFolder);
    if (!existsSync(from)) throw new Error("原文件夹不存在");
    if (existsSync(this.resolveFolderSafe(toFolder))) {
      if (!options?.uniqueIfExists) throw new Error("目标文件夹已经存在");
      toFolder = this.allocateUniquePath(toFolder, "folder");
    }
    if (toFolder.startsWith(`${fromFolder}/`)) throw new Error("不能把文件夹移动到自身的子文件夹内");
    const to = this.resolveFolderSafe(toFolder);
    const hiddenDocuments = this.hiddenDocuments();
    const hiddenFolders = this.hiddenFolders();
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);

    const rewritePath = (path: string) => path === fromFolder || path.startsWith(`${fromFolder}/`)
      ? `${toFolder}${path.slice(fromFolder.length)}`
      : path;
    this.writeVisibility(
      hiddenDocuments.map(rewritePath).sort(),
      hiddenFolders.map(rewritePath).sort(),
    );
    return toFolder;
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

  readSimpleCharacterCardsJsonl(): string {
    const target = resolve(this.charactersDir, "simple-characters.jsonl");
    return existsSync(target) ? readFileSync(target, "utf8") : "";
  }

  writeSimpleCharacterCardsJsonl(content: string): void {
    mkdirSync(this.charactersDir, { recursive: true });
    const target = resolve(this.charactersDir, "simple-characters.jsonl");
    const temporary = `${target}.writer-tmp-${process.pid}`;
    writeFileSync(temporary, content, "utf8");
    try { renameSync(temporary, target); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      writeFileSync(target, content, "utf8");
      try { unlinkSync(temporary); } catch { /* 临时文件不影响简易角色卡。 */ }
    }
  }

  backupV2CharacterCards(content: string): void {
    mkdirSync(this.charactersDir, { recursive: true });
    const target = resolve(this.charactersDir, "characters.v2.backup.jsonl");
    if (!existsSync(target)) writeFileSync(target, content, "utf8");
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
    const parts = orderedChapterPaths(this).map((path) => this.read(path));
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
    if (styleId && !this.styleTemplate(styleId)) throw new Error(`未知的风格模板：${styleId}`);
    const config = this.config();
    config.style = styleId || "";
    this.writeRaw("writer.yaml", YAML.stringify(config));
    return config.style;
  }
}

function isUtf8TextBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  return Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
}

function normalizeFolderPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/").replace(/^resource(?:\/|$)/, "");
}

function normalizeDocumentPath(path: string): string {
  return normalizeFolderPath(path).replace(/^resource(?:\/|$)/, "");
}
