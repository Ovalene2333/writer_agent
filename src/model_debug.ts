import process from "node:process";
import type { AgentEvent } from "./types.js";

export function modelDebugEnabled(): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env.WRITER_DEBUG ?? "");
}

/** Step trail logging: enabled by WRITER_DEBUG or dedicated WRITER_DEBUG_STEPS. */
export function stepDebugEnabled(): boolean {
  if (modelDebugEnabled()) return true;
  return /^(?:1|true|yes|on)$/i.test(process.env.WRITER_DEBUG_STEPS ?? "");
}

export function logModelRequest(endpoint: string, body: string): void {
  if (!modelDebugEnabled()) return;
  process.stderr.write(`\n[WRITER DEBUG] REQUEST ${endpoint}\n${body}\n[WRITER DEBUG] END REQUEST\n`);
}

export function logModelResponse(endpoint: string, body: string): void {
  if (!modelDebugEnabled()) return;
  process.stderr.write(`\n[WRITER DEBUG] RESPONSE ${endpoint}\n${body}\n[WRITER DEBUG] END RESPONSE\n`);
}

type StepBuffer = {
  step: number;
  tools: string[];
  output: string;
  reasoning: string;
  startedAt: number;
};

export type AgentStepDebugLogger = {
  /** Feed every AgentEvent from a single job/run. */
  onEvent: (event: AgentEvent) => void;
  /** Force-flush any open step (e.g. on unexpected exit). */
  flush: () => void;
};

/**
 * Pretty-print agent step content to stderr for paste/analysis.
 * Buffers streaming text until step_done so the CLI is readable.
 */
export function createAgentStepDebugLogger(meta?: {
  sessionId?: string;
  jobId?: string;
  label?: string;
}): AgentStepDebugLogger {
  let current: StepBuffer | null = null;
  const sessionTag = meta?.sessionId ? meta.sessionId.slice(0, 8) : "local";
  const jobTag = meta?.jobId ? meta.jobId.slice(0, 8) : "-";
  const label = meta?.label?.trim() || "agent";

  const write = (line: string) => {
    process.stderr.write(`${line.endsWith("\n") ? line : `${line}\n`}`);
  };

  const header = (title: string) => {
    write(`\n[WRITER STEP] ══ ${title} ══  session=${sessionTag} job=${jobTag} (${label})`);
  };

  const flush = (doneStep?: number) => {
    if (!current) return;
    const buf = current;
    current = null;
    const stepNo = doneStep ?? buf.step;
    const elapsedMs = Date.now() - buf.startedAt;
    header(`Step ${stepNo} done (${elapsedMs}ms)`);
    if (buf.tools.length) {
      write(`[WRITER STEP] tools: ${buf.tools.join(", ")}`);
    } else {
      write(`[WRITER STEP] tools: (none)`);
    }
    const reasoning = buf.reasoning.trim();
    const output = buf.output.trim();
    if (reasoning) {
      write(`[WRITER STEP] --- reasoning ---`);
      write(reasoning);
      write(`[WRITER STEP] --- end reasoning ---`);
    } else {
      write(`[WRITER STEP] reasoning: (empty)`);
    }
    if (output) {
      write(`[WRITER STEP] --- output ---`);
      write(output);
      write(`[WRITER STEP] --- end output ---`);
    } else {
      write(`[WRITER STEP] output: (empty)`);
    }
    write(`[WRITER STEP] ── end step ${stepNo} ──`);
  };

  const onEvent = (event: AgentEvent) => {
    if (!stepDebugEnabled()) return;

    switch (event.type) {
      case "step_start": {
        flush();
        current = {
          step: event.step,
          tools: [],
          output: "",
          reasoning: "",
          startedAt: Date.now(),
        };
        header(`Step ${event.step} start`);
        break;
      }
      case "text": {
        if (!current) {
          current = { step: 0, tools: [], output: "", reasoning: "", startedAt: Date.now() };
        }
        if (event.channel === "reasoning") current.reasoning += event.text;
        else current.output += event.text;
        break;
      }
      case "tool": {
        if (!current) {
          current = { step: 0, tools: [], output: "", reasoning: "", startedAt: Date.now() };
        }
        current.tools.push(event.name);
        write(`[WRITER STEP] tool → ${event.name}`);
        break;
      }
      case "step_done": {
        flush(event.step);
        break;
      }
      case "proposal": {
        write(
          `[WRITER STEP] proposal #${event.proposal.id} path=${event.proposal.path} summary=${event.proposal.summary}`,
        );
        break;
      }
      case "character": {
        write(`[WRITER STEP] character saved: ${event.character.name} (#${event.character.id})`);
        break;
      }
      case "waiting_for_input": {
        flush();
        header("waiting_for_input");
        write(`[WRITER STEP] question: ${event.question}`);
        if (event.options?.length) write(`[WRITER STEP] options: ${event.options.join(" | ")}`);
        break;
      }
      case "done": {
        flush();
        header(`done`);
        write(`[WRITER STEP] sessionId=${event.sessionId}`);
        break;
      }
      case "cancelled": {
        flush();
        header(`cancelled`);
        write(`[WRITER STEP] sessionId=${event.sessionId}`);
        break;
      }
      case "error": {
        flush();
        header(`error`);
        write(`[WRITER STEP] ${event.message}`);
        break;
      }
      case "usage": {
        // Keep usage quiet unless full model debug is on (noisy for step-focused dumps).
        if (modelDebugEnabled()) {
          write(
            `[WRITER STEP] usage tokens=${event.usage.totalTokens} cost=${event.usage.currency}${event.usage.cost.toFixed(4)}`,
          );
        }
        break;
      }
      default:
        break;
    }
  };

  return { onEvent, flush };
}

/** One-shot helper when you only need to log without managing a logger instance. */
export function logAgentEvent(event: AgentEvent, logger?: AgentStepDebugLogger): void {
  if (logger) {
    logger.onEvent(event);
    return;
  }
  // Fallback singleton for simple CLI paths (not concurrent-safe across jobs).
  defaultStepLogger.onEvent(event);
}

const defaultStepLogger = createAgentStepDebugLogger({ label: "default" });
