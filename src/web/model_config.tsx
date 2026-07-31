import React, { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Library, LoaderCircle, Palette, Pencil, Plus, Radar, ShieldCheck, WandSparkles, Wifi, X, XCircle } from "lucide-react";

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
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ResponseVerbosity = "low" | "medium" | "high";
export type ProviderModel = { id: string; name: string; pricing: Pricing; temperature?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number; reasoningEffort?: ReasoningEffort; verbosity?: ResponseVerbosity; disableSampling?: boolean; supportsMultimodal?: boolean };
export type ProviderProfile = { id: string; name: string; provider: "deepseek" | "openai-compatible" | "openai-responses"; baseUrl: string; proxyUrl?: string; apiKeyConfigured: boolean; apiKeyHint: string; models: ProviderModel[] };
export type ModelRole =
  | "agent"
  | "flash"
  | "drafter"
  | "inline"
  | "writer"
  | "reviewer"
  | "summarizer"
  | "roleplay"
  | "roleplay_perception"
  | "roleplay_quality"
  | "roleplay_memory";
export type ProviderCatalog = { activeProviderId: string; activeModelId: string; assignments: Record<ModelRole, { providerId: string; modelId: string }>; providers: ProviderProfile[] };
export type ScenePipelineSettings = {
  enabled: boolean;
  preferredMinScenes: number;
  preferredMaxScenes: number;
  maxScenes: number;
  notesMaxCharacters: number;
  isolatedWriterMaxRatio: number;
  isolatedWriter: boolean;
  candidateCount: number;
};
export type ProseLengthSettings = {
  chapterTargetCharacters: number;
  enforceMinimum: boolean;
};
export type WritingExecutionMode = "delegated" | "fast";
export type AgentStepBudgetMode = "hard" | "experimental";
export type SettingsSection = "models" | "writing" | "style" | "prose-gates" | "continuity-facts" | "connection" | "appearance";

type ModelDraft = Omit<ProviderModel, "id"> & { id?: string };
type ProfileDraft = Omit<ProviderProfile, "id" | "apiKeyConfigured" | "apiKeyHint" | "models"> & { id?: string; apiKey: string; models: ModelDraft[] };
type ScannedModel = { name: string; pricing: Pricing; contextFromProvider?: boolean };
type Request = (path: string, init?: RequestInit) => Promise<any>;

type VisibleModelRole = Exclude<ModelRole, "drafter">;
type RoleDefinition = { id: VisibleModelRole; name: string; detail: string };

const WRITING_ROLES: RoleDefinition[] = [
  { id: "flash", name: "通用 Flash", detail: "低延迟、低成本的推荐、提取与轻量辅助任务" },
  { id: "agent", name: "Agent 调度", detail: "理解请求、规划任务与调用工具" },
  { id: "inline", name: "行内生成", detail: "短文本补全与局部快速修改" },
  { id: "writer", name: "正文写作", detail: "续写、重写与长篇内容生成" },
  { id: "reviewer", name: "审阅校对", detail: "质量检查、润色与修改建议；关闭「终审跟随正文模型」后才用于整章终审" },
  { id: "summarizer", name: "上下文摘要", detail: "压缩历史内容以控制上下文长度" },
];

const ROLEPLAY_ROLES: RoleDefinition[] = [
  { id: "roleplay", name: "角色演出", detail: "角色试演、主动开场、续演、身份代答与场景生成" },
  { id: "roleplay_perception", name: "感知编译", detail: "把玩家输入整理为角色本轮能够听见、看见与感受到的信息" },
  { id: "roleplay_quality", name: "演出终审", detail: "清理越权、解释腔与重复内容，输出最终角色回复" },
  { id: "roleplay_memory", name: "现场记忆", detail: "维护角色可知的滚动摘要、现场状态与长期事实" },
];

const EMPTY_PRICING: Pricing = { cacheHit: 0, cacheMiss: 0, output: 0, currency: "CNY", contextWindow: 128000 };
const newModel = (): ModelDraft => ({ name: "", pricing: { ...EMPTY_PRICING } });
const emptyProfile = (): ProfileDraft => ({ name: "", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", proxyUrl: "", apiKey: "", models: [newModel()] });
const optionalNumber = (value: string): number | undefined => value.trim() === "" ? undefined : Number(value);
/** Compact context label for scan results, e.g. 128k / 1.05M. */
function formatContextWindowLabel(contextWindow: number | undefined): string {
  if (!(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow >= 1000)) return "";
  if (contextWindow >= 1_000_000) {
    const millions = contextWindow / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(2).replace(/\.?0+$/, "")}M ctx`;
  }
  if (contextWindow >= 10_000) {
    const thousands = contextWindow / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1).replace(/\.0$/, "")}k ctx`;
  }
  return `${Math.round(contextWindow)} ctx`;
}

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
  proseLength: ProseLengthSettings;
  writingMode: WritingExecutionMode;
  characterEvolutionEnabled: boolean;
  continuityFactsEnabled: boolean;
  reviewFollowsProseModel: boolean;
  stepBudgetMode: AgentStepBudgetMode;
  maxAgentSteps: number;
  section: SettingsSection;
  styleContent: React.ReactNode;
  proseGatesContent: React.ReactNode;
  continuityFactsContent: React.ReactNode;
  connectionContent: React.ReactNode;
  appearanceContent: React.ReactNode;
  connectionAvailable: boolean;
  request: Request;
  onClose: () => void;
  onSectionChanged: (section: SettingsSection) => void;
  onChanged: () => void | Promise<void>;
  onScenePipelineChanged: (settings: ScenePipelineSettings) => void;
  onProseLengthChanged: (settings: ProseLengthSettings) => void;
  onCharacterEvolutionChanged: (enabled: boolean) => void;
  onContinuityFactsChanged: (enabled: boolean) => void;
  onReviewFollowsProseModelChanged: (enabled: boolean) => void;
  onStepBudgetChanged: (settings: { stepBudgetMode: AgentStepBudgetMode; maxAgentSteps: number }) => void;
};

export function ModelConfig({
  initialCatalog,
  scenePipeline,
  proseLength,
  writingMode,
  characterEvolutionEnabled,
  continuityFactsEnabled,
  reviewFollowsProseModel,
  stepBudgetMode,
  maxAgentSteps,
  section,
  styleContent,
  proseGatesContent,
  continuityFactsContent,
  connectionContent,
  appearanceContent,
  connectionAvailable,
  request,
  onClose,
  onSectionChanged,
  onChanged,
  onScenePipelineChanged,
  onProseLengthChanged,
  onCharacterEvolutionChanged,
  onContinuityFactsChanged,
  onReviewFollowsProseModelChanged,
  onStepBudgetChanged,
}: ModelConfigProps) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [sceneDraft, setSceneDraft] = useState(scenePipeline);
  const [lengthDraft, setLengthDraft] = useState(proseLength);
  const [characterEvolutionDraft, setCharacterEvolutionDraft] = useState(characterEvolutionEnabled);
  const [continuityFactsDraft, setContinuityFactsDraft] = useState(continuityFactsEnabled);
  const [reviewFollowsProseDraft, setReviewFollowsProseDraft] = useState(reviewFollowsProseModel);
  const [stepBudgetModeDraft, setStepBudgetModeDraft] = useState(stepBudgetMode);
  const [maxAgentStepsDraft, setMaxAgentStepsDraft] = useState(maxAgentSteps);
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
  useEffect(() => setLengthDraft(proseLength), [proseLength]);
  useEffect(() => setCharacterEvolutionDraft(characterEvolutionEnabled), [characterEvolutionEnabled]);
  useEffect(() => setContinuityFactsDraft(continuityFactsEnabled), [continuityFactsEnabled]);
  useEffect(() => setReviewFollowsProseDraft(reviewFollowsProseModel), [reviewFollowsProseModel]);
  useEffect(() => setStepBudgetModeDraft(stepBudgetMode), [stepBudgetMode]);
  useEffect(() => setMaxAgentStepsDraft(maxAgentSteps), [maxAgentSteps]);

  const anyTesting = Object.values(testStatus).some(status => status === "testing");
  const lengthDraftInvalid = !Number.isInteger(lengthDraft.chapterTargetCharacters)
    || lengthDraft.chapterTargetCharacters < 500
    || lengthDraft.chapterTargetCharacters > 50_000;
  const stepsDraftInvalid = !Number.isInteger(maxAgentStepsDraft)
    || maxAgentStepsDraft < 8
    || maxAgentStepsDraft > 100;
  const writingSettingsDirty = characterEvolutionDraft !== characterEvolutionEnabled
    || lengthDraft.chapterTargetCharacters !== proseLength.chapterTargetCharacters
    || lengthDraft.enforceMinimum !== proseLength.enforceMinimum
    || continuityFactsDraft !== continuityFactsEnabled
    || reviewFollowsProseDraft !== reviewFollowsProseModel
    || stepBudgetModeDraft !== stepBudgetMode
    || maxAgentStepsDraft !== maxAgentSteps
    || Object.keys(sceneDraft).some(key => sceneDraft[key as keyof ScenePipelineSettings] !== scenePipeline[key as keyof ScenePipelineSettings]);
  const sceneDraftValid = !lengthDraftInvalid && !stepsDraftInvalid && [sceneDraft.preferredMinScenes, sceneDraft.preferredMaxScenes, sceneDraft.maxScenes]
    .every(value => Number.isInteger(value) && value >= 1 && value <= 8)
    && sceneDraft.preferredMinScenes <= sceneDraft.preferredMaxScenes
    && sceneDraft.preferredMaxScenes <= sceneDraft.maxScenes
    && Number.isInteger(sceneDraft.notesMaxCharacters)
    && sceneDraft.notesMaxCharacters >= 500
    && sceneDraft.notesMaxCharacters <= 8_000
    && Number.isInteger(sceneDraft.candidateCount)
    && sceneDraft.candidateCount >= 1
    && sceneDraft.candidateCount <= 3
    && Number.isFinite(sceneDraft.isolatedWriterMaxRatio)
    && sceneDraft.isolatedWriterMaxRatio >= 1.2
    && sceneDraft.isolatedWriterMaxRatio <= 3;
  const sceneCountInvalid = ![sceneDraft.preferredMinScenes, sceneDraft.preferredMaxScenes, sceneDraft.maxScenes]
    .every(value => Number.isInteger(value) && value >= 1 && value <= 8)
    || sceneDraft.preferredMinScenes > sceneDraft.preferredMaxScenes
    || sceneDraft.preferredMaxScenes > sceneDraft.maxScenes;
  const notesLimitInvalid = !Number.isInteger(sceneDraft.notesMaxCharacters)
    || sceneDraft.notesMaxCharacters < 500
    || sceneDraft.notesMaxCharacters > 8_000;
  const writerSettingsInvalid = !Number.isInteger(sceneDraft.candidateCount)
    || sceneDraft.candidateCount < 1
    || sceneDraft.candidateCount > 3
    || !Number.isFinite(sceneDraft.isolatedWriterMaxRatio)
    || sceneDraft.isolatedWriterMaxRatio < 1.2
    || sceneDraft.isolatedWriterMaxRatio > 3;
  const choices = useMemo(() => catalog.providers.flatMap(provider => provider.models.map(model => ({ value: `${provider.id}:${model.id}`, label: `${provider.name} / ${model.name}` }))), [catalog]);
  const resetScan = () => { setScannedModels([]); setSelectedScannedModels(new Set()); setEditorFeedback(null); };
  const addProfile = () => { resetScan(); setEditing(emptyProfile()); };
  const editProfile = (profile: ProviderProfile) => {
    resetScan();
    setEditing({ id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, proxyUrl: profile.proxyUrl ?? "", apiKey: "", models: profile.models.map(model => ({ ...model, pricing: { ...model.pricing } })) });
  };
  const updateConnection = (change: Partial<Pick<ProfileDraft, "provider" | "baseUrl" | "proxyUrl" | "apiKey">>) => {
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
          proxyUrl: editing.proxyUrl || undefined,
          apiKey: editing.apiKey || undefined,
        }),
      }) as { models: ScannedModel[] };
      const existing = new Set(editing.models.map(model => model.name.trim()).filter(Boolean));
      const available = result.models.filter(model => !existing.has(model.name));
      const withContext = result.models.filter(model => model.contextFromProvider).length;
      setScannedModels(result.models);
      setSelectedScannedModels(new Set(available.map(model => model.name)));
      setEditorFeedback({
        error: false,
        text: withContext > 0
          ? `扫描到 ${result.models.length} 个模型（${withContext} 个含供应商上下文窗口），其中 ${available.length} 个尚未添加`
          : `扫描到 ${result.models.length} 个模型，其中 ${available.length} 个尚未添加；供应商未返回上下文窗口，导入后使用默认值`,
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

  async function saveWritingSettings() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/agent-settings", {
        method: "POST",
        body: JSON.stringify({
          scenePipeline: sceneDraft,
          proseLength: lengthDraft,
          characterEvolutionEnabled: characterEvolutionDraft,
          continuityFactsEnabled: continuityFactsDraft,
          reviewFollowsProseModel: reviewFollowsProseDraft,
          stepBudgetMode: stepBudgetModeDraft,
          maxAgentSteps: maxAgentStepsDraft,
        }),
      }) as {
        scenePipeline: ScenePipelineSettings;
        proseLength: ProseLengthSettings;
        characterEvolutionEnabled: boolean;
        continuityFactsEnabled: boolean;
        reviewFollowsProseModel: boolean;
        stepBudgetMode: AgentStepBudgetMode;
        maxAgentSteps: number;
      };
      setSceneDraft(result.scenePipeline);
      setLengthDraft(result.proseLength);
      setCharacterEvolutionDraft(result.characterEvolutionEnabled);
      setContinuityFactsDraft(result.continuityFactsEnabled);
      setReviewFollowsProseDraft(result.reviewFollowsProseModel);
      setStepBudgetModeDraft(result.stepBudgetMode);
      setMaxAgentStepsDraft(result.maxAgentSteps);
      onScenePipelineChanged(result.scenePipeline);
      onProseLengthChanged(result.proseLength);
      onCharacterEvolutionChanged(result.characterEvolutionEnabled);
      onContinuityFactsChanged(result.continuityFactsEnabled);
      onReviewFollowsProseModelChanged(result.reviewFollowsProseModel);
      onStepBudgetChanged({ stepBudgetMode: result.stepBudgetMode, maxAgentSteps: result.maxAgentSteps });
      setMessage("写作设置已保存，将从下一次 Agent 任务开始生效");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function resetWritingSettings() {
    setSceneDraft(scenePipeline);
    setLengthDraft(proseLength);
    setCharacterEvolutionDraft(characterEvolutionEnabled);
    setContinuityFactsDraft(continuityFactsEnabled);
    setReviewFollowsProseDraft(reviewFollowsProseModel);
    setStepBudgetModeDraft(stepBudgetMode);
    setMaxAgentStepsDraft(maxAgentSteps);
    setError("");
    setMessage("");
  }

  function closeSettings() {
    if (writingSettingsDirty && !confirm("写作设置尚未保存，确定要放弃这些修改并返回工作区吗？")) return;
    onClose();
  }

  function selectSection(nextSection: SettingsSection) {
    if (section === "writing" && nextSection !== "writing" && writingSettingsDirty
      && !confirm("写作设置尚未保存，确定要放弃这些修改并切换分类吗？")) return;
    if (section === "writing" && nextSection !== "writing") resetWritingSettings();
    onSectionChanged(nextSection);
    setError("");
    setMessage("");
  }

  const sectionMeta: Record<SettingsSection, { eyebrow: string; title: string; description: string }> = {
    models: { eyebrow: "Model routing", title: "模型与分工", description: "管理模型连接，并为写作流程的不同环节分配模型。" },
    writing: { eyebrow: "Writing behavior", title: "写作行为", description: "调整角色演进、可选场景链与正文生成策略。" },
    style: { eyebrow: "Writing style", title: "写作风格", description: "管理写作模板、范文与采样建议。" },
    "prose-gates": { eyebrow: "Review rules", title: "作者复审规则", description: "管理项目级语义复审规则。" },
    "continuity-facts": { eyebrow: "Continuity", title: "连续性事实", description: "维护可追溯的长期事实索引。" },
    connection: { eyebrow: "Network", title: "连接设置", description: "查看当前通道并调整局域网与公网偏好。" },
    appearance: { eyebrow: "Appearance", title: "界面主题", description: "选择工作区的明暗与配色方案。" },
  };
  const activeMeta = sectionMeta[section];

  return <div className="model-config-backdrop management-page">
    <section className="model-config-view">
      <div className="management-head settings-page-head"><div><span className="eyebrow">Settings</span><h2>设置</h2></div><button className="icon" title="返回工作区" aria-label="返回工作区" onClick={closeSettings}><X size={17} /></button></div>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="设置分类">
          <button className={section === "models" ? "active" : ""} aria-current={section === "models" ? "page" : undefined} onClick={() => selectSection("models")}>
            <Bot size={17}/>
            <span><strong>模型与分工</strong><small>供应商、模型和流程角色</small></span>
          </button>
          <button className={section === "writing" ? "active" : ""} aria-current={section === "writing" ? "page" : undefined} onClick={() => selectSection("writing")}>
            <Pencil size={17}/>
            <span><strong>写作行为</strong><small>角色演进与场景生成</small></span>
            {writingSettingsDirty && <i className="settings-dirty-dot" title="有未保存的修改"/>}
          </button>
          <button className={section === "style" ? "active" : ""} aria-current={section === "style" ? "page" : undefined} onClick={() => selectSection("style")}>
            <WandSparkles size={17}/>
            <span><strong>写作风格</strong><small>模板、范文与采样建议</small></span>
          </button>
          <button className={section === "prose-gates" ? "active" : ""} aria-current={section === "prose-gates" ? "page" : undefined} onClick={() => selectSection("prose-gates")}>
            <ShieldCheck size={17}/>
            <span><strong>作者复审规则</strong><small>语义门禁与长期偏好</small></span>
          </button>
          <button className={section === "continuity-facts" ? "active" : ""} aria-current={section === "continuity-facts" ? "page" : undefined} onClick={() => selectSection("continuity-facts")}>
            <Library size={17}/>
            <span><strong>连续性事实</strong><small>事实索引与来源证据</small></span>
          </button>
          <button className={section === "connection" ? "active" : ""} aria-current={section === "connection" ? "page" : undefined} disabled={!connectionAvailable} onClick={() => selectSection("connection")}>
            <Wifi size={17}/>
            <span><strong>连接设置</strong><small>{connectionAvailable ? "局域网与公网通道" : "当前仅有单一通道"}</small></span>
          </button>
          <button className={section === "appearance" ? "active" : ""} aria-current={section === "appearance" ? "page" : undefined} onClick={() => selectSection("appearance")}>
            <Palette size={17}/>
            <span><strong>界面主题</strong><small>明暗模式与工作区配色</small></span>
          </button>
        </nav>
        <main className="settings-content">
          <div className="settings-content-head">
            <div>
              <span className="eyebrow">{activeMeta.eyebrow}</span>
              <h3>{activeMeta.title}</h3>
              <p>{activeMeta.description}</p>
            </div>
            {section === "models" && <button onClick={addProfile}><Plus size={15}/>添加供应商</button>}
          </div>
          {(error || message) && <div className={error ? "config-feedback error" : "config-feedback"} style={{ whiteSpace: "pre-wrap" }} role={error ? "alert" : "status"}>{error || message}</div>}
          {section === "models" && <div className="model-config-layout">
        <div className="provider-column">
          <h3>供应商与模型</h3>
          {catalog.providers.map(provider => {
            const batchStatus = statusOf(providerBatchKey(provider.id));
            return <article className="provider-card" key={provider.id}>
            <div className="provider-card-head">
              <div><strong>{provider.name}</strong><span>{provider.provider === "deepseek" ? "DeepSeek" : provider.provider === "openai-responses" ? "OpenAI Responses" : "OpenAI 兼容"} · {provider.apiKeyConfigured ? provider.apiKeyHint : "未配置密钥"}</span></div>
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
        <div className="role-column">
          {([
            {
              id: "writing",
              title: "写作流程分工",
              note: "写作 Agent、正文、审阅与上下文处理使用的模型。",
              roles: WRITING_ROLES,
            },
            {
              id: "roleplay",
              title: "角色扮演流程分工",
              note: "角色演出、感知、终审和现场记忆独立配置，不再复用写作模型槽位。",
              roles: ROLEPLAY_ROLES,
            },
          ] as const).map(group => (
            <section className="model-role-group" key={group.id}>
              <h3>{group.title}</h3>
              <p className="section-note">{group.note}</p>
              {group.roles.map(role => {
                const ref = catalog.assignments[role.id];
                const value = `${ref.providerId}:${ref.modelId}`;
                const selectedLabel = choices.find(choice => choice.value === value)?.label ?? value;
                return (
                  <label className="role-card" key={role.id}>
                    <span>
                      <strong>{role.name}</strong>
                      <small>{role.detail}</small>
                    </span>
                    <select
                      value={value}
                      title={selectedLabel}
                      onChange={event => void assign(role.id, event.target.value)}
                    >
                      {choices.map(choice => (
                        <option value={choice.value} key={choice.value} title={choice.label}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
          </div>}
          {section === "writing" && <div className="scene-settings">
        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>通用行为</h4><p>无论采用哪种正文模式都生效。</p></div></div>
          <label className="writing-setting-row">
            <input type="checkbox" checked={characterEvolutionDraft} onChange={event => setCharacterEvolutionDraft(event.target.checked)}/>
            <span><strong>角色演进</strong><small>允许叙事任务自动追加角色经历和故事状态。关闭后仍可显式新建或编辑角色卡。</small></span>
          </label>
          <label className="writing-setting-row">
            <input type="checkbox" checked={continuityFactsDraft} onChange={event => setContinuityFactsDraft(event.target.checked)}/>
            <span><strong>连续性事实</strong><small>接受正文或设定后调用摘要模型提取事实，并在后续相关任务中注入。关闭时不增加审批等待、模型调用或写作上下文。</small></span>
          </label>
          <label className="writing-setting-row">
            <input type="checkbox" checked={reviewFollowsProseDraft} onChange={event => setReviewFollowsProseDraft(event.target.checked)}/>
            <span><strong>终审跟随正文模型</strong><small>整章终审与候选评判使用「正文写作」的模型。判「像不像人写的」靠语感，用更便宜的模型评它自己写不出来的文字，只会把标准降到它的水平。关闭后改用「审阅校对」角色的模型。</small></span>
          </label>
        </section>

        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>Agent 步数预算</h4><p>控制单次任务最多跑多少步；到上限后暂停并保留「续跑」，不丢上下文。</p></div></div>
          <div className="scene-settings-grid compact">
            <label>
              <span>预算策略</span>
              <select
                value={stepBudgetModeDraft}
                onChange={event => setStepBudgetModeDraft(event.target.value as AgentStepBudgetMode)}
              >
                <option value="hard">硬上限（推荐日常）</option>
                <option value="experimental">实验：soft + 停滞收敛</option>
              </select>
              <small>{stepBudgetModeDraft === "hard"
                ? "到达配置步数即暂停，逻辑简单可预期。"
                : "按剩余工作算 soft 预算，停滞时强制收敛；硬上限仍为下方配置值。"}</small>
            </label>
            <label className={stepsDraftInvalid ? "field-invalid" : ""}>
              <span>步数硬上限</span>
              <input
                aria-invalid={stepsDraftInvalid}
                type="number"
                min={8}
                max={100}
                step={1}
                value={maxAgentStepsDraft}
                onChange={event => setMaxAgentStepsDraft(Number(event.target.value))}
              />
              <small>8—100；两种策略共用此硬顶。hard 模式到顶即停；experimental 在顶下另有 soft/停滞收敛。</small>
            </label>
          </div>
        </section>

        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>章节篇幅</h4><p>不在对话里说字数时，这里就是每章的目标长度；说了「写 6000 字」或「这章长一点」时以对话为准。</p></div></div>
          <div className="scene-settings-grid compact">
            <label className={lengthDraftInvalid ? "field-invalid" : ""}><span>默认章节字数</span><input aria-invalid={lengthDraftInvalid} type="number" min="500" max="50000" step="100" value={lengthDraft.chapterTargetCharacters} onChange={event => setLengthDraft(current => ({ ...current, chapterTargetCharacters: Number(event.target.value) }))}/><small>500—50000 字，不计空白。</small></label>
          </div>
          <label className="writing-setting-row">
            <input type="checkbox" checked={lengthDraft.enforceMinimum} onChange={event => setLengthDraft(current => ({ ...current, enforceMinimum: event.target.checked }))}/>
            <span><strong>字数不足时拦截交付</strong><small>默认关闭：偏短只在质量卡上提示，正文照常提交，需要更长直接说一句就行。打开后不达下限会要求重写。超出上限任何时候都会被拦。</small></span>
          </label>
        </section>

        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>可选场景链</h4><p>默认关闭；开启后，模型只在分场确实有助于连续性或长篇修订时使用。</p></div></div>
          <label className="writing-setting-row">
            <input type="checkbox" checked={sceneDraft.enabled} onChange={event => setSceneDraft(current => ({ ...current, enabled: event.target.checked }))}/>
            <span><strong>启用场景链</strong><small>关闭时正文直接成稿，不调用章节场景链工具。</small></span>
          </label>
          <div className="scene-settings-grid">
            <label className={sceneCountInvalid ? "field-invalid" : ""}><span>推荐场数</span><div className="scene-range-inputs"><input aria-label="推荐最少场数" aria-invalid={sceneCountInvalid} type="number" min="1" max="8" value={sceneDraft.preferredMinScenes} onChange={event => setSceneDraft(current => ({ ...current, preferredMinScenes: Number(event.target.value) }))}/><i>—</i><input aria-label="推荐最多场数" aria-invalid={sceneCountInvalid} type="number" min="1" max="8" value={sceneDraft.preferredMaxScenes} onChange={event => setSceneDraft(current => ({ ...current, preferredMaxScenes: Number(event.target.value) }))}/></div><small>建议范围，不为凑数拆场。</small></label>
            <label className={sceneCountInvalid ? "field-invalid" : ""}><span>场景硬上限</span><input aria-invalid={sceneCountInvalid} type="number" min="1" max="8" value={sceneDraft.maxScenes} onChange={event => setSceneDraft(current => ({ ...current, maxScenes: Number(event.target.value) }))}/><small>最多 8 场，且不能低于推荐值。</small></label>
            <label className={notesLimitInvalid ? "field-invalid" : ""}><span>每场 notes 上限</span><input aria-invalid={notesLimitInvalid} type="number" min="500" max="8000" step="100" value={sceneDraft.notesMaxCharacters} onChange={event => setSceneDraft(current => ({ ...current, notesMaxCharacters: Number(event.target.value) }))}/><small>500—8000 字，只保留约束本场的材料。</small></label>
          </div>
        </section>

        {writingMode === "delegated" ? <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>隔离正文生成</h4><p>控制分工模式下，正文是否由独立纯文本调用生成。</p></div></div>
          <label className="writing-setting-row">
            <input type="checkbox" checked={sceneDraft.isolatedWriter} onChange={event => setSceneDraft(current => ({ ...current, isolatedWriter: event.target.checked }))}/>
            <span><strong>启用隔离 Writer</strong><small>短篇可直接隔离成稿；长篇由 Agent 提交场景材料，Writer 写正文，轻量模型提取离场状态。</small></span>
          </label>
          <div className="scene-settings-grid compact">
            <label className={`${!sceneDraft.isolatedWriter ? "setting-disabled " : ""}${writerSettingsInvalid ? "field-invalid" : ""}`}><span>正文硬上限倍率</span><input aria-invalid={writerSettingsInvalid} disabled={!sceneDraft.isolatedWriter} type="number" min="1.2" max="3" step="0.1" value={sceneDraft.isolatedWriterMaxRatio} onChange={event => setSceneDraft(current => ({ ...current, isolatedWriterMaxRatio: Number(event.target.value) }))}/><small>相对目标篇幅；允许 1.2—3.0 倍。</small></label>
            <label className={writerSettingsInvalid ? "field-invalid" : ""}><span>候选稿数量</span><select aria-invalid={writerSettingsInvalid} value={sceneDraft.candidateCount} onChange={event => setSceneDraft(current => ({ ...current, candidateCount: Number(event.target.value) }))}><option value={1}>1 · 不生成候选</option><option value={2}>2 · 默认择优</option><option value={3}>3 · 更多比较</option></select><small>只在场景质量有提升空间时追加候选。</small></label>
          </div>
        </section> : <div className="writing-mode-notice"><strong>快速模式不使用正文 Writer</strong><span>当前沿用传统单 Agent 链路：检索、编排、直接提案和场景链正文全部由 Agent 完成。关闭 Agent 面板中的 Fast 后，隔离设置会重新出现。</span></div>}

        <div className={sceneDraftValid ? "scene-settings-summary" : "scene-settings-summary invalid"} role={sceneDraftValid ? "status" : "alert"}>{sceneDraftValid
          ? !sceneDraft.enabled
            ? `当前：场景链关闭；${writingMode === "fast" ? "快速模式开启" : "分工模式开启"}，正文直接成稿。步数：${stepBudgetModeDraft === "hard" ? `硬上限 ${maxAgentStepsDraft}` : `实验 soft（硬顶 ${maxAgentStepsDraft}）`}。`
            : writingMode === "fast"
            ? `当前：快速模式。全部写作步骤使用 Agent，不调用正文 Writer；场景链建议 ${sceneDraft.preferredMinScenes}—${sceneDraft.preferredMaxScenes} 场。步数：${stepBudgetModeDraft === "hard" ? `硬上限 ${maxAgentStepsDraft}` : `实验 soft（硬顶 ${maxAgentStepsDraft}）`}。`
            : `当前：分工模式${sceneDraft.isolatedWriter ? " + 隔离 Writer" : ""}。场景链建议 ${sceneDraft.preferredMinScenes}—${sceneDraft.preferredMaxScenes} 场，最多 ${sceneDraft.maxScenes} 场。步数：${stepBudgetModeDraft === "hard" ? `硬上限 ${maxAgentStepsDraft}` : `实验 soft（硬顶 ${maxAgentStepsDraft}）`}。`
          : "请检查默认章节字数、Agent 步数、场景数量、notes 上限、正文倍率与候选稿数量。"}</div>
        <div className="scene-settings-actions">
          <span>{writingSettingsDirty ? "有未保存的修改" : "所有修改均已保存"}</span>
          <button onClick={resetWritingSettings} disabled={busy || !writingSettingsDirty}>放弃修改</button>
          <button className="primary" onClick={() => void saveWritingSettings()} disabled={busy || !sceneDraftValid || !writingSettingsDirty}>{busy ? "保存中…" : "保存修改"}</button>
        </div>
          </div>}
          {section === "style" && styleContent}
          {section === "prose-gates" && proseGatesContent}
          {section === "continuity-facts" && continuityFactsContent}
          {section === "connection" && connectionContent}
          {section === "appearance" && appearanceContent}
        </main>
      </div>
    </section>
    {editing && <div className="modal-backdrop nested" onMouseDown={() => setEditing(null)}><section className="modal provider-editor" onMouseDown={event => event.stopPropagation()}>
      <div className="provider-editor-head"><div><span className="eyebrow">Provider</span><h2>{editing.id ? "编辑供应商" : "添加供应商"}</h2></div><button className="icon" title="关闭" aria-label="关闭" onClick={() => setEditing(null)}><X size={17} /></button></div>
      <div className="character-form-grid"><label><span>显示名称</span><input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}/></label><label><span>协议类型</span><select value={editing.provider} onChange={e => updateConnection({ provider: e.target.value as ProfileDraft["provider"] })}><option value="openai-compatible">OpenAI 兼容（Chat Completions）</option><option value="openai-responses">OpenAI Responses</option><option value="deepseek">DeepSeek</option></select></label><label className="wide"><span>API Base URL</span><input value={editing.baseUrl} onChange={e => updateConnection({ baseUrl: e.target.value })} placeholder={editing.provider === "openai-responses" ? "https://api.openai.com/v1" : undefined}/></label><label className="wide"><span>代理 URL（可选）</span><input placeholder="http://127.0.0.1:7890" value={editing.proxyUrl ?? ""} onChange={e => updateConnection({ proxyUrl: e.target.value })}/></label><label className="wide"><span>API Key（留空保留现有密钥）</span><input type="password" value={editing.apiKey} onChange={e => updateConnection({ apiKey: e.target.value })}/></label></div>
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
          const contextLabel = model.contextFromProvider
            ? formatContextWindowLabel(model.pricing.contextWindow)
            : "";
          return <label className={added ? "already-added" : ""} key={model.name}><input type="checkbox" disabled={added} checked={!added && selectedScannedModels.has(model.name)} onChange={event => setSelectedScannedModels(current => { const next = new Set(current); if (event.target.checked) next.add(model.name); else next.delete(model.name); return next; })}/><span title={contextLabel ? `${model.name} · 上下文 ${contextLabel}` : model.name}>{model.name}</span>{contextLabel && <small className="model-scan-context">{contextLabel}</small>}{added && <small>已添加</small>}</label>;
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
            <label><span>Temperature（0–2）</span><input type="number" min="0" max="2" step="0.05" placeholder="供应商默认" value={model.temperature ?? ""} disabled={model.disableSampling} onChange={e => updateModel(index, { temperature: optionalNumber(e.target.value) })}/></label>
            <label><span>Top P（0–1）</span><input type="number" min="0" max="1" step="0.01" placeholder="供应商默认" value={model.topP ?? ""} disabled={model.disableSampling} onChange={e => updateModel(index, { topP: optionalNumber(e.target.value) })}/></label>
            <label><span>Frequency penalty（-2–2）</span><input type="number" min="-2" max="2" step="0.1" placeholder="供应商默认" value={model.frequencyPenalty ?? ""} disabled={model.disableSampling} onChange={e => updateModel(index, { frequencyPenalty: optionalNumber(e.target.value) })}/></label>
            <label><span>Presence penalty（-2–2）</span><input type="number" min="-2" max="2" step="0.1" placeholder="供应商默认" value={model.presencePenalty ?? ""} disabled={model.disableSampling} onChange={e => updateModel(index, { presencePenalty: optionalNumber(e.target.value) })}/></label>
            {(editing.provider === "openai-compatible" || editing.provider === "openai-responses") && <>
              <label><span>Reasoning effort</span><select value={model.reasoningEffort ?? ""} onChange={e => updateModel(index, { reasoningEffort: (e.target.value || undefined) as ReasoningEffort | undefined })}><option value="">供应商默认</option><option value="none">none</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option></select></label>
              <label><span>Verbosity</span><select value={model.verbosity ?? ""} onChange={e => updateModel(index, { verbosity: (e.target.value || undefined) as ResponseVerbosity | undefined })}><option value="">供应商默认</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
            </>}
            <div className="sampling-setting">
              <div className="sampling-setting-copy">
                <strong>采样参数</strong>
                <small>控制 temperature、top_p 与惩罚项；reasoning_effort 和 verbosity 不受影响</small>
              </div>
              <div className="sampling-setting-control" role="group" aria-label="采样参数">
                <button type="button" className={!model.disableSampling ? "active" : ""} aria-pressed={!model.disableSampling} onClick={() => updateModel(index, { disableSampling: false })}>发送</button>
                <button type="button" className={model.disableSampling ? "active" : ""} aria-pressed={Boolean(model.disableSampling)} onClick={() => updateModel(index, { disableSampling: true })}>不发送</button>
              </div>
            </div>
            <div className="sampling-setting">
              <div className="sampling-setting-copy">
                <strong>多模态输入</strong>
                <small>开启后，写作 Agent 可把用户附图以 image_url 发给该模型（需供应商支持视觉）</small>
              </div>
              <div className="sampling-setting-control" role="group" aria-label="多模态输入">
                <button type="button" className={model.supportsMultimodal ? "active" : ""} aria-pressed={Boolean(model.supportsMultimodal)} onClick={() => updateModel(index, { supportsMultimodal: true })}>支持</button>
                <button type="button" className={!model.supportsMultimodal ? "active" : ""} aria-pressed={!model.supportsMultimodal} onClick={() => updateModel(index, { supportsMultimodal: false })}>仅文本</button>
              </div>
            </div>
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
