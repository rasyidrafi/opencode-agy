/**
 * Attachment policy based on the documented headless contract: stream-json
 * stdin accepts strings or `text` blocks only. Interactive `agy` can paste
 * images/video, but the headless protocol does not define a portable file or
 * binary block shape for this adapter.
 */
export const AGY_ATTACHMENT_POLICY = {
  acceptedInputParts: ["text", "input_text"] as const,
  rejectedInputParts: ["image_url", "input_image", "file", "audio", "video", "pdf"] as const,
  materialization: "deferred",
  remoteUrls: "not-forwarded",
} as const;

export function attachmentPolicyExplanation(): string {
  return [
    "The official agy headless stream-json protocol accepts text strings or text blocks only.",
    "Interactive clipboard media support is not a documented headless input shape.",
    "opencode-agy therefore rejects media explicitly instead of silently dropping it.",
    "No local attachment is copied into a project and no remote URL is fetched or forwarded.",
  ].join(" ");
}
