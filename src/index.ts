/**
 * marzi — run LLM-generated widgets safely inside your web app.
 *
 * In 0.1.0, registering a capability is the authorization: every capability
 * passed to `createRuntime` is callable by every widget. Per-widget grants are
 * designed and scheduled for the next release (see the README).
 *
 * This file is the whole public API: every name a host can import is listed
 * here, and nothing else. The runtime is in runtime.ts, the types in types/,
 * the constants in consts/, the helpers in helpers/, and the storage contract
 * in store.ts. types/ also holds internal types; only the names below are
 * public.
 */

export { DEFAULT_FORBIDDEN_TEXT, VERSION } from "./consts/runtime.js";
export { createRuntime } from "./runtime.js";
export { memoryStore } from "./store.js";

export type { CallContext, Capability, CapabilityHandler } from "./types/capability.js";
export type { AuditEvent } from "./types/audit.js";
export type { WidgetFault } from "./types/fault.js";
export type { Runtime, RuntimeOptions } from "./types/runtime.js";
export type { Library, RenderOptions, Widget, WidgetBody } from "./types/widget.js";
export type {
  StateStore,
  WidgetRecord,
  WidgetStore,
  WidgetSummary,
  WidgetVersion,
} from "./store.js";
