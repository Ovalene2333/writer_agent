import { randomUUID } from "node:crypto";
import { runAgent } from "./agent.js";
import { loadAgentSettings } from "./agent_runtime.js";
import type { WriterProject } from "./project.js";
import type { WriterStore } from "./store.js";
import type { AgentEvent, ModelConfig, PermissionMode } from "./types.js";

type AgentEvalModels = Partial<Record<"agent" | "inline" | "writer" | "reviewer" | "summarizer", ModelConfig>>;

export interface AgentEvaluationExpectation {
  contract?: Partial<Extract<AgentEvent, { type: "task_contract" }>["contract"]>;
  requiredTools?: string[];
  requiredAnyToolGroups?: string[][];
  forbiddenTools?: string[];
  artifact?: "none" | "document" | "character";
  terminal?: "done" | "waiting_for_input";
  maxSteps?: number;
}

export interface AgentEvaluationCase {
  id: string;
  prompt: string;
  permissionMode?: PermissionMode;
  expected: AgentEvaluationExpectation;
}

export const DEFAULT_AGENT_EVALUATION_CASES: AgentEvaluationCase[] = [
  {
    id: "direct-craft-answer",
    prompt: "不结合项目设定，简单说明怎样让人物对白更有潜台词。不要修改文件。",
    permissionMode: "ask",
    expected: {
      contract: { outcome: "answer", evidence: "none", mutation: "none", planning: "direct" },
      forbiddenTools: ["write_file", "edit_file", "move_file", "delete_file", "save_character"],
      artifact: "none",
      terminal: "done",
      maxSteps: 3,
    },
  },
  {
    id: "grounded-project-answer",
    prompt: "灰塔协议对夜间通行有什么限制？请依据项目资料回答。",
    permissionMode: "ask",
    expected: {
      contract: { outcome: "answer", evidence: "project", mutation: "none" },
      requiredTools: ["search_files"],
      artifact: "none",
      terminal: "done",
      maxSteps: 6,
    },
  },
  {
    id: "targeted-rewrite",
    prompt: "把 lore/agent-eval.md 里“任何人都不能在夜间通行”改得更准确：持银色通行证者可以通行。只修改这一句并提交提案。",
    permissionMode: "ask",
    expected: {
      contract: { outcome: "document", evidence: "target", mutation: "document", planning: "adaptive" },
      requiredAnyToolGroups: [
        ["search_files", "read_file"],
        ["edit_file", "write_file"],
      ],
      artifact: "document",
      terminal: "done",
      maxSteps: 10,
    },
  },
];

export function prepareAgentEvaluationFixtures(project: WriterProject): void {
  project.writeTextFile("lore/agent-eval.md", `# 灰塔协议\n\n灰塔协议用于限制城内夜间通行。\n\n任何人都不能在夜间通行。\n\n银色通行证由守夜议会签发。\n`);
}

function compactEvents(events: AgentEvent[]): AgentEvent[] {
  let visibleText = 0;
  const compacted: AgentEvent[] = [];
  for (const event of events) {
    if (event.type !== "text") {
      compacted.push(event);
      continue;
    }
    if (event.channel === "reasoning" || visibleText >= 8_000) continue;
    const text = event.text.slice(0, Math.max(0, 8_000 - visibleText));
    visibleText += text.length;
    if (text) compacted.push({ ...event, text });
  }
  return compacted;
}

export function evaluateAgentEvents(
  events: AgentEvent[],
  expected: AgentEvaluationExpectation,
): { passed: boolean; failures: string[]; observations: Record<string, unknown> } {
  const tools = events.filter((event): event is Extract<AgentEvent, { type: "tool" }> => event.type === "tool").map(event => event.name);
  const contract = events.find((event): event is Extract<AgentEvent, { type: "task_contract" }> => event.type === "task_contract")?.contract;
  const failures: string[] = [];
  for (const name of expected.requiredTools ?? []) if (!tools.includes(name)) failures.push(`missing tool: ${name}`);
  for (const group of expected.requiredAnyToolGroups ?? []) {
    if (!group.some(name => tools.includes(name))) failures.push(`missing any tool: ${group.join("|")}`);
  }
  for (const name of expected.forbiddenTools ?? []) if (tools.includes(name)) failures.push(`forbidden tool: ${name}`);
  if (expected.contract) {
    if (!contract) failures.push("missing task contract event");
    else for (const [key, value] of Object.entries(expected.contract)) {
      if (JSON.stringify(contract[key as keyof typeof contract]) !== JSON.stringify(value)) {
        failures.push(`contract.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(contract[key as keyof typeof contract])}`);
      }
    }
  }
  const terminal = events.some(event => event.type === "done") ? "done"
    : events.some(event => event.type === "waiting_for_input") ? "waiting_for_input" : "none";
  if (expected.terminal && terminal !== expected.terminal) failures.push(`terminal: expected ${expected.terminal}, got ${terminal}`);
  const documentArtifact = events.some(event => event.type === "proposal" || event.type === "change_set");
  const characterArtifact = events.some(event => event.type === "character");
  if (expected.artifact === "none" && (documentArtifact || characterArtifact)) failures.push("unexpected artifact");
  if (expected.artifact === "document" && !documentArtifact) failures.push("missing document artifact");
  if (expected.artifact === "character" && !characterArtifact) failures.push("missing character artifact");
  const steps = events.filter(event => event.type === "step_start").length;
  if (expected.maxSteps !== undefined && steps > expected.maxSteps) failures.push(`steps: ${steps} > ${expected.maxSteps}`);
  const errors = events.filter((event): event is Extract<AgentEvent, { type: "error" }> => event.type === "error").map(event => event.message);
  if (errors.length) failures.push(...errors.map(error => `agent error: ${error}`));
  return {
    passed: failures.length === 0,
    failures,
    observations: { tools, contract, terminal, documentArtifact, characterArtifact, steps, errors },
  };
}

export async function runPersistedAgentEvaluation(input: {
  project: WriterProject;
  store: WriterStore;
  models: AgentEvalModels;
  providerSource: string;
  cases?: AgentEvaluationCase[];
  onCase?: (result: { caseId: string; passed: boolean; failures: string[] }) => void;
}): Promise<ReturnType<WriterStore["finishAgentEvaluationRun"]>> {
  const agentModel = input.models.agent;
  if (!agentModel) throw new Error("Agent evaluation 缺少 agent 模型");
  const cases = input.cases?.length ? input.cases : DEFAULT_AGENT_EVALUATION_CASES;
  const run = input.store.createAgentEvaluationRun(input.providerSource, agentModel.model);
  let passed = 0;
  let failed = 0;
  try {
    for (const item of cases) {
      const sessionId = input.store.createSession(`[eval] ${item.id}`);
      const events: AgentEvent[] = [];
      let thrown: string | undefined;
      try {
        await runAgent({
          project: input.project,
          store: input.store,
          sessionId,
          jobId: `eval:${run.id}:${item.id}:${randomUUID()}`,
          prompt: item.prompt,
          permissionMode: item.permissionMode ?? "ask",
          scenePipelineSettings: loadAgentSettings(input.project).scenePipeline,
          models: input.models,
          onEvent: event => events.push(event),
        });
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      const evaluated = evaluateAgentEvents(events, item.expected);
      if (thrown) evaluated.failures.push(`thrown: ${thrown}`);
      const casePassed = evaluated.failures.length === 0;
      if (casePassed) passed += 1; else failed += 1;
      input.store.recordAgentEvaluationCase({
        runId: run.id,
        caseId: item.id,
        sessionId,
        prompt: item.prompt,
        status: casePassed ? "passed" : thrown ? "error" : "failed",
        expected: item.expected as Record<string, unknown>,
        result: { ...evaluated.observations, failures: evaluated.failures, thrown },
        events: compactEvents(events),
      });
      input.onCase?.({ caseId: item.id, passed: casePassed, failures: evaluated.failures });
    }
    return input.store.finishAgentEvaluationRun(run.id, failed ? "failed" : "passed", {
      total: cases.length,
      passed,
      failed,
    });
  } catch (error) {
    input.store.finishAgentEvaluationRun(run.id, "error", {
      total: cases.length,
      passed,
      failed,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
