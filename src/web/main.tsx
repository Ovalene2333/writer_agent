import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
type WritingMode = "write" | "continue" | "rewrite" | "rewrite_document" | "polish" | "character";
type Character = { id: number; name: string };
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
type Provider = { provider: string; model: string; pricing: { contextWindow: number } };
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

const MODE_LABELS: Record<WritingMode, string> = {
  write: "Write",
  continue: "Continue",
  rewrite: "Rewrite (scope)",
  rewrite_document: "Rewrite (doc)",
  polish: "Polish",
  character: "Character",
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

function Markdown({ content, className }: { content: string; className?: string }) {
  const html = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
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
  const folderMap = new Map<string, TreeNode>();
  for (const path of folders) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    folderMap.set(path, {
      name: parts[parts.length - 1],
      path,
      kind: "folder",
      children: [],
      hidden: hiddenFolders.includes(path),
    });
  }

  const roots: TreeNode[] = [];
  for (const [path, node] of folderMap) {
    const parentPath = path.substring(0, path.lastIndexOf("/", path.length - 2) + 1);
    const parent = folderMap.get(parentPath);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const path of docs) {
    const parts = path.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/") + (parts.length > 0 ? "/" : "");
    const fileNode: TreeNode = {
      name,
      path,
      kind: "file",
      children: [],
      hidden: hiddenDocs.includes(path),
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
  collapsed,
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
  collapsed: Set<string>;
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
  const isCollapsed = collapsed.has(node.path);
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
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  const handleClick = () => {
    if (node.kind === "file") onSelect(node.path);
    else toggleFolder({ stopPropagation: () => {} } as React.MouseEvent);
  };

  return (
    <div className={`tree-node ${node.hidden ? "agent-hidden" : ""} ${node.kind}`}>
      <div
        className={`tree-row ${activePath === node.path ? "active" : ""} ${dragOver ? "drop-target" : ""}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        draggable={node.kind === "file"}
        onDragStart={node.kind === "file" ? handleDragStart : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        {node.kind === "folder" ? (
          <span className={`tree-arrow ${isExpanded ? "expanded" : ""}`} onClick={toggleFolder} />
        ) : (
          <span className="tree-arrow-spacer" />
        )}
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
            {node.hidden ? "Show" : "Hide"}
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
              +File
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
            Rename
          </button>
          <button
            className="tree-action-btn danger"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path, node.kind);
            }}
          >
            Del
          </button>
        </div>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <FileTreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            collapsed={collapsed}
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
  );
}

function App() {
  const [state, setState] = useState<State>();
  const [activePath, setActivePath] = useState("");
  const [document, setDocument] = useState<DocumentData>({ content: "", hash: "" });
  const [documentDraft, setDocumentDraft] = useState("");
  const [editingDocument, setEditingDocument] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<WritingMode>("continue");
  const [streamSteps, setStreamSteps] = useState<StreamStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileTab, setMobileTab] = useState<"docs" | "editor" | "agent">("editor");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ path: string; kind: "file" | "folder" } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "folder" } | null>(null);
  const [createValue, setCreateValue] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);
  const currentJobRef = useRef<string | undefined>(undefined);
  const streamOutputRef = useRef("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

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
          if (event.type === "done" || event.type === "cancelled" || event.type === "error") terminal = true;
        }
        if (done) break;
      }
      if (terminal) {
        await refresh(sessionId);
        if (clearContextOnDone) setNotice("Agent job completed.");
        setStreamSteps([]);
        streamOutputRef.current = "";
      }
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError")) {
        setNotice("Connection interrupted. The background job is still running on the server.");
        await refresh(sessionId).catch((e) => setError(String(e)));
      }
    } finally {
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
          mode,
          path: activePath || undefined,
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
    await api(`/api/proposals/${proposal.id}/${action}`, { method: "POST" });
    await refresh(state?.sessionId);
    if (action === "accept" && proposal.path === activePath) {
      const next = await api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`);
      setDocument(next);
      setDocumentDraft(next.content);
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

  const tree = useMemo(() => {
    if (!state) return [];
    return buildTree(state.documents, state.documentFolders, state.hiddenDocuments, state.hiddenFolders);
  }, [state?.documents, state?.documentFolders, state?.hiddenDocuments, state?.hiddenFolders]);

  const collapsed = useMemo(() => {
    if (!state) return new Set<string>();
    const set = new Set<string>();
    for (const d of state.hiddenDocuments) set.add(d);
    for (const f of state.hiddenFolders) set.add(f);
    return set;
  }, [state?.hiddenDocuments, state?.hiddenFolders]);

  if (!state) {
    return (
      <main className="app-shell">
        <p>{error || "Loading..."}</p>
      </main>
    );
  }

  const pendingProposals = state.proposals.filter((p) => p.status === "pending");
  const usagePct = state.provider.pricing.contextWindow
    ? Math.round((state.usage.lastPromptTokens / state.provider.pricing.contextWindow) * 100)
    : 0;

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <span className="logo">WRITER</span>
          <h1>{state.config.title || "Writer Agent"}</h1>
        </div>
        <div className="header-right">
          <div className="usage-strip">
            <span className="usage-number">{usagePct}%</span>
            <span>{state.usage.totalTokens.toLocaleString()} tok</span>
            <span>
              {state.usage.currency === "CNY" ? "&yen;" : "$"}
              {state.usage.cost.toFixed(4)}
            </span>
          </div>
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
          Docs
        </button>
        <button className={mobileTab === "editor" ? "active" : ""} onClick={() => setMobileTab("editor")}>
          Editor
        </button>
        <button className={mobileTab === "agent" ? "active" : ""} onClick={() => setMobileTab("agent")}>
          Agent
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
                  collapsed={collapsed}
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

        <div className="sidebar-section sessions">
          <h2>
            Sessions
            <button
              className="ghost"
              style={{ padding: "1px 6px", fontSize: 12 }}
              onClick={async () => {
                const r = await api<{ sessionId: string }>("/api/session", { method: "POST" });
                await refresh(r.sessionId);
              }}
            >
              +
            </button>
          </h2>
          {state.sessions.length === 0 ? (
            <div className="sidebar-empty">No sessions</div>
          ) : (
            state.sessions.map((s) => (
              <button
                key={s.id}
                className={`sidebar-item ${s.id === state.sessionId ? "active" : ""}`}
                onClick={() => {
                  void refresh(s.id);
                  setMobileTab("agent");
                }}
              >
                <div style={{ overflow: "hidden" }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</div>
                  <span className="sidebar-meta">{new Date(s.updatedAt).toLocaleDateString()}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className={`editor ${mobileTab === "editor" ? "mobile-active" : ""}`}>
        <div className="editor-bar">
          <span className="doc-path">{activePath || "No document selected"}</span>
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
        {editingDocument ? (
          <textarea value={documentDraft} onChange={(e) => setDocumentDraft(e.target.value)} />
        ) : (
          <div className="document-reader">
            {document.content ? (
              <Markdown content={document.content} />
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
          <span className={`agent-status ${busy ? "running" : ""}`}>{busy ? "Running" : "Idle"}</span>
        </div>
        <div className="conversation">
          {state.messages.map((msg) => (
            <article className={msg.role} key={msg.id}>
              <div className="msg-label">{msg.role === "assistant" ? "Assistant" : "You"}</div>
              {msg.role === "assistant" ? (
                <Markdown content={msg.content} />
              ) : (
                <div>{msg.content}</div>
              )}
            </article>
          ))}
          {streamSteps.map((step) => (
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
          <div className="mode-chips">
            {(Object.keys(MODE_LABELS) as WritingMode[]).map((m) => (
              <button
                key={m}
                className={mode === m ? "active-chip" : ""}
                onClick={() => setMode(m)}
                title={m}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <textarea
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
