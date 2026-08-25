import { describe, expect, test } from "bun:test";
import { AGY_ATTACHMENT_POLICY, attachmentPolicyExplanation } from "../src/attachments.js";

describe("documented headless attachment policy", () => {
  test("keeps media unsupported until agy defines a headless shape", () => {
    expect(AGY_ATTACHMENT_POLICY.materialization).toBe("deferred");
    expect(AGY_ATTACHMENT_POLICY.remoteUrls).toBe("not-forwarded");
    expect(attachmentPolicyExplanation()).toContain("rejects media explicitly");
  });
});
