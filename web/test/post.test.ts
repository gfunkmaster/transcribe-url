import { describe, expect, it } from "vitest";
import { fetchPost, parsePost, parseTweetUrl, PostError, syndicationToken } from "@/lib/post";
import { photoTweet, quoteTweet, tombstone, videoTweet } from "./post-fixtures";

describe("parseTweetUrl", () => {
  it.each([
    ["https://x.com/user/status/2116870392300073128", "2116870392300073128"],
    ["https://twitter.com/user/status/2116870392300073128?s=20", "2116870392300073128"],
    ["https://mobile.twitter.com/user/status/2116870392300073128/photo/1", "2116870392300073128"],
    ["https://x.com/i/status/2116870392300073128", "2116870392300073128"],
  ])("accepts %s", (url, id) => {
    expect(parseTweetUrl(url)).toEqual({ id });
  });
  it.each([
    "https://x.com/user",
    "https://x.com/user/status/abc",
    "https://evil.com/user/status/2116870392300073128",
    "https://x.com.evil.com/user/status/2116870392300073128",
    "https://x.com/user/likes/2116870392300073128",
    "not a url",
  ])("rejects %s", (url) => {
    expect(parseTweetUrl(url)).toBeNull();
  });
});

describe("syndicationToken", () => {
  it("is a base-36 string without zeros or dots", () => {
    const token = syndicationToken("2116870392300073128");
    expect(token).toMatch(/^[1-9a-z]+$/);
  });
});

describe("parsePost", () => {
  it("applies display_text_range per code point, expands links, drops the media link, decodes entities", () => {
    const post = parsePost(photoTweet, "1");
    expect(post.text).toBe("🔥 Tips & tricks: see https://example.com/guide for more");
    expect(post.name).toBe("Some & One");
    expect(post.handle).toBe("someone");
    expect(post.hasVideo).toBe(false);
    expect(post.images).toEqual([
      { url: "https://pbs.twimg.com/media/AAA.jpg", alt: "A chart of results" },
      { url: "https://pbs.twimg.com/media/BBB.png" },
    ]);
    expect(post.sourceUrl).toBe("https://x.com/someone/status/2116870392300073128");
  });

  it("detects video and reads a quoted post with its images", () => {
    expect(parsePost(videoTweet, "1").hasVideo).toBe(true);
    const quoted = parsePost(quoteTweet, "1").quoted;
    expect(quoted).toMatchObject({ handle: "original", text: "the original take" });
    expect(quoted?.images).toHaveLength(1);
  });

  it("explains tombstones and empty payloads", () => {
    expect(() => parsePost(tombstone, "1")).toThrow(/unavailable/);
    expect(() => parsePost({}, "1")).toThrow(PostError);
  });
});

describe("fetchPost", () => {
  const ok = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it("requests the embed endpoint with id and token and parses the result", async () => {
    let requested = "";
    const post = await fetchPost("2116870392300073128", (url) => {
      requested = url;
      return ok(photoTweet)();
    });
    expect(requested).toContain("cdn.syndication.twimg.com/tweet-result?id=2116870392300073128");
    expect(requested).toContain(`token=${syndicationToken("2116870392300073128")}`);
    expect(post.images).toHaveLength(2);
  });

  it("maps 404, other statuses, network errors and bad JSON to PostError", async () => {
    await expect(fetchPost("1", () => Promise.resolve(new Response("", { status: 404 })))).rejects.toThrow(/not found or not public/);
    await expect(fetchPost("1", () => Promise.resolve(new Response("", { status: 503 })))).rejects.toThrow(/HTTP 503/);
    await expect(fetchPost("1", () => Promise.reject(new TypeError("fetch failed")))).rejects.toThrow(/could not reach X/);
    await expect(fetchPost("1", () => Promise.resolve(new Response("<html>", { status: 200 })))).rejects.toThrow(/unreadable/);
  });
});
