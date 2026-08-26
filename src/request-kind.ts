import { extractTextContent, type HostMessage } from "./prompt.js";

export type MetaRequestKind = "title" | "summary" | null;

function textForRole(messages: HostMessage[], role: string): string {
  return messages
    .filter((message) => message.role === role)
    .map((message) => String(message.content ?? ""))
    .join("\n");
}

export function metaSystemPrompt(messages: HostMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => extractTextContent(message.content))
    .join("\n")
    .toLowerCase();
}

export function isTitleGenerationRequest(messages: HostMessage[]): boolean {
  const system = metaSystemPrompt(messages);
  return system.includes("title generator") ||
    system.includes("generate a short title") ||
    system.includes("generate a brief title") ||
    system.includes("output only a thread title");
}

export function isSummaryGenerationRequest(messages: HostMessage[]): boolean {
  const system = metaSystemPrompt(messages);
  if (system.includes("anchored context summarization") ||
    system.includes("summarizing, compacting, or merging context") ||
    system.includes("tasked with summarizing conversations") ||
    system.includes("write like a pull request description") ||
    system.includes("summarize what was done in this conversation")) return true;
  const user = textForRole(messages, "user").toLowerCase();
  return user.includes("this summary will be the only context available when the conversation continues") ||
    user.includes("create a detailed summary for continuing this coding session") ||
    user.includes("anchored summary from the conversation history") ||
    user.includes("anchored summary below using the conversation history") ||
    user.includes("<previous-summary>");
}

export function detectMetaRequestKind(messages: HostMessage[]): MetaRequestKind {
  if (isTitleGenerationRequest(messages)) return "title";
  if (isSummaryGenerationRequest(messages)) return "summary";
  return null;
}
