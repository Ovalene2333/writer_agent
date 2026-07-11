import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelConfig, type ProviderCatalog } from "./model_config";
import "./style.css";

type Proposal = {
  id: number;
  path: string;
  summary: string;
  beforeContent: string;
  afterContent: string;
  status: "pending" | "accepted" | "rejected" | "stale";
};
type Message = { id: number; role: string; content: string };
type DocumentData = { content: string; hash: string };
type MarkdownHeading = { id: string; level: number; text: string };
type Character = {
  schemaVersion: 2; id: number; name: string; aliases: string[]; narrativeRole: string; identity: string; appearance: string;
  personality: string; values: string; speechStyle: string; background: string; longTermGoal: string;
  currentGoal: string; fears: string; capabilities: string; limitations: string;
  relationships: Array<{ characterId: number; type: string; description: string; attitude: string }>;
  notes: string; updatedAt: string;
};
type CharacterDraft = Omit<Character, "id" | "updatedAt"> & { id?: number };
type StreamStep = {
  id: number;
  output: string;
  reasoning: string;
  tools: string[];
  status: "running" | "completed" | "failed";
  expanded: boolean;
};
type AgentJob = {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
};
type AgentStreamEvent = {
  type: string;
  step?: number;
  text?: string;
  channel?: "output" | "reasoning";
  name?: string;
  message?: string;
  sessionId?: string;
  question?: string;
  options?: string[];
  proposal?: { id: number; path: string; summary: string; beforeContent: string; afterContent: string; status: "pending" };
};
type Usage = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  cost: number;
  currency: string;
  lastPromptTokens: number;
};
type Provider = {
  provider: "deepseek" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  source: "project" | "environment";
  pricing: { cacheHit: number; cacheMiss: number; output: number; currency: "CNY" | "USD"; contextWindow: number };
  temperature?: number;
  topP?: number;
};
type State = {
  config: { title: string; style?: string };
  documents: string[];
  documentFolders: string[];
  hiddenDocuments: string[];
  hiddenFolders: string[];
  sessionId: string;
  messages: Message[];
  proposals: Proposal[];
  sessions: Array<{ id: string; title: string; updatedAt: string }>;
  characters: Character[];
  usage: Usage;
  provider: Provider;
  providerCatalog: ProviderCatalog;
  activeJobs?: AgentJob[];
  styleTemplates?: Array<{ id: string; name: string }>;
};

type TreeNode = {
  name: string;
  path: string;
  kind: "file" | "folder";
  children: TreeNode[];
  hidden: boolean;
};

const EMPTY_CHARACTER: CharacterDraft = {
  schemaVersion: 2, name: "", aliases: [], narrativeRole: "", identity: "", appearance: "", personality: "",
  values: "", speechStyle: "", background: "", longTermGoal: "", currentGoal: "", fears: "",
  capabilities: "", limitations: "", relationships: [], notes: "",
};

const hashToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (hashToken) {
  localStorage.setItem("writer-token", hashToken);
  history.replaceState(null, "", location.pathname + location.search);
}
const token = localStorage.getItem("writer-token") ?? sessionStorage.getItem("writer-token") ?? "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init?.body != null) headers["content-type"] = "application/json";
  if (init?.headers) Object.assign(headers, init.headers);
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) throw new Error((body.error as string) || `Request failed: ${response.status}`);
  return body as T;
}

function activeStepIndex(steps: StreamStep[]): number {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].status === "running") return i;
  }
  return -1;
}

function markdownHeadings(content: string, prefix: string): MarkdownHeading[] {
  return [...content.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)].map((match, index) => ({
    id: `${prefix}-section-${index + 1}`,
    level: match[1].length,
    text: match[2].replace(/\s+#+\s*$/, "").trim(),
  }));
}

function Markdown({ content, className, headingPrefix }: { content: string; className?: string; headingPrefix?: string }) {
  let headingIndex = 0;
  const html = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^(#{1,6})\s+(.+?)\s*$/gm, (_match, hashes: string, title: string) => {
      const level = hashes.length;
      const id = headingPrefix ? ` id="${headingPrefix}-section-${++headingIndex}"` : "";
      return `<h${level}${id}>${title.replace(/\s+#+\s*$/, "")}</h${level}>`;
    })
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br/>");

  return (
    <div
      className={`markdown ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: `<p>${html}</p>` }}
    />
  );
}

function buildTree(docs: string[], folders: string[], hiddenDocs: string[], hiddenFolders: string[]): TreeNode[] {
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
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

function FileTreeItem({
  node,
  depth,
  activePath,
  ancestorHidden = false,
  onSelect,
  onRename,
  onDelete,
  onToggleHidden,
  onDropFile,
  onNewChild,
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
  onDropFile: (filePath: string, targetFolder: string) => void;
  onNewChild: (parentFolder: string, kind: "file" | "folder") => void;
  expandedFolders: Set<string>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const isExpanded = node.kind === "folder" && expandedFolders.has(node.path);
  const isEffectivelyHidden = ancestorHidden || node.hidden;
  const [dragOver, setDragOver] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
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
    const filePath = e.dataTransfer.getData("text/plain");
    if (filePath && node.kind === "folder" && filePath !== node.path) {
      onDropFile(filePath, node.path);
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
        draggable={node.kind === "file"}
        onDragStart={node.kind === "file" ? handleDragStart : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        aria-expanded={node.kind === "folder" ? isExpanded : undefined}
      >
        {node.kind === "folder" ? (
          <span className={`tree-arrow ${isExpanded ? "expanded" : ""}`} onClick={toggleFolder} />
        ) : (
          <span className="tree-arrow-spacer" />
        )}
        <span className="tree-icon" aria-hidden="true">
          {node.kind === "folder" ? (isExpanded ? "📂" : "📁") : "·"}
        </span>
        <span className="tree-label" title={node.path}>
          <span className="tree-name">{node.name}</span>
        </span>
        <div className="tree-actions">
          <button
            className="tree-action-btn"
            title={node.hidden ? "Show to AI" : "Hide from AI"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden(node.path, node.kind, node.hidden);
            }}
          >
            {isEffectivelyHidden ? "◉" : "○"}
          </button>
          {node.kind === "folder" && (
            <button
              className="tree-action-btn"
              title="New file in folder"
              onClick={(e) => {
                e.stopPropagation();
                onNewChild(node.path, "file");
              }}
            >
              +
            </button>
          )}
          <button
            className="tree-action-btn"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              onRename(node.path, node.kind);
            }}
          >
            ✎
          </button>
          <button
            className="tree-action-btn danger"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path, node.kind);
            }}
          >
            ×
          </button>
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
            onDropFile={onDropFile}
            onNewChild={onNewChild}
            expandedFolders={expandedFolders}
            setExpandedFolders={setExpandedFolders}
          />
        ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [state, setState] = useState<State>();
  const [activePath, setActivePath] = useState("");
  const [document, setDocument] = useState<DocumentData>({ content: "", hash: "" });
  const [documentDraft, setDocumentDraft] = useState("");
  const [editingDocument, setEditingDocument] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [streamSteps, setStreamSteps] = useState<StreamStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileTab, setMobileTab] = useState<"docs" | "editor" | "agent">("editor");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("writer-theme") === "dark" ? "dark" : "light",
  );
  const [managementView, setManagementView] = useState<"characters" | "sessions" | null>(null);
  const [characterDraft, setCharacterDraft] = useState<CharacterDraft | null>(null);
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ path: string; kind: "file" | "folder" } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "folder" } | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Number(localStorage.getItem("writer-sidebar-w")) || 248,
  );
  const [agentWidth, setAgentWidth] = useState(() =>
    Number(localStorage.getItem("writer-agent-w")) || 380,
  );
  const [readerFontSize, setReaderFontSize] = useState(() =>
    Number(localStorage.getItem("writer-reader-fs")) || 16,
  );
  const [readerWidth, setReaderWidth] = useState(() =>
    Number(localStorage.getItem("writer-reader-w")) || 760,
  );
  const [outlineCollapsed, setOutlineCollapsed] = useState(() =>
    localStorage.getItem("writer-outline-collapsed") === "true",
  );
  const [resizing, setResizing] = useState<"sidebar" | "agent" | null>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const currentJobRef = useRef<string | undefined>(undefined);
  const streamOutputRef = useRef("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const documentReaderRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const headings = useMemo(() => markdownHeadings(document.content, "document"), [document.content]);

  const refresh = useCallback(
    async (targetSession?: string) => {
      const next = await api<State>(
        `/api/state${targetSession ? `?session=${encodeURIComponent(targetSession)}` : ""}`,
      );
      setState(next);
      if (!activePath && next.documents[0]) setActivePath(next.documents[0]);
    },
    [activePath],
  );

  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    window.document.documentElement.dataset.theme = theme;
    localStorage.setItem("writer-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("writer-outline-collapsed", String(outlineCollapsed));
  }, [outlineCollapsed]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
    root.style.setProperty("--agent-w", `${agentWidth}px`);
    root.style.setProperty("--reader-font-size", `${readerFontSize}px`);
    root.style.setProperty("--reader-width", `${readerWidth}px`);
    localStorage.setItem("writer-sidebar-w", String(sidebarWidth));
    localStorage.setItem("writer-agent-w", String(agentWidth));
    localStorage.setItem("writer-reader-fs", String(readerFontSize));
    localStorage.setItem("writer-reader-w", String(readerWidth));
  }, [sidebarWidth, agentWidth, readerFontSize, readerWidth]);

  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e: MouseEvent) => {
      if (resizing === "sidebar") {
        setSidebarWidth((w) => Math.max(180, Math.min(480, w + e.movementX)));
      } else {
        setAgentWidth((w) => Math.max(240, Math.min(560, w - e.movementX)));
      }
    };
    const handleUp = () => setResizing(null);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [resizing]);

  useEffect(() => {
    if (!activePath) return;
    void api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`)
      .then((value) => {
        setDocument(value);
        setDocumentDraft(value.content);
        setEditingDocument(false);
      })
      .catch((e) => setError(String(e)));
  }, [activePath]);

  useEffect(() => {
    if (renaming && renameInputRef.current) renameInputRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    if (creating && createInputRef.current) createInputRef.current.focus();
  }, [creating]);

  function handleAgentEvent(event: AgentStreamEvent) {
    if (event.type === "step_start") {
      setStreamSteps((current) => {
        const id = event.step ?? current.length + 1;
        if (current.some((s) => s.id === id)) return current;
        return [...current, { id, output: "", reasoning: "", tools: [], status: "running", expanded: true }];
      });
    }
    if (event.type === "text" && event.text) {
      if (event.channel !== "reasoning") streamOutputRef.current += event.text;
      setStreamSteps((current) => {
        const idx = activeStepIndex(current);
        if (idx < 0) return current;
        const key = event.channel === "reasoning" ? "reasoning" : "output";
        return current.map((s, i) => (i === idx ? { ...s, [key]: s[key] + event.text } : s));
      });
    }
    if (event.type === "tool" && event.name) {
      setStreamSteps((current) => {
        const idx = activeStepIndex(current);
        return current.map((s, i) => (i === idx ? { ...s, tools: [...s.tools, event.name!] } : s));
      });
    }
    if (event.type === "step_done") {
      setStreamSteps((current) =>
        current.map((s) => (s.id === event.step ? { ...s, status: "completed", expanded: false } : s)),
      );
    }
    if (event.type === "error") {
      setError(event.message || "Agent failed");
      setStreamSteps((current) =>
        current.map((s) => (s.status === "running" ? { ...s, status: "failed", expanded: true } : s)),
      );
    }
    if (event.type === "waiting_for_input") {
      setNotice("");
    }
    if (event.type === "proposal" && event.proposal) {
      setState((prev) => prev ? { ...prev, proposals: [event.proposal!, ...prev.proposals] } : prev);
    }
  }

  async function subscribeAgentJob(jobId: string, sessionId: string, clearContextOnDone = false) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    currentJobRef.current = jobId;
    setBusy(true);
    try {
      const response = await fetch(`/api/chat/jobs/${encodeURIComponent(jobId)}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Cannot connect to Agent job");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminal = false;
      let waitingForInput = false;
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const line = block.split(/\r?\n/).find((item) => item.startsWith("data:"));
          if (!line) continue;
          const event = JSON.parse(line.slice(5)) as AgentStreamEvent;
          handleAgentEvent(event);
          if (event.type === "waiting_for_input") waitingForInput = true;
          if (event.type === "done" || event.type === "cancelled" || event.type === "error" || event.type === "waiting_for_input") terminal = true;
        }
        if (done) break;
      }
      if (terminal) {
        await refresh(sessionId);
        if (clearContextOnDone && !waitingForInput) setNotice("Agent job completed.");
      }
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError")) {
        setNotice("Connection interrupted. The background job is still running on the server.");
        await refresh(sessionId).catch((e) => setError(String(e)));
      }
    } finally {
      streamOutputRef.current = "";
      if (currentJobRef.current === jobId) {
        abortRef.current = undefined;
        currentJobRef.current = undefined;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const job = state?.activeJobs?.[0];
    if (!job || currentJobRef.current === job.id) return;
    setStreamSteps([]);
    streamOutputRef.current = "";
    void subscribeAgentJob(job.id, job.sessionId);
  }, [state?.activeJobs?.[0]?.id]);

  async function sendChat() {
    if (!state || busy || !prompt.trim()) return;
    const text = prompt.trim();
    setPrompt("");
    setError("");
    setNotice("");
    setStreamSteps([]);
    streamOutputRef.current = "";
    setState((value) =>
      value
        ? { ...value, messages: [...value.messages, { id: -Date.now(), role: "user", content: text }] }
        : value,
    );
    try {
      const result = await api<{ jobId: string }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.sessionId,
          prompt: text,
          characterScope: state.characters.map((c) => c.id),
        }),
      });
      await subscribeAgentJob(result.jobId, state.sessionId, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  function stop() {
    const jobId = currentJobRef.current;
    if (jobId) void api(`/api/chat/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    abortRef.current?.abort();
  }

  async function rewindMessage(message: Message) {
    if (!state || busy || message.role !== "user") return;
    if (!window.confirm("从这条消息重新编辑？此消息之后的对话、已接受文档修改和角色卡修改将一并回退。")) return;
    setError("");
    setNotice("");
    try {
      const result = await api<{ prompt: string }>(
        `/api/messages?session=${encodeURIComponent(state.sessionId)}&target=${message.id}`,
        { method: "DELETE" },
      );
      setPrompt(result.prompt);
      await refresh(state.sessionId);
      if (activePath) {
        try {
          const next = await api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`);
          setDocument(next);
          setDocumentDraft(next.content);
        } catch {
          setDocument({ content: "", hash: "" });
          setDocumentDraft("");
        }
      }
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveDocument() {
    if (!activePath) return;
    const result = await api<{ hash: string }>("/api/document", {
      method: "PUT",
      body: JSON.stringify({ path: activePath, content: documentDraft, baseHash: document.hash }),
    });
    setDocument({ content: documentDraft, hash: result.hash });
    setEditingDocument(false);
    await refresh(state?.sessionId);
  }

  function cancelEdit() {
    setEditingDocument(false);
    setDocumentDraft(document.content);
  }

  async function decide(proposal: Proposal, action: "accept" | "reject") {
    try {
      await api(`/api/proposals/${proposal.id}/${action}`, { method: "POST" });
      await refresh(state?.sessionId);
      if (action === "accept" && proposal.path === activePath) {
        const next = await api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`);
        setDocument(next);
        setDocumentDraft(next.content);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRename(oldPath: string, kind: "file" | "folder") {
    setRenaming({ path: oldPath, kind });
    setRenameValue(oldPath.split("/").pop()!);
  }

  async function submitRename() {
    if (!renaming || !renameValue.trim()) {
      setRenaming(null);
      return;
    }
    const oldPath = renaming.path;
    const parts = oldPath.split("/");
    parts[parts.length - 1] = renameValue.trim();
    if (renaming.kind === "file" && !parts[parts.length - 1].endsWith(".md")) {
      parts[parts.length - 1] += ".md";
    }
    const newPath = parts.join("/");
    try {
      const endpoint = renaming.kind === "file" ? "/api/document/rename" : "/api/folder/rename";
      await api(endpoint, {
        method: "PUT",
        body: JSON.stringify({ fromPath: oldPath, toPath: newPath }),
      });
      if (activePath === oldPath) setActivePath(newPath);
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
    setRenaming(null);
  }

  async function handleDelete(path: string, kind: "file" | "folder") {
    const label = kind === "file" ? "document" : "folder";
    if (!confirm(`Delete ${label} "${path}"? This cannot be undone.`)) return;
    try {
      const endpoint = kind === "file" ? "/api/document" : "/api/folder";
      await api(`${endpoint}?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      if (activePath === path) setActivePath("");
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleToggleHidden(path: string, kind: "file" | "folder", current: boolean) {
    try {
      const endpoint = kind === "file" ? "/api/document/visibility" : "/api/folder/visibility";
      await api(endpoint, {
        method: "PUT",
        body: JSON.stringify({ path, hidden: !current }),
      });
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDropFile(filePath: string, targetFolder: string) {
    const parts = filePath.split("/");
    const name = parts.pop()!;
    const newPath = `${targetFolder}/${name}`;
    if (newPath === filePath) return;
    try {
      await api("/api/document/rename", {
        method: "PUT",
        body: JSON.stringify({ fromPath: filePath, toPath: newPath }),
      });
      if (activePath === filePath) setActivePath(newPath);
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleNewChild(parent: string, kind: "file" | "folder") {
    setCreating({ parent, kind });
    setCreateValue(kind === "file" ? "new-document" : "new-folder");
  }

  async function submitCreate() {
    if (!creating || !createValue.trim()) {
      setCreating(null);
      return;
    }
    const name = createValue.trim();
    const fullPath = creating.parent
      ? `${creating.parent}/${name}${creating.kind === "file" && !name.endsWith(".md") ? ".md" : ""}`
      : `${name}${creating.kind === "file" && !name.endsWith(".md") ? ".md" : ""}`;
    try {
      if (creating.kind === "file") {
        await api("/api/document", {
          method: "POST",
          body: JSON.stringify({ path: fullPath, content: "# New Document\n\n" }),
        });
      } else {
        await api("/api/folder", {
          method: "POST",
          body: JSON.stringify({ path: fullPath }),
        });
      }
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(creating.parent);
        return next;
      });
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
    setCreating(null);
  }

  async function saveCharacter() {
    if (!characterDraft?.name.trim()) return;
    await api("/api/characters", { method: "POST", body: JSON.stringify(characterDraft) });
    setCharacterDraft(null);
    await refresh(state?.sessionId);
  }

  function openProviderSettings() {
    setShowModelConfig(true);
  }

  async function deleteCharacter(character: Character) {
    if (!confirm(`Delete character “${character.name}”?`)) return;
    await api(`/api/characters/${character.id}`, { method: "DELETE" });
    setCharacterDraft(null);
    await refresh(state?.sessionId);
  }

  async function renameSession(id: string, currentTitle: string) {
    const title = window.prompt("Session title", currentTitle)?.trim();
    if (!title || title === currentTitle) return;
    await api(`/api/session/${id}`, { method: "PUT", body: JSON.stringify({ title }) });
    await refresh(state?.sessionId);
  }

  async function deleteSession(id: string) {
    if (!confirm("Delete this session? This cannot be undone.")) return;
    await api(`/api/session/${id}`, { method: "DELETE" });
    await refresh(id === state?.sessionId ? undefined : state?.sessionId);
  }

  const tree = useMemo(() => {
    if (!state) return [];
    return buildTree(state.documents, state.documentFolders, state.hiddenDocuments, state.hiddenFolders);
  }, [state?.documents, state?.documentFolders, state?.hiddenDocuments, state?.hiddenFolders]);

  if (!state) {
    return (
      <main className="app-shell">
        <p>{error || "Loading..."}</p>
      </main>
    );
  }

  const pendingProposals = state.proposals.filter((p) => p.status === "pending");
  const visibleMessages = state.messages.filter((msg) => (msg.role === "user" || msg.role === "assistant") && msg.content.trim());
  const lastUserMessageId = [...visibleMessages].reverse().find(msg => msg.role === "user")?.id;
  const usagePct = state.provider.pricing.contextWindow
    ? Math.round((state.usage.lastPromptTokens / state.provider.pricing.contextWindow) * 100)
    : 0;

  return (
    <div className="app">
      <div
        className={`resize-handle${resizing === "sidebar" ? " active" : ""}`}
        style={{ left: `calc(var(--sidebar-w, 248px) - 2.5px)` }}
        onMouseDown={() => setResizing("sidebar")}
      />
      <div
        className={`resize-handle${resizing === "agent" ? " active" : ""}`}
        style={{ right: `calc(var(--agent-w, 380px) - 2.5px)` }}
        onMouseDown={() => setResizing("agent")}
      />
      <header>
        <div className="header-left">
          <span className="logo"><span className="logo-mark">W</span><span>Writer</span></span>
          <h1>{state.config.title || "Writer Agent"}</h1>
        </div>
        <div className="header-right">
          <button className="usage-strip" onClick={openProviderSettings} title="Open model configuration">
            <span className="model-name">{state.provider.model}</span>
            <span title="Context window used">{usagePct}% context</span>
            <span>{state.usage.totalTokens.toLocaleString()} tokens</span>
            <span className="usage-number">
              {state.usage.currency === "CNY" ? "¥" : "$"}{state.usage.cost.toFixed(4)}
            </span>
            <span className="settings-glyph" aria-hidden="true">⚙</span>
          </button>
          <button className="ghost nav-action" onClick={() => setManagementView("characters")}>Characters</button>
          <button className="ghost nav-action" onClick={() => setManagementView("sessions")}>Sessions</button>
          <button
            className="icon"
            title={theme === "dark" ? "Use light mode" : "Use dark mode"}
            aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}
            onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☀" : "◐"}
          </button>
          <button
            className="ghost"
            title="New session"
            onClick={async () => {
              const r = await api<{ sessionId: string }>("/api/session", { method: "POST" });
              await refresh(r.sessionId);
            }}
          >
            + New
          </button>
          <button className="ghost" onClick={() => void refresh(state.sessionId)} title="Refresh">
            Refresh
          </button>
        </div>
      </header>

      <div className="mobile-tabs">
        <button className={mobileTab === "docs" ? "active" : ""} onClick={() => setMobileTab("docs")}>
          <span className="tab-icon" aria-hidden="true">☷</span><span>Docs</span>
        </button>
        <button className={mobileTab === "editor" ? "active" : ""} onClick={() => setMobileTab("editor")}>
          <span className="tab-icon" aria-hidden="true">✎</span><span>Editor</span>
        </button>
        <button className={mobileTab === "agent" ? "active" : ""} onClick={() => setMobileTab("agent")}>
          <span className="tab-icon" aria-hidden="true">✦</span><span>Agent</span>
        </button>
      </div>

      <aside className={`documents ${mobileTab === "docs" ? "mobile-active" : ""}`}>
        <div className="file-manager-actions">
          <button
            onClick={() => {
              setCreating({ parent: "", kind: "file" });
              setCreateValue("new-document");
            }}
          >
            + Document
          </button>
          <button
            onClick={() => {
              setCreating({ parent: "", kind: "folder" });
              setCreateValue("new-folder");
            }}
          >
            + Folder
          </button>
        </div>

        {renaming && (
          <div className="inline-edit">
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={submitRename}
              placeholder="New name..."
            />
          </div>
        )}

        {creating && (
          <div className="inline-edit">
            <input
              ref={createInputRef}
              value={createValue}
              onChange={(e) => setCreateValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
                if (e.key === "Escape") setCreating(null);
              }}
              onBlur={submitCreate}
              placeholder={creating.kind === "file" ? "filename.md" : "folder-name"}
            />
          </div>
        )}

        <div className="sidebar-section docs">
          {tree.length === 0 ? (
            <div className="sidebar-empty">No documents yet</div>
          ) : (
            <div className="document-tree">
              {tree.map((node) => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  activePath={activePath}
                  onSelect={(path) => {
                    setActivePath(path);
                    setMobileTab("editor");
                  }}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onToggleHidden={handleToggleHidden}
                  onDropFile={handleDropFile}
                  onNewChild={handleNewChild}
                  expandedFolders={expandedFolders}
                  setExpandedFolders={setExpandedFolders}
                />
              ))}
            </div>
          )}
        </div>

      </aside>

      <main className={`editor ${mobileTab === "editor" ? "mobile-active" : ""}`}>
        <div className="editor-bar">
          <span className="doc-path">{activePath || "No document selected"}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {!editingDocument && document.content && (
              <div className="reader-controls">
                <div className="ctrl-group">
                  <span className="ctrl-label">A</span>
                  <button onClick={() => setReaderFontSize((v) => Math.max(12, v - 1))} title="Decrease font size">-</button>
                  <span className="ctrl-val">{readerFontSize}</span>
                  <button onClick={() => setReaderFontSize((v) => Math.min(24, v + 1))} title="Increase font size">+</button>
                </div>
                <div className="ctrl-group">
                  <span className="ctrl-label">W</span>
                  <button onClick={() => setReaderWidth((v) => Math.max(420, v - 60))} title="Narrower margins">-</button>
                  <span className="ctrl-val">{readerWidth}</span>
                  <button onClick={() => setReaderWidth((v) => Math.min(1200, v + 60))} title="Wider margins">+</button>
                </div>
              </div>
            )}
            <div className="editor-bar-actions">
              {editingDocument ? (
                <>
                  <button onClick={cancelEdit}>Cancel</button>
                  <button className="primary" onClick={() => void saveDocument()}>
                    Save
                  </button>
                </>
              ) : (
                <button disabled={!activePath} onClick={() => setEditingDocument(true)}>
                  Edit
                </button>
              )}
            </div>
          </div>
        </div>
        {editingDocument ? (
          <textarea value={documentDraft} onChange={(e) => setDocumentDraft(e.target.value)} />
        ) : (
          <div className="document-reader" ref={documentReaderRef}>
            {document.content ? (
              <div className={`document-reader-layout ${outlineCollapsed ? "outline-collapsed" : ""}`}>
                {headings.length > 0 && (
                  <nav className={`document-outline ${outlineCollapsed ? "collapsed" : ""}`} aria-label="Document sections">
                    <div className="document-outline-head">
                      {!outlineCollapsed && <strong>Sections</strong>}
                      <button
                        className="document-outline-toggle"
                        onClick={() => setOutlineCollapsed((value) => !value)}
                        title={outlineCollapsed ? "Expand sections" : "Collapse sections"}
                        aria-label={outlineCollapsed ? "Expand sections" : "Collapse sections"}
                        aria-expanded={!outlineCollapsed}
                      >
                        {outlineCollapsed ? "☰" : "‹"}
                      </button>
                    </div>
                    {!outlineCollapsed && headings.map((heading) => (
                        <button
                          key={heading.id}
                          className={`document-outline-item level-${heading.level}`}
                          title={heading.text}
                          onClick={() => documentReaderRef.current?.querySelector(`#${heading.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                        >
                          {heading.text}
                        </button>
                      ))}
                  </nav>
                )}
                <Markdown content={document.content} headingPrefix="document" />
              </div>
            ) : (
              <div className="empty-state">
                <p>Select a document to read</p>
                <span className="empty-hint">Choose a file from the sidebar</span>
              </div>
            )}
          </div>
        )}
      </main>

      <section className={`agent-panel ${mobileTab === "agent" ? "mobile-active" : ""}`}>
        <div className="agent-head">
          <h2>Agent</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={`agent-status ${busy ? "running" : ""}`}>{busy ? "Running" : "Idle"}</span>
            {busy && (
              <button className="agent-stop-btn" onClick={stop}>
                Stop
              </button>
            )}
          </div>
        </div>
        <div className="conversation">
          {visibleMessages.map((msg) => (
            <React.Fragment key={msg.id}>
            <article className={msg.role}>
              <div className="msg-label">{msg.role === "assistant" ? "Assistant" : "You"}</div>
              {msg.role === "assistant" ? (
                <Markdown content={msg.content} />
              ) : (
                <>
                  <div>{msg.content}</div>
                  {msg.id > 0 && <div className="message-actions">
                    <button disabled={busy} onClick={() => void rewindMessage(msg)} title="Edit from this message">Edit</button>
                  </div>}
                </>
              )}
            </article>
            {msg.id === lastUserMessageId && streamSteps.map((step) => (
            <article className={`agent-step ${step.status}`} key={step.id}>
              <button
                className="agent-step-summary"
                onClick={() =>
                  setStreamSteps((current) =>
                    current.map((s) => (s.id === step.id ? { ...s, expanded: !s.expanded } : s)),
                  )
                }
              >
                <span className="agent-step-indicator" />
                <strong>
                  {step.status === "running"
                    ? `Step ${step.id}`
                    : step.status === "failed"
                      ? `Step ${step.id} failed`
                      : `Step ${step.id} done`}
                </strong>
                {step.tools.length > 0 && (
                  <span className="agent-step-tools">{step.tools.join(", ")}</span>
                )}
                <span className="agent-step-chevron">{step.expanded ? "^" : "v"}</span>
              </button>
              {step.expanded && (
                <div className="agent-step-content">
                  {step.reasoning && (
                    <div className="agent-step-reasoning">
                      <Markdown content={step.reasoning} />
                    </div>
                  )}
                  {step.output && <Markdown content={step.output} />}
                  {!step.reasoning && !step.output && (
                    <p className="agent-step-waiting">Waiting for model response...</p>
                  )}
                </div>
              )}
            </article>
            ))}
            </React.Fragment>
          ))}
          {!lastUserMessageId && streamSteps.map((step) => (
            <article className={`agent-step ${step.status}`} key={step.id}>
              <button className="agent-step-summary" onClick={() => setStreamSteps((current) => current.map((s) => (s.id === step.id ? { ...s, expanded: !s.expanded } : s)))}>
                <span className="agent-step-indicator" />
                <strong>{step.status === "running" ? `Step ${step.id}` : step.status === "failed" ? `Step ${step.id} failed` : `Step ${step.id} done`}</strong>
                {step.tools.length > 0 && <span className="agent-step-tools">{step.tools.join(", ")}</span>}
                <span className="agent-step-chevron">{step.expanded ? "^" : "v"}</span>
              </button>
              {step.expanded && <div className="agent-step-content">
                {step.reasoning && <div className="agent-step-reasoning"><Markdown content={step.reasoning} /></div>}
                {step.output && <Markdown content={step.output} />}
                {!step.reasoning && !step.output && <p className="agent-step-waiting">Waiting for model response...</p>}
              </div>}
            </article>
          ))}
          {state.messages.length === 0 && streamSteps.length === 0 && (
            <div className="empty-state">
              <p>Start a conversation</p>
              <span className="empty-hint">Describe your writing task below</span>
            </div>
          )}
          {notice && <article className="notice">{notice}</article>}
          {error && <article className="error">{error}</article>}
        </div>
        <div className="composer">
          <textarea
            ref={composerRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void sendChat();
              }
              if (busy && e.key === "Escape") {
                e.preventDefault();
                stop();
              }
            }}
            placeholder="Describe your writing task... (Ctrl+Enter to send, Esc to stop)"
            disabled={busy}
          />
          <div className="composer-actions">
            <span className="composer-hint">Ctrl+Enter to send</span>
            <button
              className={`composer-send ${busy ? "stop" : "primary"}`}
              onClick={busy ? stop : () => void sendChat()}
              disabled={!busy && !prompt.trim()}
            >
              {busy ? "Stop" : "Send"}
            </button>
          </div>
        </div>
        {pendingProposals.length > 0 && (
          <div className="mobile-proposals">
            <h2>
              Proposals
              <span style={{ fontWeight: 400, marginLeft: 8 }}>({pendingProposals.length})</span>
            </h2>
            {pendingProposals.map((p) => (
              <div className="proposal-card" key={p.id}>
                <h3>{p.path}</h3>
                <p>{p.summary}</p>
                <div className="proposal-actions">
                  <button onClick={() => void decide(p, "reject")}>Reject</button>
                  <button className="primary" onClick={() => void decide(p, "accept")}>
                    Accept
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="proposals">
        <h2>
          Proposals
          {pendingProposals.length > 0 && (
            <span style={{ fontWeight: 400, marginLeft: 8 }}>({pendingProposals.length})</span>
          )}
        </h2>
        {pendingProposals.length === 0 ? (
          <div className="block-empty">No pending proposals</div>
        ) : (
          pendingProposals.map((p) => (
            <div className="proposal-card" key={p.id}>
              <h3>{p.path}</h3>
              <p>{p.summary}</p>
              <div className="proposal-actions">
                <button onClick={() => void decide(p, "reject")}>Reject</button>
                <button className="primary" onClick={() => void decide(p, "accept")}>
                  Accept
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      {managementView && (
        <div className="management-backdrop" onMouseDown={() => setManagementView(null)}>
          <section className="management-view" onMouseDown={(e) => e.stopPropagation()}>
            <div className="management-head">
              <div>
                <span className="eyebrow">Workspace</span>
                <h2>{managementView === "characters" ? "Character cards" : "Sessions"}</h2>
              </div>
              <div className="management-actions">
                {managementView === "characters" ? (
                  <button className="primary" onClick={() => setCharacterDraft({ ...EMPTY_CHARACTER })}>+ Character</button>
                ) : (
                  <button className="primary" onClick={async () => {
                    const result = await api<{ sessionId: string }>("/api/session", { method: "POST" });
                    await refresh(result.sessionId);
                    setManagementView(null);
                  }}>+ Session</button>
                )}
                <button className="icon" aria-label="Close" onClick={() => setManagementView(null)}>×</button>
              </div>
            </div>

            {managementView === "characters" ? (
              <div className="character-grid">
                {state.characters.map((character) => (
                  <button className="character-card" key={character.id} onClick={() => setCharacterDraft({ ...character })}>
                    <span className="character-avatar">{character.name.slice(0, 1)}</span>
                    <span className="character-card-body">
                      <strong>{character.name}</strong>
                      <small>{[character.narrativeRole, character.identity].filter(Boolean).join(" · ") || "Role not set"}</small>
                      <span>{character.personality || character.background || "No description yet"}</span>
                    </span>
                  </button>
                ))}
                {state.characters.length === 0 && <div className="management-empty">No character cards yet.</div>}
              </div>
            ) : (
              <div className="session-list">
                {state.sessions.map((session) => (
                  <div className={`session-card ${session.id === state.sessionId ? "active" : ""}`} key={session.id}>
                    <button className="session-main" onClick={() => { void refresh(session.id); setManagementView(null); setMobileTab("agent"); }}>
                      <strong>{session.title}</strong>
                      <span>{new Date(session.updatedAt).toLocaleString()}</span>
                    </button>
                    {session.id === state.sessionId && <span className="current-badge">Current</span>}
                    <button className="icon" title="Rename" onClick={() => void renameSession(session.id, session.title)}>✎</button>
                    <button className="icon danger" title="Delete" onClick={() => void deleteSession(session.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {characterDraft && (
        <div className="modal-backdrop" onMouseDown={() => setCharacterDraft(null)}>
          <section className="modal character-editor" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{characterDraft.id ? "Edit character" : "New character"}</h2>
            <div className="character-form-grid">
              <label><span>Name</span><input value={characterDraft.name} onChange={(e) => setCharacterDraft({ ...characterDraft, name: e.target.value })} /></label>
              <label><span>Narrative role</span><input value={characterDraft.narrativeRole} onChange={(e) => setCharacterDraft({ ...characterDraft, narrativeRole: e.target.value })} /></label>
              <label><span>Identity</span><input value={characterDraft.identity} onChange={(e) => setCharacterDraft({ ...characterDraft, identity: e.target.value })} /></label>
              <label className="wide"><span>Aliases (comma separated)</span><input value={characterDraft.aliases.join(", ")} onChange={(e) => setCharacterDraft({ ...characterDraft, aliases: e.target.value.split(/[,，]/).map(v => v.trim()).filter(Boolean) })} /></label>
              {(["appearance", "personality", "values", "speechStyle", "background", "longTermGoal", "currentGoal", "fears", "capabilities", "limitations", "notes"] as const).map((field) => (
                <label className="wide" key={field}><span>{field[0].toUpperCase() + field.slice(1)}</span><textarea value={characterDraft[field]} onChange={(e) => setCharacterDraft({ ...characterDraft, [field]: e.target.value })} /></label>
              ))}
              <label className="wide"><span>Related characters</span><div className="relation-picker">
                {state.characters.filter(item => item.id !== characterDraft.id).map(item => (
                  <button type="button" className={characterDraft.relationships.some(relation => relation.characterId === item.id) ? "selected" : ""} key={item.id} onClick={() => setCharacterDraft({
                    ...characterDraft,
                    relationships: characterDraft.relationships.some(relation => relation.characterId === item.id)
                      ? characterDraft.relationships.filter(relation => relation.characterId !== item.id)
                      : [...characterDraft.relationships, { characterId: item.id, type: "", description: "", attitude: "" }],
                  })}>{item.name}</button>
                ))}
              </div></label>
              {characterDraft.relationships.map((relation) => {
                const related = state?.characters.find(item => item.id === relation.characterId);
                const updateRelation = (changes: Partial<typeof relation>) => setCharacterDraft({
                  ...characterDraft,
                  relationships: characterDraft.relationships.map(item => item.characterId === relation.characterId ? { ...item, ...changes } : item),
                });
                return <div className="relationship-editor wide" key={relation.characterId}>
                  <strong>{related?.name ?? `#${relation.characterId}`}</strong>
                  <input placeholder="Relationship type" value={relation.type} onChange={(e) => updateRelation({ type: e.target.value })} />
                  <input placeholder="Attitude" value={relation.attitude} onChange={(e) => updateRelation({ attitude: e.target.value })} />
                  <textarea placeholder="Relationship description" value={relation.description} onChange={(e) => updateRelation({ description: e.target.value })} />
                </div>;
              })}
            </div>
            <div className="modal-actions">
              {characterDraft.id && <button className="danger" onClick={() => void deleteCharacter(characterDraft as Character)}>Delete</button>}
              <button onClick={() => setCharacterDraft(null)}>Cancel</button>
              <button className="primary" disabled={!characterDraft.name.trim()} onClick={() => void saveCharacter()}>Save</button>
            </div>
          </section>
        </div>
      )}

      {showModelConfig && <ModelConfig initialCatalog={state.providerCatalog} request={api} onClose={() => setShowModelConfig(false)} onChanged={() => refresh(state.sessionId)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
