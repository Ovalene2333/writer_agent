/** 角色扮演：角色感知明细与可纠错编辑。 */
import React, { useState } from "react";
import { Pencil, RefreshCw, Save } from "lucide-react";
import { Markdown } from "./markdown";
import type { RoleplayPerceptionProjection } from "./types";

export function RoleplayPerceptionDetails({ content, data, disabled, onSave, onReplay }: {
  content: string;
  data?: RoleplayPerceptionProjection;
  disabled?: boolean;
  onSave: (value: RoleplayPerceptionProjection) => Promise<void>;
  onReplay: (value: RoleplayPerceptionProjection) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RoleplayPerceptionProjection | null>(null);
  const [saving, setSaving] = useState(false);
  const beginEdit = () => {
    if (!data) return;
    setDraft({
      ...data,
      speech: [...data.speech],
      knowableFacts: [...data.knowableFacts],
      unknowableFacts: [...data.unknowableFacts],
      potentialSensations: [...data.potentialSensations],
    });
    setEditing(true);
  };
  const setLines = (key: keyof RoleplayPerceptionProjection, value: string) => {
    setDraft(current => current
      ? { ...current, [key]: value.split("\n").map(item => item.trim()).filter(Boolean) }
      : current);
  };
  const submit = async (replay: boolean) => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      if (replay) await onReplay(draft);
      else await onSave(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  const perceptionGroups = data
    ? [
        { key: "speech", label: "话语", items: data.speech },
        { key: "knowable", label: "可知事实", items: data.knowableFacts },
        { key: "unknowable", label: "其他事实（不优先使用）", items: data.unknowableFacts },
        { key: "sensations", label: "潜在感受", items: data.potentialSensations },
      ].filter(group => group.items.length > 0)
    : [];
  return (
    <details className="roleplay-perception-details">
      <summary>角色感知</summary>
      {!editing ? (
        <>
          {data ? (
            <div className="roleplay-perception-content">
              {perceptionGroups.length
                ? perceptionGroups.map(group => (
                    <div className="roleplay-perception-group" key={group.key}>
                      <span>{group.label}</span>
                      <div>{group.items.map((item, index) => <p key={`${group.key}-${index}`}>{item}</p>)}</div>
                    </div>
                  ))
                : <p className="roleplay-perception-empty">没有可确认的可感知内容</p>}
            </div>
          ) : (
            <Markdown content={content} className="roleplay-perception-content roleplay-perception-legacy" />
          )}
          {data && (
            <button
              className="roleplay-perception-edit"
              type="button"
              disabled={disabled}
              onClick={beginEdit}
              title="修正角色实际能够感知的内容"
            >
              <Pencil size={13} aria-hidden="true" />编辑感知
            </button>
          )}
        </>
      ) : draft ? (
        <div className="roleplay-perception-editor">
          <label><span>话语</span><textarea value={draft.speech.join("\n")} onChange={event => setLines("speech", event.target.value)} /></label>
          <label><span>可知事实</span><textarea value={draft.knowableFacts.join("\n")} onChange={event => setLines("knowableFacts", event.target.value)} /></label>
          <label><span>其他事实（不优先使用）</span><textarea value={draft.unknowableFacts.join("\n")} onChange={event => setLines("unknowableFacts", event.target.value)} /></label>
          <label><span>潜在感受</span><textarea value={draft.potentialSensations.join("\n")} onChange={event => setLines("potentialSensations", event.target.value)} /></label>
          <div className="roleplay-perception-actions">
            <button type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button>
            <button type="button" disabled={saving} onClick={() => void submit(false)}><Save size={13} aria-hidden="true" />保存</button>
            <button type="button" className="primary" disabled={saving} onClick={() => void submit(true)}><RefreshCw size={13} aria-hidden="true" />保存并重演</button>
          </div>
        </div>
      ) : null}
    </details>
  );
}
