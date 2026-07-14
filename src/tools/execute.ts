import type { AgentEvent } from "../types.js";
import type { WriterProject } from "../project.js";
import type { WriterStore } from "../store.js";
import type { ToolCall, ToolExecutionContext, ToolHandlerArgs } from "./types.js";
import {
  handleAuditProseStyle,
  handleInspectDocument,
  handleListDocuments,
  handleReadDocument,
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
} from "./proposals.js";
import {
  handleAskUser,
  handleLoadSkill,
  handleManageTodos,
} from "./meta.js";

type Handler = (args: ToolHandlerArgs) => string | Promise<string>;

const HANDLERS: Record<string, Handler> = {
  list_documents: handleListDocuments,
  audit_prose_style: handleAuditProseStyle,
  inspect_document: handleInspectDocument,
  read_document: handleReadDocument,
  search_project: handleSearchProject,
  list_outline_nodes: handleListOutlineNodes,
  get_outline_node: handleGetOutlineNode,
  design_creative_outline: handleDesignCreativeOutline,
  validate_outline: handleValidateOutline,
  compare_outline_with_draft: handleCompareOutlineWithDraft,
  propose_outline_patch: handleProposeOutlinePatch,
  propose_document: handleProposeDocument,
  propose_document_patch: handleProposeDocumentPatch,
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
    return JSON.stringify({ error: "工具参数不是有效 JSON" });
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
