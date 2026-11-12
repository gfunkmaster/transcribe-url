import { describe, expect, it } from "vitest";
import { validateUrl, videoInPlaylist } from "@/lib/validate";

describe("validateUrl", () => {
  it("accepts http(s) URLs and normalises them", () => {
    expect(validateUrl("  https://x.com/u/status/1  ")).toEqual({ ok: true, url: "https://x.com/u/status/1" });
    expect(validateUrl("http://example.com")).toEqual({ ok: true, url: "http://example.com/" });
  });
  it.each([
    ["non-string", 42],
    ["empty", "   "],
    ["option-looking", "--cookies-from-browser"],
    ["flag with value", "-o /etc"],
    ["local path", "/etc/passwd"],
    ["file URL", "file:///etc/passwd"],
    ["javascript URL", "javascript:alert(1)"],
    ["whitespace inside", "https://a.com/x y"],
    ["newline inside", "https://a.com/\n--force"],
    ["no scheme", "x.com/user/status/1"],
    ["too long", "https://a.com/" + "a".repeat(2100)],
  ])("rejects %s", (_name, input) => {
    expect(validateUrl(input).ok).toBe(false);
  });
});

describe("videoInPlaylist", () => {
  it("is true only for a URL naming both a video and a playlist", () => {
    expect(videoInPlaylist("https://www.youtube.com/watch?v=abc&list=PLx&index=2")).toBe(true);
    expect(videoInPlaylist("https://youtu.be/abc?list=PLx")).toBe(true);
    expect(videoInPlaylist("https://www.youtube.com/playlist?list=PLx")).toBe(false);
    expect(videoInPlaylist("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(videoInPlaylist("not a url")).toBe(false);
  });
});
