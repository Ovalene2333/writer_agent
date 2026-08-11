import { documentKind, normalizeResourcePath, type WriterProject } from "./project.js";

export type AutoVolumeSettings = {
  /** Route newly created chapters for one writing run into a fresh volume. */
  enabled: boolean;
};

export type VolumeAccessPolicy = {
  /** Existing volume roots whose chapter bodies this run may inspect. */
  allowedVolumes: string[];
  /** Volume receiving newly created chapter paths in this run. */
  activeVolume?: string;
  /** True when activeVolume was created for this run rather than selected. */
  autoCreated?: boolean;
};

export function chapterVolume(path: string): string | undefined {
  const normalized = normalizeResourcePath(path);
  if (documentKind(normalized) !== "chapter" || !normalized.startsWith("chapters/")) return undefined;
  const relative = normalized.slice("chapters/".length);
  const slash = relative.indexOf("/");
  return slash > 0 ? relative.slice(0, slash) : undefined;
}

export function chapterVolumeNames(project: WriterProject): string[] {
  return [...new Set(project.listTextFiles().flatMap(path => {
    const volume = chapterVolume(path);
    return volume ? [volume] : [];
  }))].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

/** Chapter paths whose ordinal sequence belongs to one destination container. */
export function chapterPathsInVolume(project: WriterProject, volume?: string): string[] {
  return project.listTextFiles()
    .filter(path => documentKind(path) === "chapter")
    .filter(path => chapterVolume(path) === volume);
}

export function volumePathAllowed(policy: VolumeAccessPolicy | undefined, path: string): boolean {
  const volume = chapterVolume(path);
  if (!volume) return true;
  return Boolean(policy?.allowedVolumes.includes(volume) || policy?.activeVolume === volume);
}

export function accessibleVolumeNames(policy: VolumeAccessPolicy | undefined): string[] {
  return [...new Set([
    ...(policy?.allowedVolumes ?? []),
    ...(policy?.activeVolume ? [policy.activeVolume] : []),
  ])];
}

export function assertVolumePathAllowed(
  policy: VolumeAccessPolicy | undefined,
  path: string,
): void {
  const volume = chapterVolume(path);
  if (!volume || volumePathAllowed(policy, path)) return;
  throw new Error(`卷「${volume}」默认只暴露名称；本轮意图未解锁该卷，不能访问其中章节`);
}

export function agentVisibleDocumentPaths(
  project: WriterProject,
  allowedVolumes: readonly string[] = [],
  explicitPaths: readonly string[] = [],
): string[] {
  const allowed = new Set(allowedVolumes);
  const explicit = new Set(explicitPaths.map(normalizeResourcePath));
  return project.listTextFiles()
    .filter(path => !project.isDocumentHidden(path))
    .filter(path => {
      const volume = chapterVolume(path);
      return !volume || allowed.has(volume) || explicit.has(path);
    });
}

export function normalizeVolumeName(value: string): string | undefined {
  const normalized = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^\.+|\.+$/gu, "")
    .trim()
    .slice(0, 40)
    .trim();
  return normalized || undefined;
}

export function uniqueVolumeName(project: WriterProject, preferred?: string): string {
  const base = normalizeVolumeName(preferred ?? "") ?? "新卷";
  const existing = new Set(chapterVolumeNames(project));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("无法生成不重复的卷名");
}

export function routeNewChapterPath(
  project: WriterProject,
  path: string,
  policy: VolumeAccessPolicy | undefined,
): string {
  const normalized = normalizeResourcePath(path);
  if (documentKind(normalized) !== "chapter") return normalized;
  const currentVolume = chapterVolume(normalized);
  if (currentVolume) {
    assertVolumePathAllowed(policy, normalized);
    return normalized;
  }
  if (!policy?.activeVolume) return normalized;
  const fileName = normalized.slice("chapters/".length);
  return `chapters/${policy.activeVolume}/${fileName}`;
}
