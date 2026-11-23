/**
 * The meeting agent = scribe (fast, per speaker turn, records items) + editor (debounced,
 * keeps the diagram and overview consistent with the items). See scribe.ts and editor.ts.
 */
import { Editor, type EditInput } from "./editor.js";
import type { Effort } from "./llm.js";
import { Scribe, type StepInput, type StepResult } from "./scribe.js";

export type { ApplyFn, StepInput, StepResult } from "./scribe.js";
export type { EditInput } from "./editor.js";
export { emptyUsage, mergeUsage, type Usage } from "./llm.js";

export interface AgentConfig {
  /** Scribe model, "<provider>/<id>". */
  model: string;
  effort: Effort;
  /** Editor model (diagram + overview); defaults to the scribe model. */
  editorModel: string;
  editorEffort: Effort;
  maxSteps: number;
  checkpointTurns: number;
  checkpointTokens: number;
  contextLines: number;
}

function effortFrom(v: string | undefined, fallback: Effort): Effort {
  return v === "low" || v === "medium" || v === "high" ? v : fallback;
}

export function configFromEnv(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const model = overrides.model ?? process.env.MODEL ?? "anthropic/claude-sonnet-5-5";
  return {
    model,
    effort: effortFrom(process.env.EFFORT, "medium"),
    editorModel: process.env.EDITOR_MODEL ?? model,
    editorEffort: effortFrom(process.env.EDITOR_EFFORT, "medium"),
    maxSteps: 3,
    checkpointTurns: 40,
    checkpointTokens: 60_000,
    contextLines: 30,
    ...overrides,
    ...(overrides.model && !overrides.editorModel && !process.env.EDITOR_MODEL ? { editorModel: overrides.model } : {}),
  };
}

/** What a session needs from an agent. Tests substitute a fake. */
export interface AgentRuntime {
  config: { model: string; editorModel?: string };
  step(input: StepInput): Promise<StepResult>;
  edit?(input: EditInput): Promise<StepResult>;
}

export class MeetingAgent implements AgentRuntime {
  readonly scribe: Scribe;
  readonly editor: Editor;
  constructor(public config: AgentConfig = configFromEnv()) {
    this.scribe = new Scribe(config);
    this.editor = new Editor({ model: config.editorModel, effort: config.editorEffort });
  }
  step(input: StepInput): Promise<StepResult> {
    return this.scribe.step(input);
  }
  edit(input: EditInput): Promise<StepResult> {
    return this.editor.run(input);
  }
}
