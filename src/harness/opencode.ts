// Compatibility API. Internal code imports the owning module directly.
export { createHarness } from "./index.js";
export type { OpenCodeHarnessOptions } from "./opencode/contracts.js";
export { OpenCodeHarness } from "./opencode/harness.js";
export { describeAssistantError, summarizeSessionMessages } from "./opencode/messages.js";
export { buildWorkspaceSystemPrompt, isPathInsideWorkspace } from "./opencode/prompts.js";
