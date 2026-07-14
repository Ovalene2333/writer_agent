import React, { useEffect, useMemo, useState } from "react";

export type Pricing = {
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
export type ModelRole = "agent" | "roleplay" | "drafter" | "inline" | "writer" | "reviewer" | "summarizer";
export type ProviderCatalog = { activeProviderId: string; activeModelId: string; assignments: Record<ModelRole, { providerId: string; modelId: string }>; providers: ProviderProfile[] };

type ModelDraft = Omit<ProviderModel, "id"> & { id?: string };
type ProfileDraft = Omit<ProviderProfile, "id" | "apiKeyConfigured" | "apiKeyHint" | "models"> & { id?: string; apiKey: string; models: ModelDraft[] };
type Request = (path: string, init?: RequestInit) => Promise<any>;

const ROLES: Array<{ id: Exclude<ModelRole, "drafter">; name: string; detail: string }> = [
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
    return <svg className="test-icon test-icon-spin" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" opacity=".2"/>
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/>
    </svg>;
  }
  if (status === "ok") {
    return <svg className="test-icon test-icon-ok" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" fill="currentColor" opacity=".14"/>
      <circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.9"/>
      <path d="M7.2 12.4l3.1 3.1 6.5-6.8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>;
  }
  if (status === "fail") {
    return <svg className="test-icon test-icon-fail" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" fill="currentColor" opacity=".12"/>
      <circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.9"/>
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/>
    </svg>;
  }
  // idle: radar scan — fills the button, reads as “probe”
  return <svg className="test-icon test-icon-idle" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.7" opacity=".28"/>
    <circle cx="12" cy="12" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.7" opacity=".5"/>
    <path d="M12 12 L18.2 7.4" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"/>
    <path d="M12 12 A6.8 6.8 0 0 1 17.7 9.1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".85"/>
    <circle cx="12" cy="12" r="2.15" fill="currentColor"/>
  </svg>;
}

export function ModelConfig({ initialCatalog, request, onClose, onChanged }: { initialCatalog: ProviderCatalog; request: Request; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testStatus, setTestStatus] = useState<Record<string, TestStatus>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setCatalog(initialCatalog), [initialCatalog]);

  const anyTesting = Object.values(testStatus).some(status => status === "testing");
  const choices = useMemo(() => catalog.providers.flatMap(provider => provider.models.map(model => ({ value: `${provider.id}:${model.id}`, label: `${provider.name} / ${model.name}` }))), [catalog]);
  const editProfile = (profile: ProviderProfile) => setEditing({ id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, apiKey: "", models: profile.models.map(model => ({ ...model, pricing: { ...model.pricing } })) });
  const updateModel = (index: number, change: Partial<ModelDraft>) => setEditing(current => current ? { ...current, models: current.models.map((model, i) => i === index ? { ...model, ...change } : model) } : current);
  const modelKey = (providerId: string, modelId: string) => `${providerId}:${modelId}`;
  const providerBatchKey = (providerId: string) => `provider:${providerId}`;
  const statusOf = (key: string): TestStatus => testStatus[key] ?? "idle";

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

  return <div className="model-config-backdrop">
    <section className="model-config-view">
      <div className="management-head"><div><span className="eyebrow">AI infrastructure</span><h2>模型与写作流程</h2><p>管理供应商、模型及各写作环节的模型分工。测试连接仅请求模型列表，不消耗 token。</p></div><div className="management-actions"><button onClick={() => setEditing(emptyProfile())}>+ 添加供应商</button><button className="primary" onClick={onClose}>完成</button></div></div>
      {(error || message) && <div className={error ? "config-feedback error" : "config-feedback"} style={{ whiteSpace: "pre-wrap" }}>{error || message}</div>}
      <div className="model-config-layout">
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
                  <small>{model.pricing.contextWindow.toLocaleString()} context · {model.pricing.currency}{model.pricing.peakBilling ? " · 峰谷分时" : ""}</small>
                  <small className="model-price-line">命中 {model.pricing.cacheHit} · 未命中 {model.pricing.cacheMiss} · 输出 {model.pricing.output}</small>
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
      </div>
    </section>
    {editing && <div className="modal-backdrop nested" onMouseDown={() => setEditing(null)}><section className="modal provider-editor" onMouseDown={event => event.stopPropagation()}>
      <div className="provider-editor-head"><div><span className="eyebrow">Provider</span><h2>{editing.id ? "编辑供应商" : "添加供应商"}</h2></div><button className="icon" onClick={() => setEditing(null)}>×</button></div>
      <div className="character-form-grid"><label><span>显示名称</span><input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}/></label><label><span>协议类型</span><select value={editing.provider} onChange={e => setEditing({ ...editing, provider: e.target.value as ProfileDraft["provider"] })}><option value="openai-compatible">OpenAI 兼容</option><option value="deepseek">DeepSeek</option></select></label><label className="wide"><span>API Base URL</span><input value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })}/></label><label className="wide"><span>API Key（留空保留现有密钥）</span><input type="password" value={editing.apiKey} onChange={e => setEditing({ ...editing, apiKey: e.target.value })}/></label></div>
      <div className="model-list-head"><h3>模型</h3><button onClick={() => setEditing({ ...editing, models: [...editing.models, newModel()] })}>+ 添加模型</button></div>
      <div className="model-edit-list">{editing.models.map((model, index) => {
        const peak = model.pricing.peakBilling;
        const ratePrefix = peak ? "平时 · " : "";
        return <div className="model-edit-card" key={model.id ?? index}>
          <div className="model-edit-title"><strong>模型 {index + 1}</strong><button className="ghost danger" disabled={editing.models.length === 1} onClick={() => setEditing({ ...editing, models: editing.models.filter((_, i) => i !== index) })}>移除</button></div>
          <div className="model-fields">
            <label><span>模型名称</span><input value={model.name} onChange={e => updateModel(index, { name: e.target.value })}/></label>
            <label><span>上下文窗口</span><input type="number" min="1000" value={model.pricing.contextWindow} onChange={e => updateModel(index, { pricing: { ...model.pricing, contextWindow: Number(e.target.value) } })}/></label>
            <label><span>{ratePrefix}缓存命中</span><input type="number" min="0" step="0.001" value={model.pricing.cacheHit} onChange={e => updateModel(index, { pricing: { ...model.pricing, cacheHit: Number(e.target.value) } })}/><em className="field-unit">元 / 百万 token</em></label>
            <label><span>{ratePrefix}缓存未命中</span><input type="number" min="0" step="0.001" value={model.pricing.cacheMiss} onChange={e => updateModel(index, { pricing: { ...model.pricing, cacheMiss: Number(e.target.value) } })}/><em className="field-unit">元 / 百万 token</em></label>
            <label><span>{ratePrefix}输出</span><input type="number" min="0" step="0.001" value={model.pricing.output} onChange={e => updateModel(index, { pricing: { ...model.pricing, output: Number(e.target.value) } })}/><em className="field-unit">元 / 百万 token</em></label>
            <label><span>货币</span><select value={model.pricing.currency} onChange={e => updateModel(index, { pricing: { ...model.pricing, currency: e.target.value as Pricing["currency"] } })}><option value="CNY">CNY 人民币</option><option value="USD">USD 美元</option></select></label>
          </div>
          {peak && <div className="peak-billing-note">
            <strong>分时计费（高峰）</strong>
            <ul>
              <li>时段：{peak.windows.map(w => `${w.start}–${w.end}`).join("、")}（{peak.timezone === "Asia/Shanghai" ? "北京时间" : peak.timezone}）</li>
              <li>单价：缓存命中 {peak.cacheHit} · 未命中 {peak.cacheMiss} · 输出 {peak.output}</li>
              <li>保存时高峰价按平时 ×2 自动同步</li>
            </ul>
          </div>}
        </div>;
      })}</div>
      <div className="modal-actions"><button onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={busy || !editing.name.trim() || !editing.baseUrl.trim() || editing.models.some(model => !model.name.trim())} onClick={() => void saveProfile()}>{busy ? "保存中…" : "保存供应商"}</button></div>
    </section></div>}
  </div>;
}
