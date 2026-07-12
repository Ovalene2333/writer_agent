import type { AgentEvent, PermissionMode } from "../types.js";
import type { WriterProject } from "../project.js";
import type { WriterStore } from "../store.js";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ToolExecutionContext = {
  permissionMode: PermissionMode;
};

export type ToolHandlerArgs = {
  input: Record<string, unknown>;
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  emit: (event: AgentEvent) => void;
  characterScope?: number[];
  context: ToolExecutionContext;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
