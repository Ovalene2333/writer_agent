import React, { useState } from "react";
import {
  Archive, ArchiveRestore, BookOpenText, ChevronRight, Copy, Eye, EyeOff,
  FileText, Folder, FolderInput, FolderOpen, FolderPlus, History, Pencil, Plus, Trash2,
} from "lucide-react";
import { comparePathNames } from "../path_sort";
import type { ChapterSummary, TreeNode } from "./types";
import { IconButton, RowOverflowMenu } from "./ui_primitives";

export const ARCHIVE_ROOT = "archive";

export function isArchivedPath(path: string): boolean {
  return path === ARCHIVE_ROOT || path.startsWith(`${ARCHIVE_ROOT}/`);
}

/** Move under archive/ while preserving the original relative path. */
export function archiveDestinationPath(path: string): string {
  if (isArchivedPath(path)) return path;
  return `${ARCHIVE_ROOT}/${path}`;
}

/** Restore from archive/<original>. */
export function unarchiveDestinationPath(path: string): string | null {
  if (!isArchivedPath(path) || path === ARCHIVE_ROOT) return null;
  return path.slice(ARCHIVE_ROOT.length + 1);
}
export function buildTree(docs: string[], folders: string[], hiddenDocs: string[], hiddenFolders: string[]): TreeNode[] {
  const folderKey = (path: string) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const hiddenFolderKeys = new Set(hiddenFolders.map(folderKey));
  const folderMap = new Map<string, TreeNode>();
  for (const path of folders) {
    const key = folderKey(path);
    const parts = key.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    folderMap.set(key, {
      name: parts[parts.length - 1],
      path: key,
      kind: "folder",
      children: [],
      hidden: hiddenFolderKeys.has(key),
    });
  }

  const roots: TreeNode[] = [];
  for (const [key, node] of folderMap) {
    const slash = key.lastIndexOf("/");
    const parentPath = slash >= 0 ? key.slice(0, slash) : "";
    const parent = folderMap.get(parentPath);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const path of docs) {
    const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = normalizedPath.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/");
    const fileNode: TreeNode = {
      name,
      path: normalizedPath,
      kind: "file",
      children: [],
      hidden: hiddenDocs.includes(path) || hiddenDocs.includes(normalizedPath),
    };

    const parent = folderMap.get(parentPath);
    if (parent) {
      parent.children.push(fileNode);
    } else {
      roots.push(fileNode);
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      // Chinese chapter numerals + Arabic digits (第一章 < 第二章 < 第10章).
      return comparePathNames(a.name, b.name) || comparePathNames(a.path, b.path);
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return nodes;
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, normalized);
    const matches = node.name.toLocaleLowerCase().includes(normalized)
      || node.path.toLocaleLowerCase().includes(normalized);
    if (matches) return [node];
    return children.length ? [{ ...node, children }] : [];
  });
}

export function collectFolderPaths(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "folder"
    ? [node.path, ...collectFolderPaths(node.children)]
    : []);
}

export function countFiles(node: TreeNode): number {
  return node.kind === "file" ? 1 : node.children.reduce((total, child) => total + countFiles(child), 0);
}

export type ChapterGroup = { id: string; label: string; folderPath: string; chapters: ChapterSummary[] };

export function buildChapterGroups(chapters: ChapterSummary[], folders: string[]): ChapterGroup[] {
  const volumes = new Set<string>([""]);
  for (const folder of folders) {
    if (folder.startsWith("chapters/")) volumes.add(folder.slice("chapters/".length));
  }
  for (const chapter of chapters) volumes.add(chapter.volume);
  return [...volumes]
    .sort((a, b) => {
      if (!a) return -1;
      if (!b) return 1;
      return comparePathNames(a, b);
    })
    .map(volume => ({
      id: volume || "__ungrouped__",
      label: volume || "未分卷",
      folderPath: volume ? `chapters/${volume}` : "chapters",
      chapters: chapters
        .filter(chapter => chapter.volume === volume)
        .slice()
        .sort((a, b) => comparePathNames(a.title, b.title) || comparePathNames(a.path, b.path)),
    }));
}

export function ChapterManager({
  groups,
  query,
  activePath,
  readOnly,
  collapsed,
  onToggleGroup,
  onSelect,
  onVersions,
  onRename,
  onDelete,
  onDuplicate,
  onMove,
  onRequestMove,
  onArchive,
  onNewChapter,
}: {
  groups: ChapterGroup[];
  query: string;
  activePath: string;
  readOnly: boolean;
  collapsed: Set<string>;
  onToggleGroup: (id: string) => void;
  onSelect: (path: string) => void;
  onVersions: (path: string) => void;
  onRename: (path: string, kind: "file" | "folder") => void;
  onDelete: (path: string, kind: "file" | "folder") => void;
  onDuplicate: (path: string) => void;
  onMove: (path: string, kind: "file" | "folder", target: string) => void;
  onRequestMove: (chapter: ChapterSummary) => void;
  onArchive: (path: string, kind: "file" | "folder", label: string) => void;
  onNewChapter: (folderPath: string) => void;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = groups.flatMap(group => {
    const chapters = normalizedQuery
      ? group.chapters.filter(chapter => `${chapter.title} ${chapter.path}`.toLocaleLowerCase().includes(normalizedQuery))
      : group.chapters;
    return chapters.length || !normalizedQuery ? [{ ...group, chapters }] : [];
  });
  if (!visible.some(group => group.chapters.length)) {
    return (
      <div className="sidebar-empty compact">
        <BookOpenText size={24} aria-hidden="true" />
        <strong>{normalizedQuery ? "没有匹配的章节" : "还没有章节"}</strong>
        <span>{normalizedQuery ? "可按章节标题或路径搜索" : "从上方新建章节开始写作"}</span>
      </div>
    );
  }
  return (
    <div className="chapter-manager">
      {visible.map(group => {
        const isCollapsed = collapsed.has(group.id) && !normalizedQuery;
        const words = group.chapters.reduce((total, chapter) => total + chapter.wordCount, 0);
        return (
          <section
            className="chapter-group"
            key={group.id}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault();
              const raw = event.dataTransfer.getData("application/x-writer-node");
              if (!raw) return;
              const payload = JSON.parse(raw) as { path: string; kind: "file" | "folder" };
              if (payload.kind === "file") onMove(payload.path, payload.kind, group.folderPath);
            }}
          >
            <div className="chapter-group-head">
              <button type="button" className="chapter-group-toggle" onClick={() => onToggleGroup(group.id)}>
                <ChevronRight size={14} className={isCollapsed ? "" : "expanded"} />
                <span>{group.label}</span>
              </button>
              <span className="chapter-group-stats">{group.chapters.length} 章 · {words.toLocaleString("zh-CN")} 字</span>
              {!readOnly && (
                <div className="chapter-group-actions">
                  <IconButton label={`在${group.label}中新建章节`} onClick={() => onNewChapter(group.folderPath)}><Plus size={13} /></IconButton>
                  {group.id !== "__ungrouped__" && (
                    <RowOverflowMenu
                      label={`${group.label} · 更多`}
                      items={[
                        {
                          id: "rename",
                          label: "重命名卷",
                          icon: <Pencil size={13} />,
                          onSelect: () => onRename(group.folderPath, "folder"),
                        },
                        {
                          id: "archive",
                          label: "归档卷",
                          icon: <Archive size={13} />,
                          onSelect: () => onArchive(group.folderPath, "folder", group.label),
                        },
                        {
                          id: "delete",
                          label: "删除卷",
                          icon: <Trash2 size={13} />,
                          danger: true,
                          onSelect: () => onDelete(group.folderPath, "folder"),
                        },
                      ]}
                    />
                  )}
                </div>
              )}
            </div>
            {!isCollapsed && (
              <div className="chapter-list">
                {group.chapters.length === 0 ? (
                  <button type="button" className="chapter-group-empty" onClick={() => onNewChapter(group.folderPath)}>在本卷新建第一章</button>
                ) : group.chapters.map(chapter => (
                  <div
                    key={chapter.path}
                    className={`chapter-row${activePath === chapter.path ? " active" : ""}`}
                    draggable={!readOnly}
                    onDragStart={event => {
                      event.dataTransfer.setData("application/x-writer-node", JSON.stringify({ path: chapter.path, kind: "file" }));
                      event.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    <button type="button" className="chapter-open" onClick={() => onSelect(chapter.path)} title={chapter.path}>
                      <span className="chapter-title">{chapter.title}</span>
                      <span className="chapter-meta">
                        {chapter.wordCount.toLocaleString("zh-CN")} 字
                        {chapter.versionCount > 0 && <> · {chapter.versionCount} 个版本</>}
                      </span>
                    </button>
                    <div className="chapter-row-actions">
                      <IconButton label="版本历史" onClick={() => onVersions(chapter.path)}><History size={13} /></IconButton>
                      {!readOnly && (
                        <RowOverflowMenu
                          label={`${chapter.title} · 更多`}
                          items={[
                            {
                              id: "move",
                              label: "移动到其他卷",
                              icon: <FolderInput size={13} />,
                              onSelect: () => onRequestMove(chapter),
                            },
                            {
                              id: "duplicate",
                              label: "创建副本",
                              icon: <Copy size={13} />,
                              onSelect: () => onDuplicate(chapter.path),
                            },
                            {
                              id: "rename",
                              label: "重命名",
                              icon: <Pencil size={13} />,
                              onSelect: () => onRename(chapter.path, "file"),
                            },
                            {
                              id: "archive",
                              label: "归档章节",
                              icon: <Archive size={13} />,
                              onSelect: () => onArchive(chapter.path, "file", chapter.title),
                            },
                            {
                              id: "delete",
                              label: "删除章节",
                              icon: <Trash2 size={13} />,
                              danger: true,
                              onSelect: () => onDelete(chapter.path, "file"),
                            },
                          ]}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function FileTreeItem({
  node,
  depth,
  activePath,
  ancestorHidden = false,
  onSelect,
  onRename,
  onDelete,
  onToggleHidden,
  onMoveNode,
  onDuplicate,
  onNewChild,
  onArchive,
  onUnarchive,
  expandedFolders,
  setExpandedFolders,
}: {
  node: TreeNode;
  depth: number;
  activePath: string;
  ancestorHidden?: boolean;
  onSelect: (path: string) => void;
  onRename: (oldPath: string, kind: "file" | "folder") => void;
  onDelete: (path: string, kind: "file" | "folder") => void;
  onToggleHidden: (path: string, kind: "file" | "folder", current: boolean) => void;
  onMoveNode: (path: string, kind: "file" | "folder", targetFolder: string) => void;
  onDuplicate: (path: string) => void;
  onNewChild: (parentFolder: string, kind: "file" | "folder") => void;
  onArchive: (path: string, kind: "file" | "folder", label: string) => void;
  onUnarchive: (path: string, kind: "file" | "folder", label: string) => void;
  expandedFolders: Set<string>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const isExpanded = node.kind === "folder" && expandedFolders.has(node.path);
  const isEffectivelyHidden = ancestorHidden || node.hidden;
  const [dragOver, setDragOver] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-writer-node", JSON.stringify({ path: node.path, kind: node.kind }));
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (node.kind !== "folder") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData("application/x-writer-node");
    const payload = raw ? JSON.parse(raw) as { path: string; kind: "file" | "folder" } : null;
    if (payload && node.kind === "folder" && payload.path !== node.path) {
      onMoveNode(payload.path, payload.kind, node.path);
    }
  };

  const toggleFolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) {
        // Collapsing a branch also resets every nested folder. Reopening the
        // parent should not leave descendants visually expanded out of sync.
        for (const path of next) {
          if (path === node.path || path.startsWith(`${node.path}/`)) next.delete(path);
        }
      } else {
        next.add(node.path);
      }
      return next;
    });
  };

  const handleClick = () => {
    if (node.kind === "file") onSelect(node.path);
    else toggleFolder({ stopPropagation: () => {} } as React.MouseEvent);
  };

  return (
    <div className={`tree-node ${isEffectivelyHidden ? "agent-hidden" : ""} ${node.kind}`}>
      <div
        className={`tree-row ${activePath === node.path ? "active" : ""} ${dragOver ? "drop-target" : ""}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        aria-expanded={node.kind === "folder" ? isExpanded : undefined}
      >
        {node.kind === "folder" ? (
          <span className={`tree-arrow ${isExpanded ? "expanded" : ""}`} onClick={toggleFolder} aria-hidden="true">
            <ChevronRight size={13} />
          </span>
        ) : (
          <span className="tree-arrow-spacer" />
        )}
        <span className={`tree-icon ${node.kind === "folder" ? (isExpanded ? "folder-open" : "folder") : "file"}`} aria-hidden="true">
          {node.kind === "folder" ? (
            isExpanded ? (
              <FolderOpen size={15} />
            ) : (
              <Folder size={15} />
            )
          ) : (
            <FileText size={14} />
          )}
        </span>
        <span className="tree-label" title={node.path}>
          <span className="tree-name">{node.name}</span>
          {isArchivedPath(node.path) && node.path !== ARCHIVE_ROOT ? (
            <span className="tree-badge archived" title="已归档，不计入现行章节与 Agent 主事实">归档</span>
          ) : null}
          {node.kind === "folder" && <span className="tree-count">{countFiles(node)}</span>}
        </span>
        <div className="tree-actions">
          <button
            className="tree-action-btn"
            title={node.hidden ? "对 AI 显示" : "对 AI 隐藏"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden(node.path, node.kind, node.hidden);
            }}
          >
            {isEffectivelyHidden ? (
              <EyeOff size={13} aria-hidden="true" />
            ) : (
              <Eye size={13} aria-hidden="true" />
            )}
          </button>
          <RowOverflowMenu
            label={`${node.name} · 更多`}
            items={[
              ...(node.kind === "folder"
                ? [
                    {
                      id: "new-file",
                      label: "在此新建文档",
                      icon: <Plus size={13} />,
                      onSelect: () => onNewChild(node.path, "file"),
                    },
                    {
                      id: "new-folder",
                      label: "在此新建文件夹",
                      icon: <FolderPlus size={13} />,
                      onSelect: () => onNewChild(node.path, "folder"),
                    },
                  ]
                : [
                    {
                      id: "duplicate",
                      label: "创建副本",
                      icon: <Copy size={13} />,
                      onSelect: () => onDuplicate(node.path),
                    },
                  ]),
              {
                id: "rename",
                label: "重命名",
                icon: <Pencil size={13} />,
                onSelect: () => onRename(node.path, node.kind),
              },
              ...(node.path !== ARCHIVE_ROOT
                ? isArchivedPath(node.path)
                  ? [{
                      id: "unarchive",
                      label: node.kind === "folder" ? "取消归档文件夹" : "取消归档文件",
                      icon: <ArchiveRestore size={13} />,
                      onSelect: () => onUnarchive(node.path, node.kind, node.name),
                    }]
                  : [{
                      id: "archive",
                      label: node.kind === "folder" ? "归档文件夹" : "归档文件",
                      icon: <Archive size={13} />,
                      onSelect: () => onArchive(node.path, node.kind, node.name),
                    }]
                : []),
              {
                id: "delete",
                label: "删除",
                icon: <Trash2 size={13} />,
                danger: true,
                onSelect: () => onDelete(node.path, node.kind),
              },
            ]}
          />
        </div>
      </div>
      {isExpanded && (
        <div className="tree-children">
        {node.children.map((child) => (
          <FileTreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            ancestorHidden={isEffectivelyHidden}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
            onToggleHidden={onToggleHidden}
            onMoveNode={onMoveNode}
            onDuplicate={onDuplicate}
            onNewChild={onNewChild}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            expandedFolders={expandedFolders}
            setExpandedFolders={setExpandedFolders}
          />
        ))}
        </div>
      )}
    </div>
  );
}

