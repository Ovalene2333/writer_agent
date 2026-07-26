import type { AgentEvent } from "../types.js";
import type { WriterProject } from "../project.js";
import type { WriterStore } from "../store.js";
import type { ToolCall, ToolExecutionContext, ToolHandlerArgs } from "./types.js";
import {
  handleAuditProseStyle,
  handleInspectDocument,
  handleListDocuments,
  handleLocateDocumentSpan,
  handleReadDocument,
  handleReadDocumentSpan,
  handleSearchProject,
} from "./documents.js";
import {
  handleCompareOutlineWithDraft,
  handleDesignCreativeOutline,
  handleGetOutlineNode,
  handleListOutlineNodes,
  handleProposeOutlinePatch,
  handleValidateOutline,
} from "./outline.js";
import {
  handleApplyCharacterChanges,
  handleGetCharacter,
  handleGetSimpleCharacter,
  handleListCharacters,
  handleListSimpleCharacters,
  handleSaveCharacter,
  handleSaveSimpleCharacter,
} from "./characters.js";
import { handleInspectConversation, handleReadConversation } from "./conversation.js";
import {
  handleProposeDocument,
  handleProposeDocumentPatch,
  handleReviseDocumentIsolated,
  handleWriteDocumentIsolated,
} from "./proposals.js";
import {
  handleInspectFile,
  handleListFiles,
  handleProposeChangeSet,
  handleReadFile,
  handleSearchFiles,
} from "./files.js";
import { handleCompileWritePack } from "./write_pack.js";
import {
  handleBeginChapterDraft,
  handleInspectChapterDraft,
  handleProposeChapterDraft,
  handleReviseChapterDraftStyle,
  handleReviseChapterSceneGuide,
  handleWriteChapterScene,
} from "./scene_pipeline.js";
import {
  handleAskUser,
  handleLoadSkill,
  handleManageTodos,
  handleManageProseGates,
  handleReadContextArtifact,
} from "./meta.js";

type Handler = (args: ToolHandlerArgs) => string | Promise<string>;

const HANDLERS: Record<string, Handler> = {
  list_documents: handleListDocuments,
  audit_prose_style: handleAuditProseStyle,
  inspect_document: handleInspectDocument,
  locate_document_span: handleLocateDocumentSpan,
  read_document: handleReadDocument,
  read_document_span: handleReadDocumentSpan,
  search_project: handleSearchProject,
  list_files: handleListFiles,
  inspect_file: handleInspectFile,
  read_file: handleReadFile,
  search_files: handleSearchFiles,
  list_outline_nodes: handleListOutlineNodes,
  get_outline_node: handleGetOutlineNode,
  design_creative_outline: handleDesignCreativeOutline,
  validate_outline: handleValidateOutline,
  compare_outline_with_draft: handleCompareOutlineWithDraft,
  propose_outline_patch: handleProposeOutlinePatch,
  compile_write_pack: handleCompileWritePack,
  begin_chapter_draft: handleBeginChapterDraft,
  write_chapter_scene: handleWriteChapterScene,
  revise_chapter_scene_guide: handleReviseChapterSceneGuide,
  revise_chapter_draft_style: handleReviseChapterDraftStyle,
  inspect_chapter_draft: handleInspectChapterDraft,
  propose_chapter_draft: handleProposeChapterDraft,
  propose_document: handleProposeDocument,
  write_document_isolated: handleWriteDocumentIsolated,
  propose_document_patch: handleProposeDocumentPatch,
  revise_document_isolated: handleReviseDocumentIsolated,
  propose_change_set: handleProposeChangeSet,
  list_characters: handleListCharacters,
  get_character: handleGetCharacter,
  list_simple_characters: handleListSimpleCharacters,
  get_simple_character: handleGetSimpleCharacter,
  save_character: handleSaveCharacter,
  apply_character_changes: handleApplyCharacterChanges,
  save_simple_character: handleSaveSimpleCharacter,
  inspect_conversation: handleInspectConversation,
  read_conversation: handleReadConversation,
  ask_user: handleAskUser,
  manage_todos: handleManageTodos,
  load_skill: handleLoadSkill,
  read_context_artifact: handleReadContextArtifact,
  manage_prose_gates: handleManageProseGates,
};

export async function executeTool(
  call: ToolCall,
  project: WriterProject,
  store: WriterStore,
  sessionId: string,
  emit: (event: AgentEvent) => void,
  characterScope?: number[],
  context: ToolExecutionContext = { permissionMode: "ask" },
): Promise<string> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    return JSON.stringify({ code: "INVALID_TOOL_ARGUMENTS_JSON", error: "工具参数不是有效 JSON；请用同一工具重试一次并提交完整 JSON" });
  }
  const handler = HANDLERS[call.name];
  if (!handler) return JSON.stringify({ error: `未知工具：${call.name}` });
  try {
    return await handler({ input, project, store, sessionId, emit, characterScope, context });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

export function registeredToolNames(): string[] {
  return Object.keys(HANDLERS);
}
