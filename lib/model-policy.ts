// Pinned release: jev-preview points here on 2026-10-15; jev-latest still points to 1.13.
export const DEFAULT_MODEL = "jev-1.14.0";
// Application byte budgets, NOT tokenizer counts or API token limits.
// Defaults: 64k tokens/request, 32k/question. Opt-in long context: 262k for both.
export const STANDARD_REQUEST_BYTES = 28_000;
export const LONG_REQUEST_BYTES = 224_000;
export const LONG_CONTEXT_HEADER = "TypeSafe-Danger-Zone-Long-Context";
export type ContextMode = "standard" | "long";
export function supportsLongContext(model: string) {
  return ["jev-1.13.0", "jev-1.14.0", "jev-latest", "jev-preview"].includes(model);
}
export function contextModeFor(model: string, requestBytes: number): ContextMode {
  return supportsLongContext(model) && requestBytes > STANDARD_REQUEST_BYTES ? "long" : "standard";
}
