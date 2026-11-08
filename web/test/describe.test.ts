import { describe, expect, it } from "vitest";
import { describeEvent, isFailure } from "@/lib/describe";

describe("describeEvent", () => {
  it("renders known events and hides unknown ones", () => {
    expect(describeEvent({ event: "wrote", path: "/a/b/c.md", format: "rendered" })).toBe("wrote c.md");
    expect(describeEvent({ event: "error", stage: "download", message: "boom" })).toBe("error [download]: boom");
    expect(describeEvent({ event: "job", status: "failed", error: "x" })).toBe("job failed: x");
    expect(describeEvent({ event: "index", path: "/x" })).toBeNull();
  });
  it("detects failures", () => {
    expect(isFailure({ event: "error", message: "m" })).toBe(true);
    expect(isFailure({ event: "job", status: "failed" })).toBe(true);
    expect(isFailure({ event: "job", status: "done" })).toBe(false);
  });
});
