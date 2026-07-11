import React, { useEffect, useMemo, useState } from "react";

export type Pricing = { cacheHit: number; cacheMiss: number; output: number; currency: "CNY" | "USD"; contextWindow: number };
export type ProviderModel = { id: string; name: string; pricing: Pricing; temperature?: number; topP?: number };
export type ProviderProfile = { id: string; name: string; provider: "deepseek" | "openai-compatible"; baseUrl: string; apiKeyConfigured: boolean; apiKeyHint: string; models: ProviderModel[] };
export type ModelRole = "agent" | "drafter" | "inline" | "writer" | "reviewer" | "summarizer";
export type ProviderCatalog = { activeProviderId: string; activeModelId: string; assignments: Record<ModelRole, { providerId: string; modelId: string }>; providers: ProviderProfile[] };

type ModelDraft = Omit<ProviderModel, "id"> & { id?: string };
type ProfileDraft = Omit<ProviderProfile, "id" | "apiKeyConfigured" | "apiKeyHint" | "models"> & { id?: string; apiKey: string; models: ModelDraft[] };
type Request = (path: string, init?: RequestInit) => Promise<any>;

const ROLES: Array<{ id: Exclude<ModelRole, "drafter">; name: string; detail: string }> = [
  { id: "agent", name: "Agent 调度", detail: "理解请求、规划任务与调用工具" },
  { id: "inline", name: "行内生成", detail: "短文本补全与局部快速修改" },
  { id: "writer", name: "正文写作", detail: "续写、重写与长篇内容生成" },
  { id: "reviewer", name: "审阅校对", detail: "质量检查、润色与修改建议" },
  { id: "summarizer", name: "上下文摘要", detail: "压缩历史内容以控制上下文长度" },
];

const EMPTY_PRICING: Pricing = { cacheHit: 0, cacheMiss: 0, output: 0, currency: "CNY", contextWindow: 128000 };
const newModel = (): ModelDraft => ({ name: "", pricing: { ...EMPTY_PRICING } });
const emptyProfile = (): ProfileDraft => ({ name: "", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "", models: [newModel()] });

export function ModelConfig({ initialCatalog, request, onClose, onChanged }: { initialCatalog: ProviderCatalog; request: Request; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setCatalog(initialCatalog), [initialCatalog]);

  const choices = useMemo(() => catalog.providers.flatMap(provider => provider.models.map(model => ({ value: `${provider.id}:${model.id}`, label: `${provider.name} / ${model.name}` }))), [catalog]);
  const editProfile = (profile: ProviderProfile) => setEditing({ id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, apiKey: "", models: profile.models.map(model => ({ ...model, pricing: { ...model.pricing } })) });
  const updateModel = (index: number, change: Partial<ModelDraft>) => setEditing(current => current ? { ...current, models: current.models.map((model, i) => i === index ? { ...model, ...change } : model) } : current);

  async function saveProfile() {
    if (!editing || !editing.name.trim() || !editing.baseUrl.trim() || editing.models.some(model => !model.name.trim())) return;
    setBusy(true); setError("");
    try {
      const result = await request("/api/providers", { method: "PUT", body: JSON.stringify({ ...editing, apiKey: editing.apiKey || undefined }) });
      setCatalog(result.catalog); setEditing(null); setMessage("供应商配置已保存"); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
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

  return <div className="model-config-backdrop">
    <section className="model-config-view">
      <div className="management-head"><div><span className="eyebrow">AI infrastructure</span><h2>模型与写作流程</h2><p>管理供应商、模型及各写作环节的模型分工。</p></div><div className="management-actions"><button onClick={() => setEditing(emptyProfile())}>+ 添加供应商</button><button className="primary" onClick={onClose}>完成</button></div></div>
      {(error || message) && <div className={error ? "config-feedback error" : "config-feedback"}>{error || message}</div>}
      <div className="model-config-layout">
        <div className="provider-column">
          <h3>供应商与模型</h3>
          {catalog.providers.map(provider => <article className="provider-card" key={provider.id}>
            <div className="provider-card-head"><div><strong>{provider.name}</strong><span>{provider.provider === "deepseek" ? "DeepSeek" : "OpenAI 兼容"} · {provider.apiKeyConfigured ? provider.apiKeyHint : "未配置密钥"}</span></div><div><button className="ghost" onClick={() => editProfile(provider)}>编辑</button><button className="ghost danger" disabled={catalog.providers.length <= 1} onClick={() => void removeProfile(provider)}>删除</button></div></div>
            <div className="provider-models">{provider.models.map(model => <div className="provider-model" key={model.id}><span className="model-dot"/><div><b>{model.name}</b><small>{model.pricing.contextWindow.toLocaleString()} context · {model.pricing.currency}</small></div></div>)}</div>
          </article>)}
        </div>
        <div className="role-column"><h3>写作流程分工</h3><p className="section-note">不同环节可使用不同供应商下的模型。</p>{ROLES.map(role => { const ref = catalog.assignments[role.id]; return <label className="role-card" key={role.id}><span><strong>{role.name}</strong><small>{role.detail}</small></span><select value={`${ref.providerId}:${ref.modelId}`} onChange={event => void assign(role.id, event.target.value)}>{choices.map(choice => <option value={choice.value} key={choice.value}>{choice.label}</option>)}</select></label>; })}</div>
      </div>
    </section>
    {editing && <div className="modal-backdrop nested" onMouseDown={() => setEditing(null)}><section className="modal provider-editor" onMouseDown={event => event.stopPropagation()}>
      <div className="provider-editor-head"><div><span className="eyebrow">Provider</span><h2>{editing.id ? "编辑供应商" : "添加供应商"}</h2></div><button className="icon" onClick={() => setEditing(null)}>×</button></div>
      <div className="character-form-grid"><label><span>显示名称</span><input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}/></label><label><span>协议类型</span><select value={editing.provider} onChange={e => setEditing({ ...editing, provider: e.target.value as ProfileDraft["provider"] })}><option value="openai-compatible">OpenAI 兼容</option><option value="deepseek">DeepSeek</option></select></label><label className="wide"><span>API Base URL</span><input value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })}/></label><label className="wide"><span>API Key（留空保留现有密钥）</span><input type="password" value={editing.apiKey} onChange={e => setEditing({ ...editing, apiKey: e.target.value })}/></label></div>
      <div className="model-list-head"><h3>模型</h3><button onClick={() => setEditing({ ...editing, models: [...editing.models, newModel()] })}>+ 添加模型</button></div>
      <div className="model-edit-list">{editing.models.map((model, index) => <div className="model-edit-card" key={model.id ?? index}><div className="model-edit-title"><strong>模型 {index + 1}</strong><button className="ghost danger" disabled={editing.models.length === 1} onClick={() => setEditing({ ...editing, models: editing.models.filter((_, i) => i !== index) })}>移除</button></div><div className="model-fields"><label><span>模型名称</span><input value={model.name} onChange={e => updateModel(index, { name: e.target.value })}/></label><label><span>上下文窗口</span><input type="number" min="1000" value={model.pricing.contextWindow} onChange={e => updateModel(index, { pricing: { ...model.pricing, contextWindow: Number(e.target.value) } })}/></label><label><span>输入单价 / 百万 token</span><input type="number" min="0" step="0.001" value={model.pricing.cacheMiss} onChange={e => updateModel(index, { pricing: { ...model.pricing, cacheMiss: Number(e.target.value) } })}/></label><label><span>输出单价 / 百万 token</span><input type="number" min="0" step="0.001" value={model.pricing.output} onChange={e => updateModel(index, { pricing: { ...model.pricing, output: Number(e.target.value) } })}/></label></div></div>)}</div>
      <div className="modal-actions"><button onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={busy || !editing.name.trim() || !editing.baseUrl.trim() || editing.models.some(model => !model.name.trim())} onClick={() => void saveProfile()}>{busy ? "保存中…" : "保存供应商"}</button></div>
    </section></div>}
  </div>;
}
