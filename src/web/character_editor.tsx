import React, { useMemo, useRef, useState } from "react";

type Temporal = {
  validFrom?: string;
  validUntil?: string;
};
type TextEntry = Temporal & { id: string; label: string; description: string };
type Goal = Temporal & {
  id: string;
  category: "longTerm" | "current";
  status: "active" | "achieved" | "abandoned" | "blocked" | "unknown";
  priority: number;
  summary: string;
  stakes: string;
  obstacles: string[];
};
type Relationship = Temporal & {
  id: string;
  characterId: number;
  type: string;
  description: string;
  attitude: string;
  status: "active" | "ended" | "strained" | "unknown";
};
type Competency = Temporal & {
  id: string;
  name: string;
  summary: string;
  level: string;
  unlocked: boolean;
  description: string;
  resources: string[];
  limitations: string[];
  costs: string[];
};
type StoryState = Temporal & {
  id: string;
  outlineNodeId?: string;
  unanchored?: boolean;
  location: string;
  physical: string;
  emotion: string;
  knowledge: TextEntry[];
  beliefs: TextEntry[];
  intentions: string[];
  temporaryGoals: Goal[];
  notes: string;
};

export type CharacterDraft = {
  schemaVersion: 3;
  id?: number;
  identity: { name: string; aliases: string[]; tags: string[]; narrativeRole: string; summary: string };
  profile: { appearanceSummary: string; distinguishingFeatures: string[]; backgroundSummary: string; biography: string };
  psychology: {
    summary: string;
    traits: TextEntry[];
    values: TextEntry[];
    fears: TextEntry[];
    conflicts: TextEntry[];
  };
  motivations: Goal[];
  voice: {
    summary: string;
    register: string;
    diction: string[];
    verbalHabits: string[];
    avoidedExpressions: string[];
    examples: string[];
  };
  competencies: Competency[];
  relationships: Relationship[];
  storyStates: StoryState[];
  experiences: TextEntry[];
  notes: string;
};

export type CharacterListItem = {
  id: number;
  identity: { name: string };
};

type SectionId =
  | "overview"
  | "identity"
  | "profile"
  | "psychology"
  | "voice"
  | "goals"
  | "skills"
  | "relations"
  | "experiences"
  | "states"
  | "notes";

const SECTIONS: Array<{ id: SectionId; label: string; hint: string }> = [
  { id: "overview", label: "概览", hint: "快速扫读" },
  { id: "identity", label: "身份", hint: "姓名定位" },
  { id: "profile", label: "外形背景", hint: "外貌身世" },
  { id: "psychology", label: "心理", hint: "性格价值" },
  { id: "voice", label: "声线", hint: "对白口吻" },
  { id: "goals", label: "目标", hint: "动机赌注" },
  { id: "skills", label: "能力", hint: "技能资源" },
  { id: "relations", label: "关系", hint: "人际网络" },
  { id: "experiences", label: "经历", hint: "已确认事件" },
  { id: "states", label: "故事状态", hint: "场景切片" },
  { id: "notes", label: "备注", hint: "自由记录" },
];

const PSYCH_GROUPS = [
  { key: "traits" as const, label: "性格特质" },
  { key: "values" as const, label: "价值观" },
  { key: "fears" as const, label: "恐惧" },
  { key: "conflicts" as const, label: "内在冲突" },
];

const GOAL_STATUS: Array<{ value: Goal["status"]; label: string }> = [
  { value: "active", label: "进行中" },
  { value: "achieved", label: "已达成" },
  { value: "abandoned", label: "已放弃" },
  { value: "blocked", label: "受阻" },
  { value: "unknown", label: "未知" },
];

const REL_STATUS: Array<{ value: Relationship["status"]; label: string }> = [
  { value: "active", label: "进行中" },
  { value: "ended", label: "已结束" },
  { value: "strained", label: "紧张" },
  { value: "unknown", label: "未知" },
];

const splitList = (value: string) => value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
const entryId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const filled = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.some(item => item.trim()) : Boolean(value?.trim());
const clip = (value: string, max = 120) => {
  const text = value.trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function Field(props: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`ce-field${props.wide ? " wide" : ""}`}>
      <span className="ce-field-head">
        <span className="ce-field-title">{props.label}</span>
        {props.hint ? <span className="ce-field-hint">{props.hint}</span> : null}
      </span>
      <span className="ce-field-control">{props.children}</span>
    </label>
  );
}

function EmptyHint(props: { text: string }) {
  return <div className="ce-empty">{props.text}</div>;
}

function SectionHead(props: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="ce-section-head">
      <div>
        <h3>{props.title}</h3>
        {props.description ? <p>{props.description}</p> : null}
      </div>
      {props.action}
    </div>
  );
}

function EntryCard(props: {
  title?: string;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="ce-entry-card">
      <div className="ce-entry-card-head">
        <strong>{props.title || "条目"}</strong>
        {props.onRemove ? (
          <button type="button" className="ghost ce-mini-danger" onClick={props.onRemove}>
            删除
          </button>
        ) : null}
      </div>
      <div className="ce-entry-card-body">{props.children}</div>
    </div>
  );
}

function OverviewCard(props: {
  title: string;
  badge?: string;
  empty?: boolean;
  children: React.ReactNode;
  onJump?: () => void;
}) {
  return (
    <button type="button" className={`ce-overview-card${props.empty ? " empty" : ""}`} onClick={props.onJump}>
      <div className="ce-overview-card-head">
        <strong>{props.title}</strong>
        {props.badge ? <span>{props.badge}</span> : null}
      </div>
      <div className="ce-overview-card-body">{props.children}</div>
    </button>
  );
}

export function CharacterEditor(props: {
  draft: CharacterDraft;
  characters: CharacterListItem[];
  busy?: boolean;
  onChange: (next: CharacterDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  onSummarizeCompetency?: (competency: CharacterDraft["competencies"][number]) => Promise<string>;
}) {
  const draft: CharacterDraft = {
    ...props.draft,
    experiences: Array.isArray(props.draft.experiences) ? props.draft.experiences : [],
  };
  const onChange = props.onChange;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [section, setSection] = useState<SectionId>("overview");
  const [summarizingSkillId, setSummarizingSkillId] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<{ id: string; message: string } | null>(null);
  const name = draft.identity.name.trim() || "未命名角色";
  const avatar = name.slice(0, 1);

  const counts = useMemo(() => {
    const psych =
      draft.psychology.traits.length
      + draft.psychology.values.length
      + draft.psychology.fears.length
      + draft.psychology.conflicts.length;
    return {
      overview: 0,
      identity: [draft.identity.name, draft.identity.narrativeRole, draft.identity.summary, draft.identity.aliases, draft.identity.tags]
        .filter(filled).length,
      profile: [
        draft.profile.appearanceSummary,
        draft.profile.backgroundSummary,
        draft.profile.biography,
        draft.profile.distinguishingFeatures,
      ].filter(filled).length,
      psychology: (filled(draft.psychology.summary) ? 1 : 0) + psych,
      voice: [
        draft.voice.summary,
        draft.voice.register,
        draft.voice.diction,
        draft.voice.verbalHabits,
        draft.voice.avoidedExpressions,
        draft.voice.examples,
      ].filter(filled).length,
      goals: draft.motivations.length,
      skills: draft.competencies.length,
      relations: draft.relationships.length,
      experiences: draft.experiences.length,
      states: draft.storyStates.length,
      notes: filled(draft.notes) ? 1 : 0,
    } satisfies Record<SectionId, number>;
  }, [draft]);

  const patchIdentity = (patch: Partial<CharacterDraft["identity"]>) =>
    onChange({ ...draft, identity: { ...draft.identity, ...patch } });
  const patchProfile = (patch: Partial<CharacterDraft["profile"]>) =>
    onChange({ ...draft, profile: { ...draft.profile, ...patch } });
  const patchPsychology = (patch: Partial<CharacterDraft["psychology"]>) =>
    onChange({ ...draft, psychology: { ...draft.psychology, ...patch } });
  const patchVoice = (patch: Partial<CharacterDraft["voice"]>) =>
    onChange({ ...draft, voice: { ...draft.voice, ...patch } });

  const overviewSummary = draft.identity.summary || draft.psychology.summary || draft.profile.backgroundSummary;

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <section
        className="modal character-editor ce-shell"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? `编辑角色 ${name}` : "新建角色"}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="ce-header">
          <div className="ce-header-main">
            <span className="ce-avatar" aria-hidden="true">{avatar}</span>
            <div className="ce-header-text">
              <div className="ce-header-title-row">
                <h2 title={name}>{draft.id ? name : "新建角色"}</h2>
                {draft.id ? <span className="ce-id-badge">#{draft.id}</span> : <span className="ce-id-badge new">新卡</span>}
                {draft.identity.narrativeRole.trim()
                  ? <span className="ce-chip accent" title={draft.identity.narrativeRole}>{draft.identity.narrativeRole.trim()}</span>
                  : <span className="ce-chip muted">未设定位</span>}
              </div>
              {(draft.identity.aliases.length > 0 || draft.identity.tags.length > 0) && (
                <div className="ce-header-meta">
                  {draft.identity.aliases.slice(0, 5).map(alias => (
                    <span className="ce-chip muted" key={`a-${alias}`} title={alias}>{alias}</span>
                  ))}
                  {draft.identity.tags.slice(0, 5).map(tag => (
                    <span className="ce-chip" key={`t-${tag}`} title={tag}>{tag}</span>
                  ))}
                </div>
              )}
              <p className={`ce-header-summary${overviewSummary ? "" : " muted"}`} title={overviewSummary || undefined}>
                {overviewSummary ? clip(overviewSummary, 140) : "在「身份」分区补一句摘要，顶部会显示在这里。"}
              </p>
            </div>
          </div>
          <div className="ce-header-actions">
            {props.onDelete && draft.id ? (
              <button type="button" className="danger ghost" disabled={props.busy} onClick={props.onDelete}>
                删除
              </button>
            ) : null}
            <span className="ce-header-actions-divider" aria-hidden="true" />
            <button type="button" disabled={props.busy} onClick={props.onClose}>取消</button>
            <button
              type="button"
              className="primary"
              disabled={props.busy || !draft.identity.name.trim()}
              onClick={props.onSave}
            >
              保存
            </button>
          </div>
        </header>

        <div className="ce-layout">
          <nav className="ce-nav" aria-label="角色分区">
            {SECTIONS.map(item => {
              const count = counts[item.id];
              const active = section === item.id;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`ce-nav-item${active ? " active" : ""}`}
                  onClick={() => setSection(item.id)}
                >
                  <span className="ce-nav-label">{item.label}</span>
                  <span className="ce-nav-hint">{item.hint}</span>
                  {item.id !== "overview" && count > 0 ? <span className="ce-nav-count">{count}</span> : null}
                </button>
              );
            })}
          </nav>

          <div className="ce-body">
            {section === "overview" && (
              <div className="ce-overview">
                <SectionHead
                  title="角色速览"
                  description="点任意卡片跳到对应分区编辑。空白分区会显示为灰色。"
                />
                <div className="ce-overview-grid">
                  <OverviewCard
                    title="身份"
                    badge={draft.identity.narrativeRole || undefined}
                    empty={!filled(draft.identity.summary) && !filled(draft.identity.name)}
                    onJump={() => setSection("identity")}
                  >
                    <p>{clip(draft.identity.summary) || "尚未填写身份摘要"}</p>
                    {draft.identity.aliases.length > 0 && (
                      <small>别名：{draft.identity.aliases.join("、")}</small>
                    )}
                  </OverviewCard>
                  <OverviewCard
                    title="外形与背景"
                    empty={!filled(draft.profile.appearanceSummary) && !filled(draft.profile.backgroundSummary)}
                    onJump={() => setSection("profile")}
                  >
                    <p>{clip(draft.profile.appearanceSummary || draft.profile.backgroundSummary) || "尚未填写外形或背景"}</p>
                    {draft.profile.distinguishingFeatures.length > 0 && (
                      <small>特征：{draft.profile.distinguishingFeatures.join("、")}</small>
                    )}
                  </OverviewCard>
                  <OverviewCard
                    title="心理"
                    badge={counts.psychology ? `${counts.psychology} 条` : undefined}
                    empty={!filled(draft.psychology.summary) && counts.psychology === 0}
                    onJump={() => setSection("psychology")}
                  >
                    <p>{clip(draft.psychology.summary) || "尚未填写性格摘要"}</p>
                  </OverviewCard>
                  <OverviewCard
                    title="声线"
                    empty={!filled(draft.voice.summary) && !filled(draft.voice.register)}
                    onJump={() => setSection("voice")}
                  >
                    <p>{clip(draft.voice.summary || draft.voice.register) || "尚未填写声线"}</p>
                    {draft.voice.examples[0] ? <small>例：「{clip(draft.voice.examples[0], 60)}」</small> : null}
                  </OverviewCard>
                  <OverviewCard
                    title="目标"
                    badge={`${draft.motivations.length}`}
                    empty={draft.motivations.length === 0}
                    onJump={() => setSection("goals")}
                  >
                    {draft.motivations.length === 0 ? (
                      <p>暂无目标</p>
                    ) : (
                      <ul>
                        {draft.motivations.slice(0, 3).map(goal => (
                          <li key={goal.id}>{clip(goal.summary, 80) || "（空目标）"}</li>
                        ))}
                      </ul>
                    )}
                  </OverviewCard>
                  <OverviewCard
                    title="能力"
                    badge={`${draft.competencies.length}`}
                    empty={draft.competencies.length === 0}
                    onJump={() => setSection("skills")}
                  >
                    {draft.competencies.length === 0 ? (
                      <p>暂无能力条目</p>
                    ) : (
                      <ul>
                        {draft.competencies.slice(0, 4).map(skill => (
                          <li key={skill.id}>{skill.name || "未命名"}{skill.level ? ` · ${skill.level}` : ""} · {skill.unlocked ? "已解锁" : "未解锁"}</li>
                        ))}
                      </ul>
                    )}
                  </OverviewCard>
                  <OverviewCard
                    title="关系"
                    badge={`${draft.relationships.length}`}
                    empty={draft.relationships.length === 0}
                    onJump={() => setSection("relations")}
                  >
                    {draft.relationships.length === 0 ? (
                      <p>暂无关系</p>
                    ) : (
                      <ul>
                        {draft.relationships.slice(0, 4).map(rel => {
                          const other = props.characters.find(item => item.id === rel.characterId);
                          return (
                            <li key={rel.id}>
                              {other?.identity.name ?? `#${rel.characterId}`}
                              {rel.type ? ` · ${rel.type}` : ""}
                              {rel.attitude ? ` · ${rel.attitude}` : ""}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </OverviewCard>
                  <OverviewCard
                    title="经历"
                    badge={`${draft.experiences.length}`}
                    empty={draft.experiences.length === 0}
                    onJump={() => setSection("experiences")}
                  >
                    {draft.experiences.length === 0 ? (
                      <p>暂无已确认经历</p>
                    ) : (
                      <ul>
                        {draft.experiences.slice(-3).map(exp => (
                          <li key={exp.id}>{clip(exp.label || exp.description, 80) || "（空经历）"}</li>
                        ))}
                      </ul>
                    )}
                  </OverviewCard>
                  <OverviewCard
                    title="故事状态"
                    badge={`${draft.storyStates.length}`}
                    empty={draft.storyStates.length === 0}
                    onJump={() => setSection("states")}
                  >
                    {draft.storyStates.length === 0 ? (
                      <p>暂无场景状态切片</p>
                    ) : (
                      <ul>
                        {draft.storyStates.slice(0, 3).map(state => (
                          <li key={state.id}>
                            {[state.location, state.emotion, state.physical].filter(Boolean).join(" · ") || "未命名状态"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </OverviewCard>
                </div>
              </div>
            )}

            {section === "identity" && (
              <div className="ce-panel">
                <SectionHead title="身份" description="列表卡片与顶部栏会优先读这些字段。" />
                <div className="ce-form-stack">
                  <div className="ce-form-grid">
                    <Field label="姓名"><input value={draft.identity.name} onChange={e => patchIdentity({ name: e.target.value })} placeholder="正式名" /></Field>
                    <Field label="叙事定位" hint="主角 / 配角 / 对手…"><input value={draft.identity.narrativeRole} onChange={e => patchIdentity({ narrativeRole: e.target.value })} placeholder="主角 · S 级机娘" /></Field>
                  </div>
                  <Field label="别名" hint="逗号或换行分隔" wide>
                    <input value={draft.identity.aliases.join(", ")} onChange={e => patchIdentity({ aliases: splitList(e.target.value) })} placeholder="千夏, Chinatsu, 银翼姬" />
                  </Field>
                  <Field label="标签" hint="逗号或换行分隔" wide>
                    <input value={draft.identity.tags.join(", ")} onChange={e => patchIdentity({ tags: splitList(e.target.value) })} placeholder="机娘, 银翼计划" />
                  </Field>
                  <Field label="身份摘要" hint="一句话说明她是谁" wide>
                    <textarea value={draft.identity.summary} onChange={e => patchIdentity({ summary: e.target.value })} placeholder="在故事里站在什么位置？读者最先记住什么？" rows={3} />
                  </Field>
                </div>
              </div>
            )}

            {section === "profile" && (
              <div className="ce-panel">
                <SectionHead title="外形与背景" description="从上到下：先看一眼 → 记住特征 → 出身背景 → 详细传记。" />
                <div className="ce-form-stack">
                  <Field label="外貌" hint="身高体态、五官气质、常服" wide>
                    <textarea
                      value={draft.profile.appearanceSummary}
                      onChange={e => patchProfile({ appearanceSummary: e.target.value })}
                      placeholder="身高体态、发型发色、穿着与整体气质…"
                      rows={5}
                    />
                  </Field>
                  <Field label="辨识特征" hint="每行一条，写作时最容易被点名" wide>
                    <textarea
                      value={draft.profile.distinguishingFeatures.join("\n")}
                      onChange={e => patchProfile({
                        distinguishingFeatures: e.target.value.split(/\n/).map(item => item.trim()).filter(Boolean),
                      })}
                      placeholder={"浅琥珀色虹膜\n浅亚麻色长发\n右耳简约银钉"}
                      rows={4}
                    />
                  </Field>
                  <Field label="背景摘要" hint="出身与关键经历，控制在一段内" wide>
                    <textarea
                      value={draft.profile.backgroundSummary}
                      onChange={e => patchProfile({ backgroundSummary: e.target.value })}
                      placeholder="家庭、成长环境、进入主线前的位置…"
                      rows={5}
                    />
                  </Field>
                  <details className="ce-details" open={Boolean(draft.profile.biography.trim())}>
                    <summary>
                      <span>详细传记</span>
                      <small>{draft.profile.biography.trim() ? "已填写，点击收起/展开" : "可选 · 完整身世与经历"}</small>
                    </summary>
                    <Field label="传记" hint="长文放这里，不影响上方速读" wide>
                      <textarea
                        className="ce-tall"
                        value={draft.profile.biography}
                        onChange={e => patchProfile({ biography: e.target.value })}
                        placeholder="更完整的身世、时间线与经历…"
                        rows={10}
                      />
                    </Field>
                  </details>
                </div>
              </div>
            )}

            {section === "psychology" && (
              <div className="ce-panel">
                <SectionHead title="心理" description="先写总述，再按需补特质 / 价值 / 恐惧 / 冲突。" />
                <div className="ce-form-stack">
                  <Field label="性格摘要" hint="一句话抓住内核" wide>
                    <textarea value={draft.psychology.summary} onChange={e => patchPsychology({ summary: e.target.value })} placeholder="外表冷静，内里紧绷；对亲近的人话少但认真。" rows={3} />
                  </Field>
                </div>
                {PSYCH_GROUPS.map(group => (
                  <div className="ce-list-block" key={group.key}>
                    <SectionHead
                      title={group.label}
                      action={(
                        <button
                          type="button"
                          onClick={() => patchPsychology({
                            [group.key]: [
                              ...draft.psychology[group.key],
                              { id: entryId(group.key), label: "", description: "" },
                            ],
                          })}
                        >
                          + 添加
                        </button>
                      )}
                    />
                    {draft.psychology[group.key].length === 0 ? (
                      <EmptyHint text={`暂无${group.label}，可点右上角添加。`} />
                    ) : (
                      <div className="ce-entry-list">
                        {draft.psychology[group.key].map((item, index) => (
                          <EntryCard
                            key={item.id}
                            title={item.label.trim() || `${group.label} ${index + 1}`}
                            onRemove={() => patchPsychology({
                              [group.key]: draft.psychology[group.key].filter(x => x.id !== item.id),
                            })}
                          >
                            <div className="ce-form-grid">
                              <Field label="标签"><input value={item.label} onChange={e => patchPsychology({
                                [group.key]: draft.psychology[group.key].map(x => x.id === item.id ? { ...x, label: e.target.value } : x),
                              })} placeholder="短标签" /></Field>
                              <Field label="说明" wide>
                                <textarea value={item.description} onChange={e => patchPsychology({
                                  [group.key]: draft.psychology[group.key].map(x => x.id === item.id ? { ...x, description: e.target.value } : x),
                                })} placeholder="具体表现" rows={2} />
                              </Field>
                            </div>
                          </EntryCard>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {section === "voice" && (
              <div className="ce-panel">
                <SectionHead title="声线与对白" description="写作与角色扮演时优先读这里。" />
                <div className="ce-form-stack">
                  <Field label="声线摘要" hint="节奏、态度、口头禅倾向" wide>
                    <textarea value={draft.voice.summary} onChange={e => patchVoice({ summary: e.target.value })} placeholder="简洁、略带吐槽；累的时候句子更短。" rows={3} />
                  </Field>
                  <div className="ce-form-grid">
                    <Field label="语域 / 口气"><input value={draft.voice.register} onChange={e => patchVoice({ register: e.target.value })} placeholder="口语 / 冷淡 / 文雅…" /></Field>
                    <Field label="用词与习惯" hint="逗号分隔"><input value={[...draft.voice.diction, ...draft.voice.verbalHabits].join(", ")} onChange={e => patchVoice({ diction: splitList(e.target.value), verbalHabits: [] })} placeholder="……嗯, 少用敬语" /></Field>
                  </div>
                  <Field label="避免表达" hint="逗号或换行" wide>
                    <input value={draft.voice.avoidedExpressions.join(", ")} onChange={e => patchVoice({ avoidedExpressions: splitList(e.target.value) })} placeholder="不说肉麻情话, 不自称本小姐" />
                  </Field>
                  <Field label="对白示例" hint="每行一句，越像本人越好" wide>
                    <textarea className="ce-tall" value={draft.voice.examples.join("\n")} onChange={e => patchVoice({ examples: e.target.value.split(/\n/).map(x => x.trim()).filter(Boolean) })} placeholder={"别盯着我看。\n……知道了。"} rows={6} />
                  </Field>
                </div>
              </div>
            )}

            {section === "goals" && (
              <div className="ce-panel">
                <SectionHead
                  title="目标与动机"
                  description="长期/当前目标，可标注优先级与赌注。"
                  action={(
                    <button type="button" onClick={() => onChange({
                      ...draft,
                      motivations: [...draft.motivations, {
                        id: entryId("goal"), category: "current", status: "active", priority: 50,
                        summary: "", stakes: "", obstacles: [],
                      }],
                    })}>+ 添加目标</button>
                  )}
                />
                {draft.motivations.length === 0 ? (
                  <EmptyHint text="还没有目标。写清角色现在想要什么，写作时更稳。" />
                ) : (
                  <div className="ce-entry-list">
                    {draft.motivations.map((goal, index) => (
                      <EntryCard
                        key={goal.id}
                        title={goal.summary.trim() || `目标 ${index + 1}`}
                        onRemove={() => onChange({ ...draft, motivations: draft.motivations.filter(x => x.id !== goal.id) })}
                      >
                        <div className="ce-form-grid">
                          <Field label="类型">
                            <select value={goal.category} onChange={e => onChange({
                              ...draft,
                              motivations: draft.motivations.map(x => x.id === goal.id ? { ...x, category: e.target.value as Goal["category"] } : x),
                            })}>
                              <option value="current">当前</option>
                              <option value="longTerm">长期</option>
                            </select>
                          </Field>
                          <Field label="状态">
                            <select value={goal.status} onChange={e => onChange({
                              ...draft,
                              motivations: draft.motivations.map(x => x.id === goal.id ? { ...x, status: e.target.value as Goal["status"] } : x),
                            })}>
                              {GOAL_STATUS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                            </select>
                          </Field>
                          <Field label="优先级 0–100">
                            <input type="number" min={0} max={100} value={goal.priority} onChange={e => onChange({
                              ...draft,
                              motivations: draft.motivations.map(x => x.id === goal.id ? { ...x, priority: Number(e.target.value) } : x),
                            })} />
                          </Field>
                          <Field label="目标内容" wide>
                            <textarea value={goal.summary} onChange={e => onChange({
                              ...draft,
                              motivations: draft.motivations.map(x => x.id === goal.id ? { ...x, summary: e.target.value } : x),
                            })} placeholder="想要什么？" rows={2} />
                          </Field>
                          <Field label="赌注 / 失败代价" wide>
                            <input value={goal.stakes} onChange={e => onChange({
                              ...draft,
                              motivations: draft.motivations.map(x => x.id === goal.id ? { ...x, stakes: e.target.value } : x),
                            })} placeholder="失败会失去什么" />
                          </Field>
                          <Field label="生效自（大纲节点）"><input value={goal.validFrom ?? ""} onChange={e => onChange({
                            ...draft,
                            motivations: draft.motivations.map(x => x.id === goal.id ? { ...x, validFrom: e.target.value || undefined } : x),
                          })} placeholder="可选" /></Field>
                          <Field label="生效至（大纲节点）"><input value={goal.validUntil ?? ""} onChange={e => onChange({
                            ...draft,
                            motivations: draft.motivations.map(x => x.id === goal.id ? { ...x, validUntil: e.target.value || undefined } : x),
                          })} placeholder="可选" /></Field>
                        </div>
                      </EntryCard>
                    ))}
                  </div>
                )}
              </div>
            )}

            {section === "skills" && (
              <div className="ce-panel">
                <SectionHead
                  title="能力"
                  description="能做什么、做到什么程度、代价是什么。"
                  action={(
                    <button type="button" onClick={() => onChange({
                      ...draft,
                      competencies: [...draft.competencies, {
                        id: entryId("skill"), name: "", summary: "", level: "", unlocked: false, description: "",
                        resources: [], limitations: [], costs: [],
                      }],
                    })}>+ 添加能力</button>
                  )}
                />
                {draft.competencies.length === 0 ? (
                  <EmptyHint text="暂无能力条目。" />
                ) : (
                  <div className="ce-entry-list">
                    {draft.competencies.map((skill, index) => (
                      <EntryCard
                        key={skill.id}
                        title={skill.name.trim() || `能力 ${index + 1}`}
                        onRemove={() => onChange({ ...draft, competencies: draft.competencies.filter(x => x.id !== skill.id) })}
                      >
                        <div className="ce-form-grid">
                          <Field label="名称"><input value={skill.name} onChange={e => onChange({
                            ...draft,
                            competencies: draft.competencies.map(x => x.id === skill.id ? { ...x, name: e.target.value } : x),
                          })} /></Field>
                          <Field label="等级 / 强度"><input value={skill.level} onChange={e => onChange({
                            ...draft,
                            competencies: draft.competencies.map(x => x.id === skill.id ? { ...x, level: e.target.value } : x),
                          })} placeholder="精通 / S 级…" /></Field>
                          <Field label="是否解锁">
                            <select value={skill.unlocked ? "yes" : "no"} onChange={e => onChange({
                              ...draft,
                              competencies: draft.competencies.map(x => x.id === skill.id ? { ...x, unlocked: e.target.value === "yes" } : x),
                            })}>
                              <option value="no">否</option>
                              <option value="yes">是</option>
                            </select>
                          </Field>
                          <Field label="能力摘要" hint="未解锁时智能体仍可见" wide>
                            <textarea value={skill.summary} onChange={e => onChange({
                              ...draft,
                              competencies: draft.competencies.map(x => x.id === skill.id ? { ...x, summary: e.target.value } : x),
                            })} rows={2} />
                          </Field>
                          {props.onSummarizeCompetency && (
                            <div className="ce-field-actions wide">
                              <button
                                type="button"
                                className="ghost"
                                disabled={summarizingSkillId !== null}
                                onClick={() => {
                                  setSummarizingSkillId(skill.id);
                                  setSummaryError(null);
                                  void props.onSummarizeCompetency!(skill)
                                    .then(summary => {
                                      const current = draftRef.current;
                                      onChange({
                                        ...current,
                                        competencies: current.competencies.map(x => x.id === skill.id ? { ...x, summary } : x),
                                      });
                                    })
                                    .catch(error => setSummaryError({ id: skill.id, message: String(error) }))
                                    .finally(() => setSummarizingSkillId(null));
                                }}
                              >
                                {summarizingSkillId === skill.id ? "摘要模型归纳中…" : "用摘要模型生成"}
                              </button>
                              {summaryError?.id === skill.id && <small role="alert">{summaryError.message}</small>}
                            </div>
                          )}
                          <Field label="详细说明" hint="仅解锁后向智能体暴露" wide>
                            <textarea value={skill.description} onChange={e => onChange({
                              ...draft,
                              competencies: draft.competencies.map(x => x.id === skill.id ? { ...x, description: e.target.value } : x),
                            })} rows={2} />
                          </Field>
                          <Field label="资源" hint="逗号分隔"><input value={skill.resources.join(", ")} onChange={e => onChange({
                            ...draft,
                            competencies: draft.competencies.map(x => x.id === skill.id ? { ...x, resources: splitList(e.target.value) } : x),
                          })} /></Field>
                          <Field label="限制 / 代价" hint="逗号分隔"><input value={[...skill.limitations, ...skill.costs].join(", ")} onChange={e => onChange({
                            ...draft,
                            competencies: draft.competencies.map(x => x.id === skill.id ? { ...x, limitations: splitList(e.target.value), costs: [] } : x),
                          })} /></Field>
                        </div>
                      </EntryCard>
                    ))}
                  </div>
                )}
              </div>
            )}

            {section === "experiences" && (
              <div className="ce-panel">
                <SectionHead
                  title="已确认经历"
                  description="随剧情推进写入的事件节点；不是完整传记散文。写作 Agent 可用 apply_character_changes 同步。"
                  action={(
                    <button type="button" onClick={() => onChange({
                      ...draft,
                      experiences: [...draft.experiences, { id: entryId("exp"), label: "", description: "" }],
                    })}>+ 添加经历</button>
                  )}
                />
                {draft.experiences.length === 0 ? (
                  <EmptyHint text="暂无结构化经历。觉醒、背叛、关键选择等可在此记录。" />
                ) : (
                  <div className="ce-entry-list">
                    {draft.experiences.map((exp, index) => (
                      <EntryCard
                        key={exp.id}
                        title={exp.label.trim() || `经历 ${index + 1}`}
                        onRemove={() => onChange({
                          ...draft,
                          experiences: draft.experiences.filter(x => x.id !== exp.id),
                        })}
                      >
                        <div className="ce-form-grid">
                          <Field label="标题">
                            <input
                              value={exp.label}
                              onChange={e => onChange({
                                ...draft,
                                experiences: draft.experiences.map(x => x.id === exp.id ? { ...x, label: e.target.value } : x),
                              })}
                              placeholder="短标题，如：灵视觉醒"
                            />
                          </Field>
                          <Field label="生效自（大纲节点）">
                            <input
                              value={exp.validFrom ?? ""}
                              onChange={e => onChange({
                                ...draft,
                                experiences: draft.experiences.map(x => x.id === exp.id
                                  ? { ...x, validFrom: e.target.value || undefined }
                                  : x),
                              })}
                              placeholder="可选 outline 节点 ID"
                            />
                          </Field>
                          <Field label="说明" wide>
                            <textarea
                              value={exp.description}
                              onChange={e => onChange({
                                ...draft,
                                experiences: draft.experiences.map(x => x.id === exp.id ? { ...x, description: e.target.value } : x),
                              })}
                              rows={3}
                              placeholder="事件摘要与对角色的影响"
                            />
                          </Field>
                        </div>
                      </EntryCard>
                    ))}
                  </div>
                )}
              </div>
            )}

            {section === "relations" && (
              <div className="ce-panel">
                <SectionHead title="人际关系" description="先勾选相关角色，再填写关系细节。" />
                <div className="ce-relation-picker">
                  <span className="ce-field-label">选择相关角色</span>
                  <div className="relation-picker">
                    {props.characters.filter(item => item.id !== draft.id).length === 0 ? (
                      <span className="ce-empty-inline">还没有其他角色可关联</span>
                    ) : props.characters.filter(item => item.id !== draft.id).map(item => {
                      const selected = draft.relationships.some(rel => rel.characterId === item.id);
                      return (
                        <button
                          type="button"
                          key={item.id}
                          className={selected ? "selected" : ""}
                          onClick={() => onChange({
                            ...draft,
                            relationships: selected
                              ? draft.relationships.filter(rel => rel.characterId !== item.id)
                              : [...draft.relationships, {
                                id: entryId("rel"),
                                characterId: item.id,
                                type: "关联",
                                description: "",
                                attitude: "",
                                status: "active",
                              }],
                          })}
                        >
                          {item.identity.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {draft.relationships.length === 0 ? (
                  <EmptyHint text="尚未建立关系。勾选上方角色开始。" />
                ) : (
                  <div className="ce-entry-list">
                    {draft.relationships.map(relation => {
                      const related = props.characters.find(item => item.id === relation.characterId);
                      const update = (changes: Partial<Relationship>) => onChange({
                        ...draft,
                        relationships: draft.relationships.map(item =>
                          item.characterId === relation.characterId ? { ...item, ...changes } : item),
                      });
                      return (
                        <EntryCard
                          key={relation.id || relation.characterId}
                          title={related?.identity.name ?? `#${relation.characterId}`}
                          onRemove={() => onChange({
                            ...draft,
                            relationships: draft.relationships.filter(item => item.characterId !== relation.characterId),
                          })}
                        >
                          <div className="ce-form-grid">
                            <Field label="关系类型"><input value={relation.type} onChange={e => update({ type: e.target.value })} placeholder="同盟 / 敌对 / 师徒…" /></Field>
                            <Field label="态度"><input value={relation.attitude} onChange={e => update({ attitude: e.target.value })} placeholder="信任 / 戒备…" /></Field>
                            <Field label="状态">
                              <select value={relation.status} onChange={e => update({ status: e.target.value as Relationship["status"] })}>
                                {REL_STATUS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                              </select>
                            </Field>
                            <Field label="关系说明" wide>
                              <textarea value={relation.description} onChange={e => update({ description: e.target.value })} rows={2} placeholder="这段关系对剧情意味着什么" />
                            </Field>
                          </div>
                        </EntryCard>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {section === "states" && (
              <div className="ce-panel">
                <SectionHead
                  title="故事状态"
                  description="某一章/场景下的位置、身体、情绪与临时所知。"
                  action={(
                    <button type="button" onClick={() => onChange({
                      ...draft,
                      storyStates: [...draft.storyStates, {
                        id: entryId("state"), unanchored: true, location: "", physical: "", emotion: "",
                        knowledge: [], beliefs: [], intentions: [], temporaryGoals: [], notes: "",
                      }],
                    })}>+ 添加状态</button>
                  )}
                />
                {draft.storyStates.length === 0 ? (
                  <EmptyHint text="暂无状态切片。可按大纲节点记录角色当下处境。" />
                ) : (
                  <div className="ce-entry-list">
                    {draft.storyStates.map((story, index) => (
                      <EntryCard
                        key={story.id}
                        title={[story.location, story.emotion].filter(Boolean).join(" · ") || `状态 ${index + 1}`}
                        onRemove={() => onChange({
                          ...draft,
                          storyStates: draft.storyStates.filter(x => x.id !== story.id),
                        })}
                      >
                        <div className="ce-form-grid">
                          <Field label="锚定大纲节点">
                            <input
                              disabled={Boolean(story.unanchored)}
                              value={story.outlineNodeId ?? ""}
                              onChange={e => onChange({
                                ...draft,
                                storyStates: draft.storyStates.map(x => x.id === story.id
                                  ? { ...x, outlineNodeId: e.target.value || undefined }
                                  : x),
                              })}
                              placeholder="节点 ID"
                            />
                          </Field>
                          <Field label="未锚定">
                            <label className="ce-inline-check">
                              <input
                                type="checkbox"
                                checked={Boolean(story.unanchored)}
                                onChange={e => onChange({
                                  ...draft,
                                  storyStates: draft.storyStates.map(x => x.id === story.id
                                    ? {
                                      ...x,
                                      unanchored: e.target.checked || undefined,
                                      outlineNodeId: e.target.checked ? undefined : x.outlineNodeId,
                                    }
                                    : x),
                                })}
                              />
                              <span>不绑定大纲节点</span>
                            </label>
                          </Field>
                          <Field label="位置"><input value={story.location} onChange={e => onChange({
                            ...draft,
                            storyStates: draft.storyStates.map(x => x.id === story.id ? { ...x, location: e.target.value } : x),
                          })} /></Field>
                          <Field label="身体状态"><input value={story.physical} onChange={e => onChange({
                            ...draft,
                            storyStates: draft.storyStates.map(x => x.id === story.id ? { ...x, physical: e.target.value } : x),
                          })} /></Field>
                          <Field label="情绪"><input value={story.emotion} onChange={e => onChange({
                            ...draft,
                            storyStates: draft.storyStates.map(x => x.id === story.id ? { ...x, emotion: e.target.value } : x),
                          })} /></Field>
                          <Field label="当前意图" hint="逗号分隔" wide><input value={story.intentions.join(", ")} onChange={e => onChange({
                            ...draft,
                            storyStates: draft.storyStates.map(x => x.id === story.id ? { ...x, intentions: splitList(e.target.value) } : x),
                          })} /></Field>
                          <Field label="所知信息" hint="每行一条" wide>
                            <textarea value={story.knowledge.map(x => x.description).join("\n")} onChange={e => onChange({
                              ...draft,
                              storyStates: draft.storyStates.map(x => x.id === story.id
                                ? {
                                  ...x,
                                  knowledge: e.target.value.split(/\n/).filter(Boolean).map((description, i) => ({
                                    id: `${story.id}-knowledge-${i + 1}`,
                                    label: "",
                                    description,
                                  })),
                                }
                                : x),
                            })} rows={3} />
                          </Field>
                          <Field label="状态备注" wide>
                            <textarea value={story.notes} onChange={e => onChange({
                              ...draft,
                              storyStates: draft.storyStates.map(x => x.id === story.id ? { ...x, notes: e.target.value } : x),
                            })} rows={2} />
                          </Field>
                        </div>
                      </EntryCard>
                    ))}
                  </div>
                )}
              </div>
            )}

            {section === "notes" && (
              <div className="ce-panel">
                <SectionHead title="备注" description="不适合归类的零散设定、写作备忘。" />
                <div className="ce-form-grid">
                  <Field label="自由备注" wide>
                    <textarea
                      className="ce-tall"
                      value={draft.notes}
                      onChange={e => onChange({ ...draft, notes: e.target.value })}
                      placeholder="草稿想法、待核实设定、写作禁忌…"
                      rows={12}
                    />
                  </Field>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
