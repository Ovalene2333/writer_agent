import React, { useEffect, useMemo, useState } from "react";
import {
  Bot, CheckCircle2, LoaderCircle, type LucideIcon, MessageSquare, Palette, Pencil, Plus, Radar,
  ShieldCheck, WandSparkles, Wifi, X, XCircle,
} from "lucide-react";

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
export type ProviderProfile = {
  id: string;
  name: string;
  provider: "deepseek" | "openai-compatible" | "openai-responses";
  baseUrl: string;
  proxyUrl?: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  /** Max in-flight HTTP requests for this provider (default 5). */
  maxConcurrent?: number;
  /** Optional requests-per-minute cap. */
  maxRpm?: number;
  models: ProviderModel[];
};
export type ModelRole =
  | "agent"
  | "image"
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
  candidateCount: number;
};
export type ProseLengthSettings = {
  chapterTargetCharacters: number;
  mode: "bounded" | "guidance";
  enforceMinimum: boolean;
};
export type ChapterNamingPreset = "auto" | "cn-file-en" | "cn-file" | "cn-arabic" | "custom";
export type ChapterIndexStyle = "chinese" | "arabic" | "padded-arabic";
export type ChapterNamingSettings = {
  preset: ChapterNamingPreset;
  pathPattern: string;
  indexPadWidth: number;
  titlePattern: string;
  titleWithSubtitle: string;
  requireSubtitle: boolean;
  subtitleMaxLen: number;
  indexStyle: ChapterIndexStyle;
  enforceHeading: boolean;
};
export const DEFAULT_CHAPTER_NAMING: ChapterNamingSettings = {
  preset: "auto",
  pathPattern: "chapters/chapter-{indexPad}.md",
  indexPadWidth: 2,
  titlePattern: "第{indexCn}章",
  titleWithSubtitle: "第{indexCn}章 {subtitle}",
  requireSubtitle: false,
  subtitleMaxLen: 16,
  indexStyle: "chinese",
  enforceHeading: true,
};
export type WritingExecutionMode = "delegated" | "fast";
export type AgentStepBudgetMode = "hard" | "experimental";
export type RoleplayReasoningChoice = ReasoningEffort | "inherit";
export type RoleplayLengthLevelKey = "-2" | "-1" | "0" | "1" | "2";
export type RoleplayLengthBlockBudget = { minBlocks: number; maxBlocks: number };
export type RoleplayLengthBlockBudgets = Record<RoleplayLengthLevelKey, RoleplayLengthBlockBudget>;
export type RoleplaySettings = {
  performanceReasoningEffort: RoleplayReasoningChoice;
  jsonReasoningEffort: ReasoningEffort;
  qualityFinalizeEnabled: boolean;
  recentMessages: number;
  replyMaxOutputTokens: number;
  jsonMaxOutputTokens: number;
  lengthBlockBudgets: RoleplayLengthBlockBudgets;
};
export type SettingsSection = "models" | "writing" | "roleplay" | "style" | "prose-gates" | "connection" | "appearance";

/**
 * SETTINGS NAV CONTRACT
 * -------------------------------------------------------------------------
 * 设置入口有两处 UI，必须共用本清单，禁止各自 hardcode 标签/顺序：
 *   1. 展开设置页侧栏 `settings-tabs`（ModelConfigView）
 *   2. 顶栏齿轮下拉 `SettingsMenu`（ui_primitives.tsx）
 * 新增/改名/重排子项时只改 SETTINGS_NAV_ITEMS，并同步 sectionMeta 的文案。
 * connection 项在 dualMode 关闭时禁用；菜单分隔用 menuSeparatorBefore。
 */
export type SettingsNavItem = {
  id: SettingsSection;
  /** 侧栏与下拉共用的显示名 */
  label: string;
  /** 侧栏副标题（下拉不展示） */
  detail: string;
  Icon: LucideIcon;
  /** 下拉菜单在此项前插入分隔线（分组视觉） */
  menuSeparatorBefore?: boolean;
  /** 仅双通道时可选：连接设置 */
  requiresDualConnection?: boolean;
};

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  { id: "models", label: "模型与分工", detail: "供应商、模型和流程角色", Icon: Bot },
  { id: "writing", label: "写作行为", detail: "角色演进与场景生成", Icon: Pencil },
  { id: "roleplay", label: "角色扮演", detail: "推理档位、终审与预算", Icon: MessageSquare },
  { id: "style", label: "写作风格", detail: "模板、范文与采样建议", Icon: WandSparkles },
  { id: "prose-gates", label: "作者复审规则", detail: "语义门禁与长期偏好", Icon: ShieldCheck, menuSeparatorBefore: true },
  {
    id: "connection",
    label: "连接设置",
    detail: "局域网与公网通道",
    Icon: Wifi,
    menuSeparatorBefore: true,
    requiresDualConnection: true,
  },
  { id: "appearance", label: "外观与动效", detail: "主题、动画与性能模式", Icon: Palette },
] as const;

export const ROLEPLAY_LENGTH_LEVEL_KEYS: RoleplayLengthLevelKey[] = ["-2", "-1", "0", "1", "2"];
export const ROLEPLAY_LENGTH_LEVEL_LABELS: Record<RoleplayLengthLevelKey, string> = {
  "-2": "极简",
  "-1": "精简",
  "0": "适中",
  "1": "充分",
  "2": "展开",
};
export const DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS: RoleplayLengthBlockBudgets = {
  "-2": { minBlocks: 1, maxBlocks: 1 },
  "-1": { minBlocks: 2, maxBlocks: 2 },
  "0": { minBlocks: 2, maxBlocks: 3 },
  "1": { minBlocks: 3, maxBlocks: 4 },
  "2": { minBlocks: 4, maxBlocks: 5 },
};
export const DEFAULT_ROLEPLAY_SETTINGS: RoleplaySettings = {
  performanceReasoningEffort: "inherit",
  jsonReasoningEffort: "none",
  qualityFinalizeEnabled: true,
  recentMessages: 8,
  replyMaxOutputTokens: 8_000,
  jsonMaxOutputTokens: 8_000,
  lengthBlockBudgets: { ...DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS },
};

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
  { id: "image", name: "图片生成", detail: "生成封面、插图与视觉参考；OpenAI 可分配 gpt-image-2" },
];

const ROLEPLAY_ROLES: RoleDefinition[] = [
  { id: "roleplay", name: "角色演出", detail: "角色试演、主动开场、续演、身份代答与场景生成" },
  { id: "roleplay_perception", name: "感知编译", detail: "把玩家输入整理为角色本轮能够听见、看见与感受到的信息" },
  { id: "roleplay_quality", name: "演出终审", detail: "清理越权、解释腔与重复内容，输出最终角色回复" },
  { id: "roleplay_memory", name: "现场记忆", detail: "维护角色可知的滚动摘要、现场状态与长期事实" },
];

const EMPTY_PRICING: Pricing = { cacheHit: 0, cacheMiss: 0, output: 0, currency: "CNY", contextWindow: 128000 };
const newModel = (): ModelDraft => ({ name: "", pricing: { ...EMPTY_PRICING } });
const emptyProfile = (): ProfileDraft => ({
  name: "",
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  proxyUrl: "",
  apiKey: "",
  maxConcurrent: 5,
  maxRpm: undefined,
  models: [newModel()],
});
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
  chapterNaming: ChapterNamingSettings;
  proseGateTimeouts: { primarySeconds: number; finalSeconds: number };
  roleplay: RoleplaySettings;
  writingMode: WritingExecutionMode;
  characterEvolutionEnabled: boolean;
  reviewFollowsProseModel: boolean;
  stepBudgetMode: AgentStepBudgetMode;
  maxAgentSteps: number;
  section: SettingsSection;
  styleContent: React.ReactNode;
  proseGatesContent: React.ReactNode;
  connectionContent: React.ReactNode;
  appearanceContent: React.ReactNode;
  connectionAvailable: boolean;
  request: Request;
  onClose: () => void;
  onSectionChanged: (section: SettingsSection) => void;
  onChanged: () => void | Promise<void>;
  onScenePipelineChanged: (settings: ScenePipelineSettings) => void;
  onProseLengthChanged: (settings: ProseLengthSettings) => void;
  onChapterNamingChanged: (settings: ChapterNamingSettings) => void;
  onProseGateTimeoutsChanged: (settings: { primarySeconds: number; finalSeconds: number }) => void;
  onRoleplayChanged: (settings: RoleplaySettings) => void;
  onCharacterEvolutionChanged: (enabled: boolean) => void;
  onReviewFollowsProseModelChanged: (enabled: boolean) => void;
  onStepBudgetChanged: (settings: { stepBudgetMode: AgentStepBudgetMode; maxAgentSteps: number }) => void;
};

export function ModelConfig({
  initialCatalog,
  scenePipeline,
  proseLength,
  chapterNaming,
  proseGateTimeouts,
  roleplay,
  writingMode,
  characterEvolutionEnabled,
  reviewFollowsProseModel,
  stepBudgetMode,
  maxAgentSteps,
  section,
  styleContent,
  proseGatesContent,
  connectionContent,
  appearanceContent,
  connectionAvailable,
  request,
  onClose,
  onSectionChanged,
  onChanged,
  onScenePipelineChanged,
  onProseLengthChanged,
  onChapterNamingChanged,
  onProseGateTimeoutsChanged,
  onRoleplayChanged,
  onCharacterEvolutionChanged,
  onReviewFollowsProseModelChanged,
  onStepBudgetChanged,
}: ModelConfigProps) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [sceneDraft, setSceneDraft] = useState(scenePipeline);
  const [lengthDraft, setLengthDraft] = useState(proseLength);
  const [namingDraft, setNamingDraft] = useState(chapterNaming);
  const [proseGateTimeoutsDraft, setProseGateTimeoutsDraft] = useState(proseGateTimeouts);
  const [roleplayDraft, setRoleplayDraft] = useState(roleplay);
  const [characterEvolutionDraft, setCharacterEvolutionDraft] = useState(characterEvolutionEnabled);
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
  useEffect(() => setNamingDraft(chapterNaming), [chapterNaming]);
  useEffect(() => setProseGateTimeoutsDraft(proseGateTimeouts), [proseGateTimeouts]);
  useEffect(() => setRoleplayDraft({
    ...DEFAULT_ROLEPLAY_SETTINGS,
    ...roleplay,
    lengthBlockBudgets: {
      ...DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS,
      ...roleplay?.lengthBlockBudgets,
    },
  }), [roleplay]);
  useEffect(() => setCharacterEvolutionDraft(characterEvolutionEnabled), [characterEvolutionEnabled]);
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
  const lengthBudgetsInvalid = ROLEPLAY_LENGTH_LEVEL_KEYS.some((level) => {
    const budget = roleplayDraft.lengthBlockBudgets?.[level] ?? DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS[level];
    return !Number.isInteger(budget.minBlocks)
      || !Number.isInteger(budget.maxBlocks)
      || budget.minBlocks < 1
      || budget.maxBlocks > 8
      || budget.maxBlocks < budget.minBlocks;
  });
  const roleplayDraftInvalid = !Number.isInteger(roleplayDraft.recentMessages)
    || roleplayDraft.recentMessages < 4
    || roleplayDraft.recentMessages > 24
    || !Number.isInteger(roleplayDraft.replyMaxOutputTokens)
    || roleplayDraft.replyMaxOutputTokens < 1_000
    || roleplayDraft.replyMaxOutputTokens > 16_000
    || !Number.isInteger(roleplayDraft.jsonMaxOutputTokens)
    || roleplayDraft.jsonMaxOutputTokens < 1_000
    || roleplayDraft.jsonMaxOutputTokens > 16_000
    || lengthBudgetsInvalid;
  const roleplaySettingsDirty = roleplayDraft.performanceReasoningEffort !== roleplay.performanceReasoningEffort
    || roleplayDraft.jsonReasoningEffort !== roleplay.jsonReasoningEffort
    || roleplayDraft.qualityFinalizeEnabled !== roleplay.qualityFinalizeEnabled
    || roleplayDraft.recentMessages !== roleplay.recentMessages
    || roleplayDraft.replyMaxOutputTokens !== roleplay.replyMaxOutputTokens
    || roleplayDraft.jsonMaxOutputTokens !== roleplay.jsonMaxOutputTokens
    || ROLEPLAY_LENGTH_LEVEL_KEYS.some((level) => {
      const draft = roleplayDraft.lengthBlockBudgets?.[level];
      const saved = roleplay.lengthBlockBudgets?.[level] ?? DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS[level];
      return !draft
        || draft.minBlocks !== saved.minBlocks
        || draft.maxBlocks !== saved.maxBlocks;
    });
  const writingSettingsDirty = characterEvolutionDraft !== characterEvolutionEnabled
    || lengthDraft.chapterTargetCharacters !== proseLength.chapterTargetCharacters
    || lengthDraft.mode !== proseLength.mode
    || lengthDraft.enforceMinimum !== proseLength.enforceMinimum
    || namingDraft.preset !== chapterNaming.preset
    || namingDraft.pathPattern !== chapterNaming.pathPattern
    || namingDraft.indexPadWidth !== chapterNaming.indexPadWidth
    || namingDraft.titlePattern !== chapterNaming.titlePattern
    || namingDraft.titleWithSubtitle !== chapterNaming.titleWithSubtitle
    || namingDraft.requireSubtitle !== chapterNaming.requireSubtitle
    || namingDraft.subtitleMaxLen !== chapterNaming.subtitleMaxLen
    || namingDraft.indexStyle !== chapterNaming.indexStyle
    || namingDraft.enforceHeading !== chapterNaming.enforceHeading
    || proseGateTimeoutsDraft.primarySeconds !== proseGateTimeouts.primarySeconds
    || proseGateTimeoutsDraft.finalSeconds !== proseGateTimeouts.finalSeconds
    || reviewFollowsProseDraft !== reviewFollowsProseModel
    || stepBudgetModeDraft !== stepBudgetMode
    || maxAgentStepsDraft !== maxAgentSteps
    || Object.keys(sceneDraft).some(key => sceneDraft[key as keyof ScenePipelineSettings] !== scenePipeline[key as keyof ScenePipelineSettings]);
  const namingDraftInvalid = !Number.isInteger(namingDraft.indexPadWidth)
    || namingDraft.indexPadWidth < 1
    || namingDraft.indexPadWidth > 4
    || !Number.isInteger(namingDraft.subtitleMaxLen)
    || namingDraft.subtitleMaxLen < 4
    || namingDraft.subtitleMaxLen > 40
    || (namingDraft.preset === "custom" && !namingDraft.pathPattern.trim())
    || (namingDraft.preset === "custom" && !namingDraft.titlePattern.trim());
  const sceneDraftValid = !lengthDraftInvalid && !namingDraftInvalid && !stepsDraftInvalid && [sceneDraft.preferredMinScenes, sceneDraft.preferredMaxScenes, sceneDraft.maxScenes]
    .every(value => Number.isInteger(value) && value >= 1 && value <= 8)
    && sceneDraft.preferredMinScenes <= sceneDraft.preferredMaxScenes
    && sceneDraft.preferredMaxScenes <= sceneDraft.maxScenes
    && Number.isInteger(sceneDraft.notesMaxCharacters)
    && sceneDraft.notesMaxCharacters >= 500
    && sceneDraft.notesMaxCharacters <= 8_000
    && Number.isInteger(sceneDraft.candidateCount)
    && sceneDraft.candidateCount >= 1
    && sceneDraft.candidateCount <= 3;
  const proseGateTimeoutsInvalid = !Number.isInteger(proseGateTimeoutsDraft.primarySeconds)
    || !Number.isInteger(proseGateTimeoutsDraft.finalSeconds)
    || proseGateTimeoutsDraft.primarySeconds < 10 || proseGateTimeoutsDraft.primarySeconds > 900
    || proseGateTimeoutsDraft.finalSeconds < 10 || proseGateTimeoutsDraft.finalSeconds > 900
    || proseGateTimeoutsDraft.finalSeconds < proseGateTimeoutsDraft.primarySeconds;
  const sceneCountInvalid = ![sceneDraft.preferredMinScenes, sceneDraft.preferredMaxScenes, sceneDraft.maxScenes]
    .every(value => Number.isInteger(value) && value >= 1 && value <= 8)
    || sceneDraft.preferredMinScenes > sceneDraft.preferredMaxScenes
    || sceneDraft.preferredMaxScenes > sceneDraft.maxScenes;
  const notesLimitInvalid = !Number.isInteger(sceneDraft.notesMaxCharacters)
    || sceneDraft.notesMaxCharacters < 500
    || sceneDraft.notesMaxCharacters > 8_000;
  const writerSettingsInvalid = !Number.isInteger(sceneDraft.candidateCount)
    || sceneDraft.candidateCount < 1
    || sceneDraft.candidateCount > 3;
  const choices = useMemo(() => catalog.providers.flatMap(provider => provider.models.map(model => ({ value: `${provider.id}:${model.id}`, label: `${provider.name} / ${model.name}` }))), [catalog]);
  const resetScan = () => { setScannedModels([]); setSelectedScannedModels(new Set()); setEditorFeedback(null); };
  const addProfile = () => { resetScan(); setEditing(emptyProfile()); };
  const editProfile = (profile: ProviderProfile) => {
    resetScan();
    setEditing({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      proxyUrl: profile.proxyUrl ?? "",
      apiKey: "",
      maxConcurrent: profile.maxConcurrent ?? 5,
      maxRpm: profile.maxRpm,
      models: profile.models.map(model => ({ ...model, pricing: { ...model.pricing } })),
    });
  };
  const updateConnection = (change: Partial<Pick<ProfileDraft, "provider" | "baseUrl" | "proxyUrl" | "apiKey" | "maxConcurrent" | "maxRpm">>) => {
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
      const result = await request("/api/providers", {
        method: "PUT",
        body: JSON.stringify({
          ...editing,
          apiKey: editing.apiKey || undefined,
          // Always send so clearing the field removes a previously saved cap.
          maxRpm: editing.maxRpm ?? null,
        }),
      });
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
          chapterNaming: namingDraft,
          proseGateTimeouts: proseGateTimeoutsDraft,
          characterEvolutionEnabled: characterEvolutionDraft,
          reviewFollowsProseModel: reviewFollowsProseDraft,
          stepBudgetMode: stepBudgetModeDraft,
          maxAgentSteps: maxAgentStepsDraft,
        }),
      }) as {
        scenePipeline: ScenePipelineSettings;
        proseLength: ProseLengthSettings;
        chapterNaming: ChapterNamingSettings;
        proseGateTimeouts: { primarySeconds: number; finalSeconds: number };
        characterEvolutionEnabled: boolean;
        reviewFollowsProseModel: boolean;
        stepBudgetMode: AgentStepBudgetMode;
        maxAgentSteps: number;
      };
      setSceneDraft(result.scenePipeline);
      setLengthDraft(result.proseLength);
      setNamingDraft(result.chapterNaming);
      setProseGateTimeoutsDraft(result.proseGateTimeouts);
      setCharacterEvolutionDraft(result.characterEvolutionEnabled);
      setReviewFollowsProseDraft(result.reviewFollowsProseModel);
      setStepBudgetModeDraft(result.stepBudgetMode);
      setMaxAgentStepsDraft(result.maxAgentSteps);
      onScenePipelineChanged(result.scenePipeline);
      onProseLengthChanged(result.proseLength);
      onChapterNamingChanged(result.chapterNaming);
      onProseGateTimeoutsChanged(result.proseGateTimeouts);
      onCharacterEvolutionChanged(result.characterEvolutionEnabled);
      onReviewFollowsProseModelChanged(result.reviewFollowsProseModel);
      onStepBudgetChanged({ stepBudgetMode: result.stepBudgetMode, maxAgentSteps: result.maxAgentSteps });
      setMessage("写作设置已保存，将从下一次 Agent 任务开始生效（已打开的会话仍沿用会话内锁定的章节命名）");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function resetWritingSettings() {
    setSceneDraft(scenePipeline);
    setLengthDraft(proseLength);
    setNamingDraft(chapterNaming);
    setProseGateTimeoutsDraft(proseGateTimeouts);
    setCharacterEvolutionDraft(characterEvolutionEnabled);
    setReviewFollowsProseDraft(reviewFollowsProseModel);
    setStepBudgetModeDraft(stepBudgetMode);
    setMaxAgentStepsDraft(maxAgentSteps);
    setError("");
    setMessage("");
  }

  async function saveRoleplaySettings() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/agent-settings", {
        method: "POST",
        body: JSON.stringify({ roleplay: roleplayDraft }),
      }) as { roleplay: RoleplaySettings };
      setRoleplayDraft(result.roleplay);
      onRoleplayChanged(result.roleplay);
      setMessage("角色扮演设置已保存，将从下一轮试演开始生效");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function resetRoleplaySettings() {
    setRoleplayDraft(roleplay);
    setError("");
    setMessage("");
  }

  function closeSettings() {
    if (writingSettingsDirty && !confirm("写作设置尚未保存，确定要放弃这些修改并返回工作区吗？")) return;
    if (roleplaySettingsDirty && !confirm("角色扮演设置尚未保存，确定要放弃这些修改并返回工作区吗？")) return;
    onClose();
  }

  function selectSection(nextSection: SettingsSection) {
    if (section === "writing" && nextSection !== "writing" && writingSettingsDirty
      && !confirm("写作设置尚未保存，确定要放弃这些修改并切换分类吗？")) return;
    if (section === "writing" && nextSection !== "writing") resetWritingSettings();
    if (section === "roleplay" && nextSection !== "roleplay" && roleplaySettingsDirty
      && !confirm("角色扮演设置尚未保存，确定要放弃这些修改并切换分类吗？")) return;
    if (section === "roleplay" && nextSection !== "roleplay") resetRoleplaySettings();
    onSectionChanged(nextSection);
    setError("");
    setMessage("");
  }

  // 内容页头文案：title 应与 SETTINGS_NAV_ITEMS[].label 一致；改导航时同步改这里
  const sectionMeta: Record<SettingsSection, { eyebrow: string; title: string; description: string }> = {
    models: { eyebrow: "Model routing", title: "模型与分工", description: "管理模型连接，并为写作流程的不同环节分配模型。" },
    writing: { eyebrow: "Writing behavior", title: "写作行为", description: "调整角色演进、可选场景链与正文生成策略。" },
    roleplay: { eyebrow: "Roleplay", title: "角色扮演", description: "调整试演推理档位、终审与输出预算。模型分配仍在「模型与分工」。" },
    style: { eyebrow: "Writing style", title: "写作风格", description: "管理写作模板、范文与采样建议。" },
    "prose-gates": { eyebrow: "Author policies", title: "作者复审规则", description: "管理长期写作要求、试运行和门禁。" },
    connection: { eyebrow: "Network", title: "连接设置", description: "查看当前通道并调整局域网与公网偏好。" },
    appearance: { eyebrow: "Appearance", title: "外观与动效", description: "选择工作区主题，并按设备性能控制全局动态效果。" },
  };
  const activeMeta = sectionMeta[section];

  return <div className="model-config-backdrop management-page">
    <section className="model-config-view">
      <div className="management-head settings-page-head"><div><span className="eyebrow">Settings</span><h2>设置</h2></div><button className="icon" title="返回工作区" aria-label="返回工作区" onClick={closeSettings}><X size={17} /></button></div>
      <div className="settings-layout">
        {/* 侧栏项来自 SETTINGS_NAV_ITEMS，与顶栏 SettingsMenu 共用清单 */}
        <nav className="settings-tabs" aria-label="设置分类">
          {SETTINGS_NAV_ITEMS.map((item) => {
            const Icon = item.Icon;
            const active = section === item.id;
            const disabled = Boolean(item.requiresDualConnection && !connectionAvailable);
            const detail = item.id === "connection" && !connectionAvailable
              ? "当前仅有单一通道"
              : item.detail;
            const dirty = item.id === "writing"
              ? writingSettingsDirty
              : item.id === "roleplay"
                ? roleplaySettingsDirty
                : false;
            return (
              <button
                key={item.id}
                type="button"
                className={active ? "active" : ""}
                aria-current={active ? "page" : undefined}
                disabled={disabled}
                onClick={() => selectSection(item.id)}
              >
                <Icon size={17} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{detail}</small>
                </span>
                {dirty && <i className="settings-dirty-dot" title="有未保存的修改" />}
              </button>
            );
          })}
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
              <div><strong>{provider.name}</strong><span>{provider.provider === "deepseek" ? "DeepSeek" : provider.provider === "openai-responses" ? "OpenAI Responses" : "OpenAI 兼容"} · 并发 {provider.maxConcurrent ?? 5}{provider.maxRpm ? ` · RPM ${provider.maxRpm}` : ""} · {provider.apiKeyConfigured ? provider.apiKeyHint : "未配置密钥"}</span></div>
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
            <input type="checkbox" checked={reviewFollowsProseDraft} onChange={event => setReviewFollowsProseDraft(event.target.checked)}/>
            <span><strong>终审跟随正文模型</strong><small>整章终审与候选评判使用「正文写作」的模型。判「像不像人写的」靠语感，用更便宜的模型评它自己写不出来的文字，只会把标准降到它的水平。关闭后改用「审阅校对」角色的模型。</small></span>
          </label>
          <div className="scene-settings-grid compact">
            <label className={proseGateTimeoutsInvalid ? "field-invalid" : ""}><span>首选审核超时（秒）</span><input type="number" min="10" max="900" step="1" value={proseGateTimeoutsDraft.primarySeconds} onChange={event => setProseGateTimeoutsDraft(current => ({ ...current, primarySeconds: Number(event.target.value) }))}/><small>有独立回退模型时先使用此预算。</small></label>
            <label className={proseGateTimeoutsInvalid ? "field-invalid" : ""}><span>最终审核超时（秒）</span><input type="number" min="10" max="900" step="1" value={proseGateTimeoutsDraft.finalSeconds} onChange={event => setProseGateTimeoutsDraft(current => ({ ...current, finalSeconds: Number(event.target.value) }))}/><small>唯一或最后一个审核模型使用，不能低于首选值。</small></label>
          </div>
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
            <label><span>篇幅控制</span><select value={lengthDraft.mode} onChange={event => setLengthDraft(current => ({ ...current, mode: event.target.value as ProseLengthSettings["mode"] }))}><option value="bounded">范围验收（当前）</option><option value="guidance">弱引导</option></select><small>{lengthDraft.mode === "guidance" ? "只作参考，不因偏短或偏长触发重写。" : "按目标范围验收；上限硬拦，下限可单独设置。"}</small></label>
          </div>
          <label className={`writing-setting-row${lengthDraft.mode === "guidance" ? " setting-disabled" : ""}`}>
            <input type="checkbox" disabled={lengthDraft.mode === "guidance"} checked={lengthDraft.enforceMinimum} onChange={event => setLengthDraft(current => ({ ...current, enforceMinimum: event.target.checked }))}/>
            <span><strong>字数不足时拦截交付</strong><small>{lengthDraft.mode === "guidance" ? "弱引导模式不执行此项；切回范围验收后继续沿用当前选择。" : "默认关闭：偏短只在质量卡上提示，正文照常提交，需要更长直接说一句就行。打开后不达下限会要求重写。超出上限会被拦。"}</small></span>
          </label>
        </section>

        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>章节命名</h4><p>统一文件路径与文内 H1。同一会话首次写章时锁定约定，中途改设置只影响新会话。</p></div></div>
          <div className="scene-settings-grid compact">
            <label>
              <span>预设</span>
              <select
                value={namingDraft.preset}
                onChange={event => {
                  const preset = event.target.value as ChapterNamingPreset;
                  if (preset === "auto") {
                    setNamingDraft(current => ({ ...current, preset }));
                    return;
                  }
                  if (preset === "custom") {
                    setNamingDraft(current => ({ ...current, preset }));
                    return;
                  }
                  const table: Record<Exclude<ChapterNamingPreset, "auto" | "custom">, Omit<ChapterNamingSettings, "preset">> = {
                    "cn-file-en": {
                      pathPattern: "chapters/chapter-{indexPad}.md",
                      indexPadWidth: 2,
                      titlePattern: "第{indexCn}章",
                      titleWithSubtitle: "第{indexCn}章 {subtitle}",
                      requireSubtitle: false,
                      subtitleMaxLen: 16,
                      indexStyle: "chinese",
                      enforceHeading: true,
                    },
                    "cn-file": {
                      pathPattern: "chapters/第{indexPad}章.md",
                      indexPadWidth: 2,
                      titlePattern: "第{indexCn}章",
                      titleWithSubtitle: "第{indexCn}章 {subtitle}",
                      requireSubtitle: false,
                      subtitleMaxLen: 16,
                      indexStyle: "chinese",
                      enforceHeading: true,
                    },
                    "cn-arabic": {
                      pathPattern: "chapters/chapter-{indexPad}.md",
                      indexPadWidth: 2,
                      titlePattern: "第{index}章",
                      titleWithSubtitle: "第{index}章 {subtitle}",
                      requireSubtitle: false,
                      subtitleMaxLen: 16,
                      indexStyle: "arabic",
                      enforceHeading: true,
                    },
                  };
                  setNamingDraft({ preset, ...table[preset] });
                }}
              >
                <option value="auto">自动（按已有章节推断）</option>
                <option value="cn-file-en">chapter-02.md + 第二章</option>
                <option value="cn-file">第02章.md + 第二章</option>
                <option value="cn-arabic">chapter-02.md + 第2章</option>
                <option value="custom">自定义模板</option>
              </select>
              <small>推荐 jn3 类项目用「chapter-02.md + 第二章」。</small>
            </label>
            <label className={namingDraftInvalid ? "field-invalid" : ""}>
              <span>序号补零位数</span>
              <input
                type="number"
                min={1}
                max={4}
                step={1}
                value={namingDraft.indexPadWidth}
                disabled={namingDraft.preset !== "auto" && namingDraft.preset !== "custom"}
                onChange={event => setNamingDraft(current => ({ ...current, indexPadWidth: Number(event.target.value) }))}
              />
              <small>路径里 {"{indexPad}"} 的宽度，1—4。</small>
            </label>
          </div>
          {(namingDraft.preset === "custom" || namingDraft.preset === "auto") && (
            <div className="scene-settings-grid">
              <label className={namingDraftInvalid ? "field-invalid" : ""}>
                <span>路径模板</span>
                <input
                  value={namingDraft.pathPattern}
                  onChange={event => setNamingDraft(current => ({ ...current, preset: current.preset === "auto" ? "custom" : current.preset, pathPattern: event.target.value }))}
                  placeholder="chapters/chapter-{indexPad}.md"
                />
                <small>可用 {"{index}"} {"{indexPad}"} {"{indexCn}"} {"{subtitleSlug}"}</small>
              </label>
              <label>
                <span>标题模板</span>
                <input
                  value={namingDraft.titlePattern}
                  onChange={event => setNamingDraft(current => ({ ...current, preset: current.preset === "auto" ? "custom" : current.preset, titlePattern: event.target.value }))}
                  placeholder="第{indexCn}章"
                />
                <small>无副标题时的 H1。</small>
              </label>
              <label>
                <span>带副标题模板</span>
                <input
                  value={namingDraft.titleWithSubtitle}
                  onChange={event => setNamingDraft(current => ({ ...current, preset: current.preset === "auto" ? "custom" : current.preset, titleWithSubtitle: event.target.value }))}
                  placeholder="第{indexCn}章 {subtitle}"
                />
                <small>例：第四章 余波</small>
              </label>
            </div>
          )}
          <label className="writing-setting-row">
            <input type="checkbox" checked={namingDraft.requireSubtitle} onChange={event => setNamingDraft(current => ({ ...current, requireSubtitle: event.target.checked }))}/>
            <span><strong>要求副标题</strong><small>新建/Agent 交付时标题优先使用「序号 + 副标题」形态（Agent 仍需自行提供副标题）。</small></span>
          </label>
          <label className="writing-setting-row">
            <input type="checkbox" checked={namingDraft.enforceHeading} onChange={event => setNamingDraft(current => ({ ...current, enforceHeading: event.target.checked }))}/>
            <span><strong>写入时校正文件名型 H1</strong><small>把 <code># chapter-02</code> 之类改成规范标题（如「第二章」）；已有文学标题不改。</small></span>
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

        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>场景候选</h4><p>只在场景质量有提升空间时，生成事实不变的候选稿并择优。</p></div></div>
          <div className="scene-settings-grid compact">
            <label className={writerSettingsInvalid ? "field-invalid" : ""}><span>候选稿数量</span><select aria-invalid={writerSettingsInvalid} value={sceneDraft.candidateCount} onChange={event => setSceneDraft(current => ({ ...current, candidateCount: Number(event.target.value) }))}><option value={1}>1 · 不生成候选</option><option value={2}>2 · 默认择优</option><option value={3}>3 · 更多比较</option></select><small>分工模式优先保持共享事实包，不再对证据型 Writer 的正文做无证据候选改写。</small></label>
          </div>
        </section>

        <div className={sceneDraftValid && !proseGateTimeoutsInvalid ? "scene-settings-summary" : "scene-settings-summary invalid"} role={sceneDraftValid && !proseGateTimeoutsInvalid ? "status" : "alert"}>{sceneDraftValid && !proseGateTimeoutsInvalid
          ? !sceneDraft.enabled
            ? `当前：场景链关闭；${writingMode === "fast" ? "快速模式由 Agent 直接成稿" : "分工模式由 Agent 取证、证据型 Writer 成稿"}。命名：${namingDraft.preset}。步数：${stepBudgetModeDraft === "hard" ? `硬上限 ${maxAgentStepsDraft}` : `实验 soft（硬顶 ${maxAgentStepsDraft}）`}。`
            : `当前：${writingMode === "fast" ? "快速模式由 Agent 提交正文与状态" : "分工模式由证据型 Writer 生成正文、运行时提取状态"}。场景链建议 ${sceneDraft.preferredMinScenes}—${sceneDraft.preferredMaxScenes} 场，最多 ${sceneDraft.maxScenes} 场。命名：${namingDraft.preset}。步数：${stepBudgetModeDraft === "hard" ? `硬上限 ${maxAgentStepsDraft}` : `实验 soft（硬顶 ${maxAgentStepsDraft}）`}。`
          : "请检查默认章节字数、章节命名、Agent 步数、场景数量、notes 上限、候选稿数量与审核超时。"}</div>
        <div className="scene-settings-actions">
          <span>{writingSettingsDirty ? "有未保存的修改" : "所有修改均已保存"}</span>
          <button onClick={resetWritingSettings} disabled={busy || !writingSettingsDirty}>放弃修改</button>
          <button className="primary" onClick={() => void saveWritingSettings()} disabled={busy || !sceneDraftValid || proseGateTimeoutsInvalid || !writingSettingsDirty}>{busy ? "保存中…" : "保存修改"}</button>
        </div>
          </div>}
          {section === "roleplay" && <div className="scene-settings">
        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>推理档位</h4><p>控制演出与辅助 JSON 调用的 reasoning 强度。OpenAI 兼容走 reasoning_effort；DeepSeek 供应商映射为 thinking。</p></div></div>
          <div className="scene-settings-grid compact">
            <label>
              <span>演出推理</span>
              <select
                value={roleplayDraft.performanceReasoningEffort}
                onChange={event => setRoleplayDraft(current => ({
                  ...current,
                  performanceReasoningEffort: event.target.value as RoleplayReasoningChoice,
                }))}
              >
                <option value="inherit">跟随模型配置</option>
                <option value="none">none · 关闭</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
              <small>角色流式演出用。默认跟随「角色演出」模型上的 Reasoning effort。</small>
            </label>
            <label>
              <span>JSON 辅助推理</span>
              <select
                value={roleplayDraft.jsonReasoningEffort}
                onChange={event => setRoleplayDraft(current => ({
                  ...current,
                  jsonReasoningEffort: event.target.value as ReasoningEffort,
                }))}
              >
                <option value="none">none · 关闭（推荐）</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
              <small>感知编译、演出终审、现场记忆等短 JSON 调用。默认 none，避免把预算花在 thinking。</small>
            </label>
          </div>
        </section>

        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>终审与上下文</h4><p>演出后是否再跑终审剪辑，以及提示词里保留多少近期对白。</p></div></div>
          <label className="writing-setting-row">
            <input
              type="checkbox"
              checked={roleplayDraft.qualityFinalizeEnabled}
              onChange={event => setRoleplayDraft(current => ({
                ...current,
                qualityFinalizeEnabled: event.target.checked,
              }))}
            />
            <span>
              <strong>启用演出终审</strong>
              <small>关闭后直接渲染主模型 wire 输出，省一次模型调用；开启时由「演出终审」角色清理越权与解释腔。</small>
            </span>
          </label>
          <div className="scene-settings-grid compact">
            <label className={roleplayDraftInvalid ? "field-invalid" : ""}>
              <span>近期消息窗口</span>
              <input
                aria-invalid={roleplayDraftInvalid}
                type="number"
                min={4}
                max={24}
                step={1}
                value={roleplayDraft.recentMessages}
                onChange={event => setRoleplayDraft(current => ({
                  ...current,
                  recentMessages: Number(event.target.value),
                }))}
              />
              <small>4—24 条完整 user/assistant 消息进入提示与反模板统计。</small>
            </label>
          </div>
        </section>

        <section className="writing-settings-section">
          <div className="writing-settings-section-head"><div><h4>输出预算</h4><p>限制单次调用 max_tokens。推理 token 会计入此上限（尤其 OpenAI 兼容网关）。</p></div></div>
          <div className="scene-settings-grid compact">
            <label className={roleplayDraftInvalid ? "field-invalid" : ""}>
              <span>演出 max tokens</span>
              <input
                aria-invalid={roleplayDraftInvalid}
                type="number"
                min={1000}
                max={16000}
                step={500}
                value={roleplayDraft.replyMaxOutputTokens}
                onChange={event => setRoleplayDraft(current => ({
                  ...current,
                  replyMaxOutputTokens: Number(event.target.value),
                }))}
              />
              <small>1000—16000；含推理时请留足纯输出余量。</small>
            </label>
            <label className={roleplayDraftInvalid ? "field-invalid" : ""}>
              <span>JSON max tokens</span>
              <input
                aria-invalid={roleplayDraftInvalid}
                type="number"
                min={1000}
                max={16000}
                step={500}
                value={roleplayDraft.jsonMaxOutputTokens}
                onChange={event => setRoleplayDraft(current => ({
                  ...current,
                  jsonMaxOutputTokens: Number(event.target.value),
                }))}
              />
              <small>感知 / 终审 / 记忆等 JSON 调用共用。</small>
            </label>
          </div>
        </section>

        <section className="writing-settings-section">
          <div className="writing-settings-section-head">
            <div>
              <h4>篇幅档块数</h4>
              <p>对应试演面板「篇幅」滑杆五档（极简→展开）。每档设置最少/最多演出块；字数建议区间仍用内置默认。</p>
            </div>
          </div>
          <div className="roleplay-length-budget-list">
            {ROLEPLAY_LENGTH_LEVEL_KEYS.map((level) => {
              const budget = roleplayDraft.lengthBlockBudgets?.[level] ?? DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS[level];
              const invalid = !Number.isInteger(budget.minBlocks)
                || !Number.isInteger(budget.maxBlocks)
                || budget.minBlocks < 1
                || budget.maxBlocks > 8
                || budget.maxBlocks < budget.minBlocks;
              return (
                <div className={`roleplay-length-budget-row${invalid ? " field-invalid" : ""}`} key={level}>
                  <strong>{ROLEPLAY_LENGTH_LEVEL_LABELS[level]}</strong>
                  <span className="roleplay-length-budget-level">档位 {level}</span>
                  <label>
                    <span>最少块</span>
                    <input
                      aria-invalid={invalid}
                      type="number"
                      min={1}
                      max={8}
                      step={1}
                      value={budget.minBlocks}
                      onChange={event => {
                        const minBlocks = Number(event.target.value);
                        setRoleplayDraft(current => {
                          const previous = current.lengthBlockBudgets?.[level]
                            ?? DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS[level];
                          return {
                            ...current,
                            lengthBlockBudgets: {
                              ...DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS,
                              ...current.lengthBlockBudgets,
                              [level]: {
                                minBlocks,
                                maxBlocks: Math.max(minBlocks, previous.maxBlocks),
                              },
                            },
                          };
                        });
                      }}
                    />
                  </label>
                  <label>
                    <span>最多块</span>
                    <input
                      aria-invalid={invalid}
                      type="number"
                      min={1}
                      max={8}
                      step={1}
                      value={budget.maxBlocks}
                      onChange={event => {
                        const maxBlocks = Number(event.target.value);
                        setRoleplayDraft(current => {
                          const previous = current.lengthBlockBudgets?.[level]
                            ?? DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS[level];
                          return {
                            ...current,
                            lengthBlockBudgets: {
                              ...DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS,
                              ...current.lengthBlockBudgets,
                              [level]: {
                                minBlocks: Math.min(previous.minBlocks, maxBlocks),
                                maxBlocks,
                              },
                            },
                          };
                        });
                      }}
                    />
                  </label>
                </div>
              );
            })}
          </div>
          <small className="roleplay-length-budget-hint">每档 1—8 块；最多块不能小于最少块。改完后下一轮试演生效。</small>
        </section>

        <div className={roleplayDraftInvalid ? "scene-settings-summary invalid" : "scene-settings-summary"} role={roleplayDraftInvalid ? "alert" : "status"}>
          {roleplayDraftInvalid
            ? "请检查近期消息窗口、max tokens 与各档块数范围。"
            : `当前：演出推理 ${roleplayDraft.performanceReasoningEffort}；JSON 推理 ${roleplayDraft.jsonReasoningEffort}；终审 ${roleplayDraft.qualityFinalizeEnabled ? "开" : "关"}；窗口 ${roleplayDraft.recentMessages} 条；演出 ${roleplayDraft.replyMaxOutputTokens} / JSON ${roleplayDraft.jsonMaxOutputTokens} tokens。`}
        </div>
        <div className="scene-settings-actions">
          <span>{roleplaySettingsDirty ? "有未保存的修改" : "所有修改均已保存"}</span>
          <button onClick={resetRoleplaySettings} disabled={busy || !roleplaySettingsDirty}>放弃修改</button>
          <button
            className="primary"
            onClick={() => void saveRoleplaySettings()}
            disabled={busy || roleplayDraftInvalid || !roleplaySettingsDirty}
          >
            {busy ? "保存中…" : "保存修改"}
          </button>
        </div>
          </div>}
          {section === "style" && styleContent}
          {section === "prose-gates" && proseGatesContent}
          {section === "connection" && connectionContent}
          {section === "appearance" && appearanceContent}
        </main>
      </div>
    </section>
    {editing && <div className="modal-backdrop nested" onMouseDown={() => setEditing(null)}><section className="modal provider-editor" onMouseDown={event => event.stopPropagation()}>
      <div className="provider-editor-head"><div><span className="eyebrow">Provider</span><h2>{editing.id ? "编辑供应商" : "添加供应商"}</h2></div><button className="icon" title="关闭" aria-label="关闭" onClick={() => setEditing(null)}><X size={17} /></button></div>
      <div className="character-form-grid">
        <label><span>显示名称</span><input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}/></label>
        <label><span>协议类型</span><select value={editing.provider} onChange={e => updateConnection({ provider: e.target.value as ProfileDraft["provider"] })}><option value="openai-compatible">OpenAI 兼容（Chat Completions）</option><option value="openai-responses">OpenAI Responses</option><option value="deepseek">DeepSeek</option></select></label>
        <label className="wide"><span>API Base URL</span><input value={editing.baseUrl} onChange={e => updateConnection({ baseUrl: e.target.value })} placeholder={editing.provider === "openai-responses" ? "https://api.openai.com/v1" : undefined}/></label>
        <label className="wide"><span>代理 URL（可选）</span><input placeholder="http://127.0.0.1:7890" value={editing.proxyUrl ?? ""} onChange={e => updateConnection({ proxyUrl: e.target.value })}/></label>
        <label className="wide"><span>API Key（留空保留现有密钥）</span><input type="password" value={editing.apiKey} onChange={e => updateConnection({ apiKey: e.target.value })}/></label>
        <label>
          <span>最大并发请求</span>
          <input
            type="number"
            min={1}
            max={64}
            step={1}
            value={editing.maxConcurrent ?? 5}
            onChange={e => {
              const value = Number(e.target.value);
              updateConnection({ maxConcurrent: Number.isFinite(value) ? value : 5 });
            }}
          />
          <em className="field-unit">默认 5；含流式整段占用</em>
        </label>
        <label>
          <span>每分钟请求上限（RPM）</span>
          <input
            type="number"
            min={0}
            max={10000}
            step={1}
            placeholder="不限制"
            value={editing.maxRpm ?? ""}
            onChange={e => {
              const raw = e.target.value.trim();
              if (!raw) {
                updateConnection({ maxRpm: undefined });
                return;
              }
              const value = Number(raw);
              updateConnection({ maxRpm: Number.isFinite(value) && value > 0 ? value : undefined });
            }}
          />
          <em className="field-unit">可选；0/空=不限制</em>
        </label>
      </div>
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
