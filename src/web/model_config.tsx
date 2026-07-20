import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle2, LoaderCircle, Plus, Radar, X, XCircle } from "lucide-react";

export type Pricing = {
  billingMode?: "metered" | "unmetered";
  cacheHit: number;
  cacheMiss: number;
  output: number;
  currency: "CNY" | "USD";
  contextWindow: number;
  peakBilling?: {
    timezone: string;
    windows: Array<{ start: string; end: string }>;
    cacheHit: number;
    cacheMiss: number;
    output: number;
  };
};
export type ProviderModel = { id: string; name: string; pricing: Pricing; temperature?: number; topP?: number };
export type ProviderProfile = { id: string; name: string; provider: "deepseek" | "openai-compatible"; baseUrl: string; apiKeyConfigured: boolean; apiKeyHint: string; models: ProviderModel[] };
export type ModelRole = "agent" | "roleplay" | "flash" | "drafter" | "inline" | "writer" | "reviewer" | "summarizer";
export type ProviderCatalog = { activeProviderId: string; activeModelId: string; assignments: Record<ModelRole, { providerId: string; modelId: string }>; providers: ProviderProfile[] };
export type ScenePipelineSettings = {
  preferredMinScenes: number;
  preferredMaxScenes: number;
  maxScenes: number;
  notesMaxCharacters: number;
  isolatedWriterMaxRatio: number;
  isolatedWriter: boolean;
  candidateCount: number;
};

type ModelDraft = Omit<ProviderModel, "id"> & { id?: string };
type ProfileDraft = Omit<ProviderProfile, "id" | "apiKeyConfigured" | "apiKeyHint" | "models"> & { id?: string; apiKey: string; models: ModelDraft[] };
type ScannedModel = { name: string; pricing: Pricing };
type Request = (path: string, init?: RequestInit) => Promise<any>;

const ROLES: Array<{ id: Exclude<ModelRole, "drafter">; name: string; detail: string }> = [
  { id: "flash", name: "通用 Flash", detail: "低延迟、低成本的推荐、提取与轻量辅助任务" },
  { id: "agent", name: "Agent 调度", detail: "理解请求、规划任务与调用工具" },
  { id: "roleplay", name: "角色扮演", detail: "角色试演、对话者设定与沉浸式对白" },
  { id: "inline", name: "行内生成", detail: "短文本补全与局部快速修改" },
  { id: "writer", name: "正文写作", detail: "续写、重写与长篇内容生成" },
  { id: "reviewer", name: "审阅校对", detail: "质量检查、润色与修改建议" },
  { id: "summarizer", name: "上下文摘要", detail: "压缩历史内容以控制上下文长度" },
];

const EMPTY_PRICING: Pricing = { cacheHit: 0, cacheMiss: 0, output: 0, currency: "CNY", contextWindow: 128000 };
const newModel = (): ModelDraft => ({ name: "", pricing: { ...EMPTY_PRICING } });
const emptyProfile = (): ProfileDraft => ({ name: "", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "", models: [newModel()] });

type TestStatus = "idle" | "testing" | "ok" | "fail";

function TestStatusIcon({ status }: { status: TestStatus }) {
  if (status === "testing") {
    return <LoaderCircle className="test-icon test-icon-spin" aria-hidden="true" />;
  }
  if (status === "ok") {
    return <CheckCircle2 className="test-icon test-icon-ok" aria-hidden="true" />;
  }
  if (status === "fail") {
    return <XCircle className="test-icon test-icon-fail" aria-hidden="true" />;
  }
  return <Radar className="test-icon test-icon-idle" aria-hidden="true" />;
}

type ModelConfigProps = {
  initialCatalog: ProviderCatalog;
  scenePipeline: ScenePipelineSettings;
  request: Request;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onScenePipelineChanged: (settings: ScenePipelineSettings) => void;
};

export function ModelConfig({ initialCatalog, scenePipeline, request, onClose, onChanged, onScenePipelineChanged }: ModelConfigProps) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [tab, setTab] = useState<"models" | "scene-pipeline">("models");
  const [sceneDraft, setSceneDraft] = useState(scenePipeline);
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scannedModels, setScannedModels] = useState<ScannedModel[]>([]);
  const [selectedScannedModels, setSelectedScannedModels] = useState<Set<string>>(new Set());
  const [editorFeedback, setEditorFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, TestStatus>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setCatalog(initialCatalog), [initialCatalog]);
  useEffect(() => setSceneDraft(scenePipeline), [scenePipeline]);

  const anyTesting = Object.values(testStatus).some(status => status === "testing");
  const sceneDraftValid = [sceneDraft.preferredMinScenes, sceneDraft.preferredMaxScenes, sceneDraft.maxScenes]
    .every(value => Number.isInteger(value) && value >= 1 && value <= 8)
    && sceneDraft.preferredMinScenes <= sceneDraft.preferredMaxScenes
    && sceneDraft.preferredMaxScenes <= sceneDraft.maxScenes
    && Number.isInteger(sceneDraft.notesMaxCharacters)
    && sceneDraft.notesMaxCharacters >= 500
    && sceneDraft.notesMaxCharacters <= 8_000
    && Number.isFinite(sceneDraft.isolatedWriterMaxRatio)
    && sceneDraft.isolatedWriterMaxRatio >= 1.2
    && sceneDraft.isolatedWriterMaxRatio <= 3;
  const choices = useMemo(() => catalog.providers.flatMap(provider => provider.models.map(model => ({ value: `${provider.id}:${model.id}`, label: `${provider.name} / ${model.name}` }))), [catalog]);
  const resetScan = () => { setScannedModels([]); setSelectedScannedModels(new Set()); setEditorFeedback(null); };
  const addProfile = () => { resetScan(); setEditing(emptyProfile()); };
  const editProfile = (profile: ProviderProfile) => {
    resetScan();
    setEditing({ id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, apiKey: "", models: profile.models.map(model => ({ ...model, pricing: { ...model.pricing } })) });
  };
  const updateConnection = (change: Partial<Pick<ProfileDraft, "provider" | "baseUrl" | "apiKey">>) => {
    resetScan();
    setEditing(current => current ? { ...current, ...change } : current);
  };
  const updateModel = (index: number, change: Partial<ModelDraft>) => setEditing(current => current ? { ...current, models: current.models.map((model, i) => i === index ? { ...model, ...change } : model) } : current);
  const modelKey = (providerId: string, modelId: string) => `${providerId}:${modelId}`;
  const providerBatchKey = (providerId: string) => `provider:${providerId}`;
  const statusOf = (key: string): TestStatus => testStatus[key] ?? "idle";
  const savedEditingProfile = editing?.id ? catalog.providers.find(profile => profile.id === editing.id) : undefined;
  const canScanModels = Boolean(editing?.baseUrl.trim() && (editing.apiKey.trim() || savedEditingProfile?.apiKeyConfigured));
  const editingModelNames = new Set(editing?.models.map(model => model.name.trim()).filter(Boolean) ?? []);
  const importableScannedModels = scannedModels.filter(model => !editingModelNames.has(model.name));
  const selectedImportCount = importableScannedModels.filter(model => selectedScannedModels.has(model.name)).length;

  async function saveProfile() {
    if (!editing || !editing.name.trim() || !editing.baseUrl.trim() || editing.models.some(model => !model.name.trim())) return;
    setBusy(true); setError(""); setEditorFeedback(null);
    try {
      const result = await request("/api/providers", { method: "PUT", body: JSON.stringify({ ...editing, apiKey: editing.apiKey || undefined }) });
      setCatalog(result.catalog); setEditing(null); setMessage("供应商配置已保存"); await onChanged();
    } catch (cause) { setEditorFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setBusy(false); }
  }

  async function scanProviderModels() {
    if (!editing || !canScanModels) return;
    setScanning(true); setEditorFeedback(null);
    try {
      const result = await request("/api/providers/scan", {
        method: "POST",
        body: JSON.stringify({
          profileId: editing.id,
          provider: editing.provider,
          baseUrl: editing.baseUrl,
          apiKey: editing.apiKey || undefined,
        }),
      }) as { models: ScannedModel[] };
      const existing = new Set(editing.models.map(model => model.name.trim()).filter(Boolean));
      const available = result.models.filter(model => !existing.has(model.name));
      setScannedModels(result.models);
      setSelectedScannedModels(new Set(available.map(model => model.name)));
      setEditorFeedback({
        error: false,
        text: `扫描到 ${result.models.length} 个模型，其中 ${available.length} 个尚未添加`,
      });
    } catch (cause) {
      setScannedModels([]);
      setSelectedScannedModels(new Set());
      setEditorFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setScanning(false);
    }
  }

  function importScannedModels() {
    if (!selectedImportCount) return;
    setEditing(current => {
      if (!current) return current;
      const existing = new Set(current.models.map(model => model.name.trim()).filter(Boolean));
      const additions = scannedModels
        .filter(model => selectedScannedModels.has(model.name) && !existing.has(model.name))
        .map(model => ({ name: model.name, pricing: { ...model.pricing } }));
      const configured = current.models.filter(model => model.name.trim());
      return { ...current, models: [...configured, ...additions] };
    });
    setSelectedScannedModels(new Set());
    setEditorFeedback({ error: false, text: `已导入 ${selectedImportCount} 个模型，保存供应商后生效` });
  }

  async function assign(role: Exclude<ModelRole, "drafter">, value: string) {
    const [providerId, modelId] = value.split(":");
    setError("");
    try { const result = await request("/api/providers/assign", { method: "POST", body: JSON.stringify({ role, providerId, modelId }) }); setCatalog(result.catalog); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function removeProfile(profile: ProviderProfile) {
    if (!confirm(`删除供应商“${profile.name}”及其全部模型？`)) return;
    try { const result = await request(`/api/providers/${profile.id}`, { method: "DELETE" }); setCatalog(result.catalog); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function testModel(provider: ProviderProfile, model: ProviderModel) {
    const key = modelKey(provider.id, model.id);
    setTestStatus(current => ({ ...current, [key]: "testing" }));
    setError(""); setMessage("");
    try {
      const result = await request("/api/provider/test", {
        method: "POST",
        body: JSON.stringify({ providerId: provider.id, modelId: model.id }),
      });
      setTestStatus(current => ({ ...current, [key]: "ok" }));
      setMessage(result.message || "连接成功");
    } catch (cause) {
      setTestStatus(current => ({ ...current, [key]: "fail" }));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function testProvider(provider: ProviderProfile) {
    if (!provider.models.length) return;
    const batch = providerBatchKey(provider.id);
    setTestStatus(current => {
      const next = { ...current, [batch]: "testing" as TestStatus };
      for (const model of provider.models) next[modelKey(provider.id, model.id)] = "testing";
      return next;
    });
    setError(""); setMessage("");
    const lines: string[] = [];
    let failed = 0;
    for (const model of provider.models) {
      const key = modelKey(provider.id, model.id);
      setTestStatus(current => ({ ...current, [key]: "testing" }));
      try {
        const result = await request("/api/provider/test", {
          method: "POST",
          body: JSON.stringify({ providerId: provider.id, modelId: model.id }),
        });
        setTestStatus(current => ({ ...current, [key]: "ok" }));
        lines.push(`✓ ${model.name}：${String(result.message || "连接成功").replace(/^[^：]*：/, "")}`);
      } catch (cause) {
        failed += 1;
        setTestStatus(current => ({ ...current, [key]: "fail" }));
        lines.push(`✗ ${model.name}：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    setTestStatus(current => ({ ...current, [batch]: failed ? "fail" : "ok" }));
    const summary = `${provider.name} 测试完成（${provider.models.length - failed}/${provider.models.length} 通过，不消耗 token）\n${lines.join("\n")}`;
    if (failed) setError(summary);
    else setMessage(summary);
  }

  async function saveScenePipeline() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/agent-settings", {
        method: "POST",
        body: JSON.stringify({ scenePipeline: sceneDraft }),
      }) as { scenePipeline: ScenePipelineSettings };
      setSceneDraft(result.scenePipeline);
      onScenePipelineChanged(result.scenePipeline);
      setMessage("场景链设置已保存，将从下一次 Agent 任务开始生效");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="model-config-backdrop management-page">
    <section className="model-config-view">
      <div className="management-head"><div><span className="eyebrow">Settings</span><h2>模型配置</h2></div><div className="management-actions">{tab === "models" && <button onClick={addProfile}><Plus size={15} />添加供应商</button>}<button className="icon" title="返回工作区" aria-label="返回工作区" onClick={onClose}><X size={17} /></button></div></div>
      <nav className="settings-tabs" aria-label="设置分类">
        <button className={tab === "models" ? "active" : ""} onClick={() => { setTab("models"); setError(""); setMessage(""); }}>模型</button>
        <button className={tab === "scene-pipeline" ? "active" : ""} onClick={() => { setTab("scene-pipeline"); setError(""); setMessage(""); }}>场景链</button>
      </nav>
      {(error || message) && <div className={error ? "config-feedback error" : "config-feedback"} style={{ whiteSpace: "pre-wrap" }}>{error || message}</div>}
      {tab === "models" && <div className="model-config-layout">
        <div className="provider-column">
          <h3>供应商与模型</h3>
          {catalog.providers.map(provider => {
            const batchStatus = statusOf(providerBatchKey(provider.id));
            return <article className="provider-card" key={provider.id}>
            <div className="provider-card-head">
              <div><strong>{provider.name}</strong><span>{provider.provider === "deepseek" ? "DeepSeek" : "OpenAI 兼容"} · {provider.apiKeyConfigured ? provider.apiKeyHint : "未配置密钥"}</span></div>
              <div>
                <button
                  className={`ghost test-action-btn status-${batchStatus}`}
                  disabled={!provider.apiKeyConfigured || anyTesting}
                  title="通过 GET /models 检测全部模型，不消耗 token"
                  onClick={() => void testProvider(provider)}
                >
                  <TestStatusIcon status={batchStatus}/>
                  <span>{batchStatus === "testing" ? "测试中" : batchStatus === "ok" ? "全部通过" : batchStatus === "fail" ? "存在失败" : "测试全部"}</span>
                </button>
                <button className="ghost" onClick={() => editProfile(provider)}>编辑</button>
                <button className="ghost danger" disabled={catalog.providers.length <= 1} onClick={() => void removeProfile(provider)}>删除</button>
              </div>
            </div>
            <div className="provider-models">{provider.models.map(model => {
              const key = modelKey(provider.id, model.id);
              const status = statusOf(key);
              const title = status === "ok"
                ? "可达 · 点击重新测试（不消耗 token）"
                : status === "fail"
                  ? "不可达 · 点击重新测试（不消耗 token）"
                  : status === "testing"
                    ? "测试中…"
                    : "通过 GET /models 检测可达性，不调用推理、不消耗 token";
              return <div className={`provider-model status-${status}`} key={model.id}>
                <span className="model-dot"/>
                <div>
                  <b>{model.name}</b>
                  <small>{model.pricing.contextWindow.toLocaleString()} context{model.pricing.billingMode === "unmetered" ? "" : ` · ${model.pricing.currency}${model.pricing.peakBilling ? " · 峰谷分时" : ""}`}</small>
                  <small className="model-price-line">{model.pricing.billingMode === "unmetered" ? "非按量计费" : `命中 ${model.pricing.cacheHit} · 未命中 ${model.pricing.cacheMiss} · 输出 ${model.pricing.output}`}</small>
                </div>
                <button
                  className={`model-test-btn status-${status}`}
                  disabled={!provider.apiKeyConfigured || anyTesting}
                  title={title}
                  aria-label={title}
                  onClick={() => void testModel(provider, model)}
                >
                  <TestStatusIcon status={status}/>
                </button>
              </div>;
            })}</div>
          </article>;
          })}
        </div>
        <div className="role-column"><h3>写作流程分工</h3><p className="section-note">不同环节可使用不同供应商下的模型。</p>{ROLES.map(role => { const ref = catalog.assignments[role.id]; return <label className="role-card" key={role.id}><span><strong>{role.name}</strong><small>{role.detail}</small></span><select value={`${ref.providerId}:${ref.modelId}`} onChange={event => void assign(role.id, event.target.value)}>{choices.map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}</select></label>; })}</div>
      </div>}
      {tab === "scene-pipeline" && <div className="scene-settings">
        <div className="scene-settings-copy">
          <span className="eyebrow">Narrative pipeline</span>
          <h3>章节与支线场景链</h3>
          <p>完整章节和 side/ 支线片段都会逐场写作。支线至少使用推荐最少场数，且每场会校验目标篇幅；场景越多，模型调用和累计 input 通常越高。</p>
        </div>
        <div className="scene-settings-grid">
          <label><span>推荐最少场数</span><input type="number" min="1" max="8" value={sceneDraft.preferredMinScenes} onChange={event => setSceneDraft(current => ({ ...current, preferredMinScenes: Number(event.target.value) }))}/><small>支线片段会把它作为最低场数；完整章节仍按情节弹性取值。</small></label>
          <label><span>推荐最多场数</span><input type="number" min="1" max="8" value={sceneDraft.preferredMaxScenes} onChange={event => setSceneDraft(current => ({ ...current, preferredMaxScenes: Number(event.target.value) }))}/><small>模型默认在推荐区间内规划。</small></label>
          <label><span>允许最多场数</span><input type="number" min="1" max="8" value={sceneDraft.maxScenes} onChange={event => setSceneDraft(current => ({ ...current, maxScenes: Number(event.target.value) }))}/><small>硬上限为 8；超过时 begin_chapter_draft 会拒绝。</small></label>
          <label><span>场景 notes 上限</span><input type="number" min="500" max="8000" step="100" value={sceneDraft.notesMaxCharacters} onChange={event => setSceneDraft(current => ({ ...current, notesMaxCharacters: Number(event.target.value) }))}/><small>主 Agent 每场可提交 500—8000 字；默认 3000。</small></label>
          <label><span>正文硬上限倍率</span><input type="number" min="1.2" max="3" step="0.1" value={sceneDraft.isolatedWriterMaxRatio} onChange={event => setSceneDraft(current => ({ ...current, isolatedWriterMaxRatio: Number(event.target.value) }))}/><small>相对场景目标篇幅；建议区间仍为目标的 85%—120%。</small></label>
        </div>
        <label className="scene-experiment-toggle">
          <input type="checkbox" checked={sceneDraft.isolatedWriter} onChange={event => setSceneDraft(current => ({ ...current, isolatedWriter: event.target.checked }))}/>
          <span><strong>隔离正文 Writer（实验）</strong><small>主 Agent 只提交场景短笔记；正文使用独立纯文本调用生成，再由轻量模型提取离场状态。关闭时沿用现有场景写作。</small></span>
        </label>
        <div className={sceneDraftValid ? "scene-settings-summary" : "scene-settings-summary invalid"}>{sceneDraftValid ? `当前策略：推荐 ${sceneDraft.preferredMinScenes}—${sceneDraft.preferredMaxScenes} 场，最多 ${sceneDraft.maxScenes} 场；notes 最多 ${sceneDraft.notesMaxCharacters} 字，正文硬上限为目标的 ${sceneDraft.isolatedWriterMaxRatio.toFixed(1)} 倍。` : "请检查场景数量、notes 上限（500—8000）与正文倍率（1.2—3.0）。"}</div>
        <div className="scene-settings-actions"><button onClick={() => setSceneDraft(scenePipeline)} disabled={busy}>恢复当前值</button><button className="primary" onClick={() => void saveScenePipeline()} disabled={busy || !sceneDraftValid}>{busy ? "保存中…" : "保存场景链设置"}</button></div>
      </div>}
    </section>
    {editing && <div className="modal-backdrop nested" onMouseDown={() => setEditing(null)}><section className="modal provider-editor" onMouseDown={event => event.stopPropagation()}>
      <div className="provider-editor-head"><div><span className="eyebrow">Provider</span><h2>{editing.id ? "编辑供应商" : "添加供应商"}</h2></div><button className="icon" title="关闭" aria-label="关闭" onClick={() => setEditing(null)}><X size={17} /></button></div>
      <div className="character-form-grid"><label><span>显示名称</span><input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}/></label><label><span>协议类型</span><select value={editing.provider} onChange={e => updateConnection({ provider: e.target.value as ProfileDraft["provider"] })}><option value="openai-compatible">OpenAI 兼容</option><option value="deepseek">DeepSeek</option></select></label><label className="wide"><span>API Base URL</span><input value={editing.baseUrl} onChange={e => updateConnection({ baseUrl: e.target.value })}/></label><label className="wide"><span>API Key（留空保留现有密钥）</span><input type="password" value={editing.apiKey} onChange={e => updateConnection({ apiKey: e.target.value })}/></label></div>
      <div className="model-list-head"><h3>模型</h3><div className="model-list-actions"><button className="ghost" disabled={!canScanModels || scanning || busy} title={canScanModels ? "从供应商读取模型列表" : "请先填写 API Base URL 和 API Key"} onClick={() => void scanProviderModels()}>{scanning ? <LoaderCircle className="test-icon-spin" size={15} /> : <Radar size={15} />}{scanning ? "扫描中…" : "扫描模型"}</button><button disabled={busy || scanning} onClick={() => setEditing({ ...editing, models: [...editing.models, newModel()] })}><Plus size={15} />添加模型</button></div></div>
      {editorFeedback && <div className={editorFeedback.error ? "editor-feedback error" : "editor-feedback"}>{editorFeedback.text}</div>}
      {scannedModels.length > 0 && <section className="model-scan-results">
        <div className="model-scan-head">
          <label><input type="checkbox" checked={importableScannedModels.length > 0 && selectedImportCount === importableScannedModels.length} onChange={event => setSelectedScannedModels(event.target.checked ? new Set(importableScannedModels.map(model => model.name)) : new Set())}/><span>选择全部</span></label>
          <span>{scannedModels.length} 个结果 · {importableScannedModels.length} 个可导入</span>
          <button className="primary" disabled={!selectedImportCount} onClick={importScannedModels}>导入所选（{selectedImportCount}）</button>
        </div>
        <div className="model-scan-list">{scannedModels.map(model => {
          const added = editingModelNames.has(model.name);
          return <label className={added ? "already-added" : ""} key={model.name}><input type="checkbox" disabled={added} checked={!added && selectedScannedModels.has(model.name)} onChange={event => setSelectedScannedModels(current => { const next = new Set(current); if (event.target.checked) next.add(model.name); else next.delete(model.name); return next; })}/><span title={model.name}>{model.name}</span>{added && <small>已添加</small>}</label>;
        })}</div>
      </section>}
      <div className="model-edit-list">{editing.models.map((model, index) => {
        const peak = model.pricing.peakBilling;
        const metered = model.pricing.billingMode !== "unmetered";
        const ratePrefix = peak ? "平时 · " : "";
        return <div className="model-edit-card" key={model.id ?? index}>
          <div className="model-edit-title"><strong>模型 {index + 1}</strong><button className="ghost danger" disabled={editing.models.length === 1} onClick={() => setEditing({ ...editing, models: editing.models.filter((_, i) => i !== index) })}>移除</button></div>
          <div className="model-fields">
            <label><span>模型名称</span><input value={model.name} onChange={e => updateModel(index, { name: e.target.value })}/></label>
            <label><span>上下文窗口</span><input type="number" min="1000" value={model.pricing.contextWindow} onChange={e => updateModel(index, { pricing: { ...model.pricing, contextWindow: Number(e.target.value) } })}/></label>
            <div className="billing-mode-field"><span>计费方式</span><div className="billing-mode-control" role="group" aria-label="计费方式"><button className={metered ? "active" : ""} onClick={() => updateModel(index, { pricing: { ...model.pricing, billingMode: "metered" } })}>按量计费</button><button className={!metered ? "active" : ""} onClick={() => updateModel(index, { pricing: { ...model.pricing, billingMode: "unmetered" } })}>非按量计费</button></div></div>
            {metered && <>
              <label><span>{ratePrefix}缓存命中</span><input type="number" min="0" step="0.001" value={model.pricing.cacheHit} onChange={e => updateModel(index, { pricing: { ...model.pricing, cacheHit: Number(e.target.value) } })}/><em className="field-unit">元 / 百万 token</em></label>
              <label><span>{ratePrefix}缓存未命中</span><input type="number" min="0" step="0.001" value={model.pricing.cacheMiss} onChange={e => updateModel(index, { pricing: { ...model.pricing, cacheMiss: Number(e.target.value) } })}/><em className="field-unit">元 / 百万 token</em></label>
              <label><span>{ratePrefix}输出</span><input type="number" min="0" step="0.001" value={model.pricing.output} onChange={e => updateModel(index, { pricing: { ...model.pricing, output: Number(e.target.value) } })}/><em className="field-unit">元 / 百万 token</em></label>
              <label><span>货币</span><select value={model.pricing.currency} onChange={e => updateModel(index, { pricing: { ...model.pricing, currency: e.target.value as Pricing["currency"] } })}><option value="CNY">CNY 人民币</option><option value="USD">USD 美元</option></select></label>
            </>}
          </div>
          {metered && peak && <div className="peak-billing-note">
            <strong>分时计费（高峰）</strong>
            <ul>
              <li>时段：{peak.windows.map(w => `${w.start}–${w.end}`).join("、")}（{peak.timezone === "Asia/Shanghai" ? "北京时间" : peak.timezone}）</li>
              <li>单价：缓存命中 {peak.cacheHit} · 未命中 {peak.cacheMiss} · 输出 {peak.output}</li>
              <li>保存时高峰价按平时 ×2 自动同步</li>
            </ul>
          </div>}
        </div>;
      })}</div>
      <div className="modal-actions"><button onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={busy || scanning || !editing.name.trim() || !editing.baseUrl.trim() || editing.models.some(model => !model.name.trim())} onClick={() => void saveProfile()}>{busy ? "保存中…" : "保存供应商"}</button></div>
    </section></div>}
  </div>;
}
