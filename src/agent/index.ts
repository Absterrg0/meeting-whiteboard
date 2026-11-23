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
  /**
   * Model for the periodic consolidation pass and the end-of-meeting review (defaults to the
   * scribe model). With a small fast scribe this is where a stronger model fixes judgement.
   */
  reviewModel: string;
  /** Effort for the periodic consolidation pass and the end-of-meeting review. */
  reviewEffort: Effort;
  /** Scribe turns without upfront thinking (Sonnet 5.5 only); consolidation/review still think. */
  fastThinking: boolean;
  maxSteps: number;
  checkpointTurns: number;
  checkpointTokens: number;
  contextLines: number;
}

function effortFrom(v: string | undefined, fallback: Effort): Effort {
  return v === "low" || v === "medium" || v === "high" ? v : fallback;
}

/** A small, fast model of the same provider for the editor's structured diagram work. */
function defaultEditorModel(model: string): string {
  if (model.startsWith("anthropic/") || model.startsWith("claude")) return "anthropic/claude-haiku-5-5";
  if (model.startsWith("openai/") || model.startsWith("gpt")) return "openai/gpt-6-luna";
  return model;
}

export function configFromEnv(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const model = overrides.model ?? process.env.MODEL ?? "anthropic/claude-sonnet-5-5";
  return {
    model,
    effort: effortFrom(process.env.EFFORT, "medium"),
    editorModel: process.env.EDITOR_MODEL ?? defaultEditorModel(model),
    editorEffort: effortFrom(process.env.EDITOR_EFFORT, "low"),
    reviewModel: process.env.REVIEW_MODEL ?? model,
    reviewEffort: effortFrom(process.env.REVIEW_EFFORT, "low"),
    fastThinking: process.env.FAST_THINKING === "1",
    maxSteps: 3,
    checkpointTurns: 40,
    checkpointTokens: 60_000,
    contextLines: 30,
    ...overrides,
    ...(overrides.model && !overrides.editorModel && !process.env.EDITOR_MODEL ? { editorModel: defaultEditorModel(overrides.model) } : {}),
    ...(overrides.model && !overrides.reviewModel && !process.env.REVIEW_MODEL ? { reviewModel: overrides.model } : {}),
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
