import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const PREFIX_CACHE_LOG_VERSION = 2;
const DEFAULT_REPLAY_BYTES = 16 * 1024 * 1024;

export type PrefixCacheMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | import("./types.js").MessageContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  reasoning_content?: string;
};

export type PrefixCacheAtomKind =
  | "tool_schema"
  | "stable_system"
  /** Verbatim replay of an earlier turn in this session (see src/turn_replay.ts). */
  | "replayed_turn"
  | "dynamic_system"
  | "user"
  | "assistant"
  | "tool_result"
  | "other";

export type PrefixCacheAtom = {
  kind: PrefixCacheAtomKind;
  label: string;
  hash: string;
  characters: number;
  bytes: number;
  estimatedTokens: number;
  document?: {
    path?: string;
    sourceHash?: string;
    artifactId?: number;
    startLine?: number;
    endLine?: number;
    bodyCharacters: number;
  };
};

export type PrefixCacheRequestInput = {
  projectRoot: string;
  endpoint: string;
  model: string;
  providerName?: string;
  userId?: string;
  sessionId: string;
  jobId?: string;
  callKind: string;
  step?: number;
  messages: readonly PrefixCacheMessage[];
  tools?: readonly unknown[];
  stableMessageCount: number;
  initialMessageCount: number;
  /** End of the replayed frozen turns; defaults to stableMessageCount (no replay). */
  replayedMessageCount?: number;
  requestProfile?: Record<string, unknown>;
};

export type PrefixCachePrediction = {
  priorRequests: number;
  matchedAtoms: number;
  totalAtoms: number;
  predictedHitCharacters: number;
  predictedHitBytes: number;
  predictedHitTokens: number;
  fullRequestKnown: boolean;
  firstDivergence?: {
    atomIndex: number;
    kind: PrefixCacheAtomKind;
    label: string;
    alternatives: number;
  };
};

export type PrefixCacheObservation = {
  observationId: string;
  logPath: string;
  namespaceHash: string;
  atoms: PrefixCacheAtom[];
  prediction: PrefixCachePrediction;
  startedAt: string;
};

export type PrefixCacheCompletion = {
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  estimated?: boolean;
  finishReason?: string;
  error?: string;
};

type PrefixTreeNode = {
  children: Map<string, PrefixTreeNode>;
  visits: number;
  terminals: number;
};

type PrefixTreeRoot = {
  node: PrefixTreeNode;
  requests: number;
};

type StartLogRecord = {
  version: number;
  event: "request_start";
  at: string;
  observationId: string;
  namespaceHash: string;
  namespace: {
    endpoint: string;
    model: string;
    providerName?: string;
    userIdHash?: string;
    requestProfileHash: string;
  };
  sessionId: string;
  jobId?: string;
  callKind: string;
  step?: number;
  prediction: PrefixCachePrediction;
  totals: {
    atoms: number;
    characters: number;
    bytes: number;
    estimatedTokens: number;
    documentReadAtoms: number;
    documentBodyCharacters: number;
  };
  components: Partial<Record<PrefixCacheAtomKind, {
    atoms: number;
    characters: number;
    bytes: number;
    estimatedTokens: number;
  }>>;
  atoms: PrefixCacheAtom[];
};

type FinishLogRecord = {
  version: number;
  event: "request_finish";
  at: string;
  observationId: string;
  namespaceHash: string;
  durationMs: number;
  prediction: PrefixCachePrediction;
  actual: PrefixCacheCompletion;
  predictionErrorTokens?: number;
};

function hash(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function estimatedTokens(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 4));
}

function emptyNode(): PrefixTreeNode {
  return { children: new Map(), visits: 0, terminals: 0 };
}

function serializeMessage(message: PrefixCacheMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
  });
}

function documentMetadata(message: PrefixCacheMessage): PrefixCacheAtom["document"] | undefined {
  if (message.role !== "tool" || message.content == null) return undefined;
  const toolBody = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
      : "";
  if (!toolBody) return undefined;
  try {
    const parsed = JSON.parse(toolBody) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const content = typeof parsed.content === "string"
      ? parsed.content
      : typeof parsed.markdown === "string" ? parsed.markdown : "";
    const matchesBody = Array.isArray(parsed.matches)
      ? parsed.matches.reduce((sum, item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return sum;
          const context = (item as Record<string, unknown>).context;
          return sum + (typeof context === "string" ? context.length : 0);
        }, 0)
      : 0;
    const path = typeof parsed.path === "string" ? parsed.path : undefined;
    const sourceHash = typeof parsed.sourceHash === "string" ? parsed.sourceHash : undefined;
    const artifactId = typeof parsed.artifactId === "number" ? parsed.artifactId : undefined;
    const startLine = typeof parsed.contextStartLine === "number" ? parsed.contextStartLine
      : typeof parsed.startLine === "number" ? parsed.startLine : undefined;
    const endLine = typeof parsed.contextEndLine === "number" ? parsed.contextEndLine
      : typeof parsed.endLine === "number" ? parsed.endLine : undefined;
    if (!path && !sourceHash && artifactId === undefined && !content && !matchesBody) return undefined;
    return {
      ...(path ? { path } : {}),
      ...(sourceHash ? { sourceHash } : {}),
      ...(artifactId !== undefined ? { artifactId } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      bodyCharacters: content.length + matchesBody,
    };
  } catch {
    return undefined;
  }
}

function messageKind(
  message: PrefixCacheMessage,
  index: number,
  stableMessageCount: number,
  initialMessageCount: number,
  replayedMessageCount: number,
): PrefixCacheAtomKind {
  if (index < stableMessageCount) return "stable_system";
  // Frozen earlier turns: bytes the provider has already seen. Classifying them as
  // "dynamic_system" would report a warm prefix as fresh miss-priced context.
  if (index < replayedMessageCount) return "replayed_turn";
  if (index < initialMessageCount && message.role === "system") return "dynamic_system";
  if (message.role === "user") return "user";
  if (message.role === "assistant") return "assistant";
  if (message.role === "tool") return "tool_result";
  return "other";
}

export function buildPrefixCacheAtoms(input: Pick<
  PrefixCacheRequestInput,
  "messages" | "tools" | "stableMessageCount" | "initialMessageCount" | "replayedMessageCount"
>): PrefixCacheAtom[] {
  const atoms: PrefixCacheAtom[] = [];
  const replayedMessageCount = Math.max(input.stableMessageCount, input.replayedMessageCount ?? input.stableMessageCount);
  const appendMessage = (message: PrefixCacheMessage, index: number): void => {
    const serialized = serializeMessage(message);
    const bytes = Buffer.byteLength(serialized, "utf8");
    const kind = messageKind(message, index, input.stableMessageCount, input.initialMessageCount, replayedMessageCount);
    const toolNames = message.tool_calls?.map(call => call.function.name).filter(Boolean);
    atoms.push({
      kind,
      label: kind === "assistant" && toolNames?.length
        ? `message[${index}]:assistant:${toolNames.join(",")}`
        : kind === "tool_result"
          ? `message[${index}]:tool:${message.tool_call_id ?? "-"}`
          : `message[${index}]:${message.role}`,
      hash: hash(serialized),
      characters: serialized.length,
      bytes,
      estimatedTokens: estimatedTokens(bytes),
      ...(documentMetadata(message) ? { document: documentMetadata(message) } : {}),
    });
  };
  const initialMessageCount = Math.min(input.initialMessageCount, input.messages.length);
  input.messages.slice(0, initialMessageCount).forEach(appendMessage);
  if (input.tools?.length) {
    const serialized = JSON.stringify(input.tools);
    const bytes = Buffer.byteLength(serialized, "utf8");
    atoms.push({
      kind: "tool_schema",
      label: `tools(${input.tools.length})`,
      hash: hash(serialized),
      characters: serialized.length,
      bytes,
      estimatedTokens: estimatedTokens(bytes),
    });
  }
  input.messages.slice(initialMessageCount).forEach((message, offset) => {
    appendMessage(message, initialMessageCount + offset);
  });
  return atoms;
}

function readRecentLog(path: string, maxBytes: number): string {
  let size: number;
  try { size = statSync(path).size; }
  catch { return ""; }
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const start = size - maxBytes;
  const buffer = Buffer.allocUnsafe(maxBytes);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, maxBytes, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  } finally {
    closeSync(fd);
  }
}

function appendJsonLine(path: string, value: StartLogRecord | FinishLogRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
  } catch {
    // Cache observation must never make an Agent request fail.
  }
}

function componentSummary(atoms: PrefixCacheAtom[]): StartLogRecord["components"] {
  const result: StartLogRecord["components"] = {};
  for (const atom of atoms) {
    const current = result[atom.kind] ?? { atoms: 0, characters: 0, bytes: 0, estimatedTokens: 0 };
    current.atoms += 1;
    current.characters += atom.characters;
    current.bytes += atom.bytes;
    current.estimatedTokens += atom.estimatedTokens;
    result[atom.kind] = current;
  }
  return result;
}

export class RequestPrefixForest {
  private readonly roots = new Map<string, PrefixTreeRoot>();

  constructor(
    readonly logPath: string,
    replayBytes = DEFAULT_REPLAY_BYTES,
  ) {
    const text = readRecentLog(logPath, replayBytes);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Partial<StartLogRecord>;
        if (record.version !== PREFIX_CACHE_LOG_VERSION || record.event !== "request_start"
          || typeof record.namespaceHash !== "string" || !Array.isArray(record.atoms)) continue;
        const atoms = record.atoms.filter((atom): atom is PrefixCacheAtom =>
          Boolean(atom && typeof atom.hash === "string"));
        this.insert(record.namespaceHash, atoms);
      } catch {
        // A partial final line or older log version is ignored.
      }
    }
  }

  begin(input: PrefixCacheRequestInput): PrefixCacheObservation {
    const startedAt = new Date().toISOString();
    const profile = input.requestProfile ?? {};
    const namespace = {
      endpoint: input.endpoint,
      model: input.model,
      providerName: input.providerName,
      userIdHash: input.userId ? hash(input.userId, 12) : undefined,
      requestProfileHash: hash(JSON.stringify(profile), 12),
    };
    const namespaceHash = hash(JSON.stringify(namespace));
    const atoms = buildPrefixCacheAtoms(input);
    const prediction = this.query(namespaceHash, atoms);
    const observation: PrefixCacheObservation = {
      observationId: randomUUID(),
      logPath: this.logPath,
      namespaceHash,
      atoms,
      prediction,
      startedAt,
    };
    const documentAtoms = atoms.filter(atom => atom.document);
    appendJsonLine(this.logPath, {
      version: PREFIX_CACHE_LOG_VERSION,
      event: "request_start",
      at: startedAt,
      observationId: observation.observationId,
      namespaceHash,
      namespace,
      sessionId: input.sessionId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      callKind: input.callKind,
      ...(input.step !== undefined ? { step: input.step } : {}),
      prediction,
      totals: {
        atoms: atoms.length,
        characters: atoms.reduce((sum, atom) => sum + atom.characters, 0),
        bytes: atoms.reduce((sum, atom) => sum + atom.bytes, 0),
        estimatedTokens: atoms.reduce((sum, atom) => sum + atom.estimatedTokens, 0),
        documentReadAtoms: documentAtoms.length,
        documentBodyCharacters: documentAtoms.reduce((sum, atom) => sum + (atom.document?.bodyCharacters ?? 0), 0),
      },
      components: componentSummary(atoms),
      atoms,
    });
    // The request is about to reach the provider. Make it visible to concurrent
    // observations even if the process exits before a finish record is written.
    this.insert(namespaceHash, atoms);
    return observation;
  }

  finish(observation: PrefixCacheObservation, actual: PrefixCacheCompletion): void {
    const durationMs = Math.max(0, Date.now() - Date.parse(observation.startedAt));
    appendJsonLine(this.logPath, {
      version: PREFIX_CACHE_LOG_VERSION,
      event: "request_finish",
      at: new Date().toISOString(),
      observationId: observation.observationId,
      namespaceHash: observation.namespaceHash,
      durationMs,
      prediction: observation.prediction,
      actual,
      ...(actual.cacheHitTokens !== undefined
        ? { predictionErrorTokens: actual.cacheHitTokens - observation.prediction.predictedHitTokens }
        : {}),
    });
  }

  query(namespaceHash: string, atoms: readonly PrefixCacheAtom[]): PrefixCachePrediction {
    const root = this.roots.get(namespaceHash);
    let node = root?.node;
    let matchedAtoms = 0;
    let predictedHitCharacters = 0;
    let predictedHitBytes = 0;
    let predictedHitTokens = 0;
    for (const atom of atoms) {
      const next = node?.children.get(atom.hash);
      if (!next) break;
      node = next;
      matchedAtoms += 1;
      predictedHitCharacters += atom.characters;
      predictedHitBytes += atom.bytes;
      predictedHitTokens += atom.estimatedTokens;
    }
    const divergent = atoms[matchedAtoms];
    return {
      priorRequests: root?.requests ?? 0,
      matchedAtoms,
      totalAtoms: atoms.length,
      predictedHitCharacters,
      predictedHitBytes,
      predictedHitTokens,
      fullRequestKnown: atoms.length > 0 && matchedAtoms === atoms.length && Boolean(node?.terminals),
      ...(divergent
        ? {
            firstDivergence: {
              atomIndex: matchedAtoms,
              kind: divergent.kind,
              label: divergent.label,
              alternatives: node?.children.size ?? 0,
            },
          }
        : {}),
    };
  }

  private insert(namespaceHash: string, atoms: readonly PrefixCacheAtom[]): void {
    let root = this.roots.get(namespaceHash);
    if (!root) {
      root = { node: emptyNode(), requests: 0 };
      this.roots.set(namespaceHash, root);
    }
    root.requests += 1;
    let node = root.node;
    node.visits += 1;
    for (const atom of atoms) {
      let next = node.children.get(atom.hash);
      if (!next) {
        next = emptyNode();
        node.children.set(atom.hash, next);
      }
      next.visits += 1;
      node = next;
    }
    node.terminals += 1;
  }
}

const forests = new Map<string, RequestPrefixForest>();

export function prefixCacheLogPath(projectRoot: string): string {
  return resolve(projectRoot, ".writer", "logs", "prefix-cache.jsonl");
}

export function beginPrefixCacheObservation(input: PrefixCacheRequestInput): PrefixCacheObservation {
  const logPath = prefixCacheLogPath(input.projectRoot);
  let forest = forests.get(logPath);
  if (!forest) {
    forest = new RequestPrefixForest(logPath);
    forests.set(logPath, forest);
  }
  return forest.begin(input);
}

export function finishPrefixCacheObservation(
  observation: PrefixCacheObservation | undefined,
  actual: PrefixCacheCompletion,
): void {
  if (!observation) return;
  forests.get(observation.logPath)?.finish(observation, actual);
}

export type PrefixCacheDivergence = {
  label: string;
  kind: PrefixCacheAtomKind;
  requests: number;
  /** Miss-priced tokens sitting at or after this divergence point, summed. */
  missedTokens: number;
};

export type PrefixCacheCallKindSummary = {
  callKind: string;
  requests: number;
  /** Requests that also produced a finish record with provider usage. */
  measuredRequests: number;
  promptTokens: number;
  cacheHitTokens: number;
  /** cacheHitTokens / promptTokens over measured requests; undefined when nothing measured. */
  actualHitRate?: number;
  predictedHitTokens: number;
  predictedRequestTokens: number;
  predictedHitRate?: number;
  /** Mean signed (actual − predicted); positive means we under-predicted the hit. */
  predictionErrorTokens?: number;
  componentTokens: Partial<Record<PrefixCacheAtomKind, number>>;
  topDivergences: PrefixCacheDivergence[];
};

export type PrefixCacheLogSummary = {
  logPath: string;
  totalRequests: number;
  callKinds: PrefixCacheCallKindSummary[];
};

/**
 * Aggregate `.writer/logs/prefix-cache.jsonl` into a per-callKind report.
 *
 * The forest predicts hits; only the provider knows what actually cached. Joining
 * the two on observationId is the one thing that says whether a prompt-layout
 * change paid off — and the divergence histogram says which slot is leaking.
 */
export function summarizePrefixCacheLog(
  logPath: string,
  options: { callKind?: string; topDivergences?: number; maxBytes?: number } = {},
): PrefixCacheLogSummary {
  const text = readRecentLog(logPath, options.maxBytes ?? DEFAULT_REPLAY_BYTES);
  const topCount = options.topDivergences ?? 5;
  type Accumulator = {
    requests: number;
    measuredRequests: number;
    promptTokens: number;
    cacheHitTokens: number;
    predictedHitTokens: number;
    predictedRequestTokens: number;
    predictionErrorTokens: number;
    predictionErrorSamples: number;
    componentTokens: Partial<Record<PrefixCacheAtomKind, number>>;
    divergences: Map<string, PrefixCacheDivergence>;
  };
  const byKind = new Map<string, Accumulator>();
  // observationId → callKind, so finish records can be attributed without a second pass.
  const starts = new Map<string, string>();
  let totalRequests = 0;

  const accumulator = (callKind: string): Accumulator => {
    let entry = byKind.get(callKind);
    if (!entry) {
      entry = {
        requests: 0, measuredRequests: 0, promptTokens: 0, cacheHitTokens: 0,
        predictedHitTokens: 0, predictedRequestTokens: 0,
        predictionErrorTokens: 0, predictionErrorSamples: 0,
        componentTokens: {}, divergences: new Map(),
      };
      byKind.set(callKind, entry);
    }
    return entry;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Intersecting the two record types collapses `event` to never; read them loosely.
    let record: Omit<Partial<StartLogRecord>, "event"> & Omit<Partial<FinishLogRecord>, "event"> & { event?: string };
    try { record = JSON.parse(line) as typeof record; }
    catch { continue; } // A truncated final line or an older log version is ignored.
    if (record.version !== PREFIX_CACHE_LOG_VERSION) continue;

    if (record.event === "request_start") {
      const callKind = typeof record.callKind === "string" ? record.callKind : "unspecified";
      if (options.callKind && callKind !== options.callKind) continue;
      if (typeof record.observationId === "string") starts.set(record.observationId, callKind);
      const entry = accumulator(callKind);
      entry.requests += 1;
      totalRequests += 1;
      const predictedHit = record.prediction?.predictedHitTokens ?? 0;
      entry.predictedHitTokens += predictedHit;
      entry.predictedRequestTokens += record.totals?.estimatedTokens ?? 0;
      for (const [kind, component] of Object.entries(record.components ?? {})) {
        const key = kind as PrefixCacheAtomKind;
        entry.componentTokens[key] = (entry.componentTokens[key] ?? 0) + (component?.estimatedTokens ?? 0);
      }
      const divergence = record.prediction?.firstDivergence;
      if (divergence) {
        // Strip the volatile message index so the same slot aggregates across turns.
        const label = divergence.label.replace(/^message\[\d+]:/, "");
        const existing = entry.divergences.get(label)
          ?? { label, kind: divergence.kind, requests: 0, missedTokens: 0 };
        existing.requests += 1;
        existing.missedTokens += Math.max(0, (record.totals?.estimatedTokens ?? 0) - predictedHit);
        entry.divergences.set(label, existing);
      }
      continue;
    }

    if (record.event === "request_finish") {
      const callKind = typeof record.observationId === "string" ? starts.get(record.observationId) : undefined;
      // A finish whose start scrolled out of the log tail has no components to attribute.
      if (!callKind) continue;
      const entry = accumulator(callKind);
      const actual = record.actual;
      if (!actual || actual.promptTokens === undefined) continue;
      entry.measuredRequests += 1;
      entry.promptTokens += actual.promptTokens;
      entry.cacheHitTokens += actual.cacheHitTokens ?? 0;
      if (record.predictionErrorTokens !== undefined) {
        entry.predictionErrorTokens += record.predictionErrorTokens;
        entry.predictionErrorSamples += 1;
      }
    }
  }

  const callKinds = [...byKind.entries()]
    .map(([callKind, entry]): PrefixCacheCallKindSummary => ({
      callKind,
      requests: entry.requests,
      measuredRequests: entry.measuredRequests,
      promptTokens: entry.promptTokens,
      cacheHitTokens: entry.cacheHitTokens,
      ...(entry.promptTokens > 0 ? { actualHitRate: entry.cacheHitTokens / entry.promptTokens } : {}),
      predictedHitTokens: entry.predictedHitTokens,
      predictedRequestTokens: entry.predictedRequestTokens,
      ...(entry.predictedRequestTokens > 0
        ? { predictedHitRate: entry.predictedHitTokens / entry.predictedRequestTokens }
        : {}),
      ...(entry.predictionErrorSamples > 0
        ? { predictionErrorTokens: entry.predictionErrorTokens / entry.predictionErrorSamples }
        : {}),
      componentTokens: entry.componentTokens,
      topDivergences: [...entry.divergences.values()]
        .sort((a, b) => b.missedTokens - a.missedTokens || b.requests - a.requests)
        .slice(0, topCount),
    }))
    .sort((a, b) => b.requests - a.requests || a.callKind.localeCompare(b.callKind));

  return { logPath, totalRequests, callKinds };
}
