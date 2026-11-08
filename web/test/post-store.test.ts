import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSources, readSource } from "@/lib/library";
import { parsePost } from "@/lib/post";
import { isAllowedImageUrl, postTitle, savePost } from "@/lib/post-store";
import { fakeImage, photoTweet, quoteTweet } from "./post-fixtures";

let outdir: string;
beforeEach(async () => {
  outdir = await fs.mkdtemp(path.join(os.tmpdir(), "tu-post-"));
});
afterEach(async () => {
  await fs.rm(outdir, { recursive: true, force: true });
});

const imageFetch = (type = "image/jpeg") => () =>
  Promise.resolve(new Response(fakeImage, { status: 200, headers: { "content-type": type } }));

describe("postTitle / isAllowedImageUrl", () => {
  it("makes a short, file-safe title without links", () => {
    expect(postTitle("Hello: world/for\\all https://t.co/x\nsecond line")).toBe("Hello world for all");
    expect(postTitle("a".repeat(100))).toHaveLength(70);
    expect(postTitle("")).toBe("post");
  });
  it("allows only https pbs.twimg.com", () => {
    expect(isAllowedImageUrl("https://pbs.twimg.com/media/A.jpg")).toBe(true);
    for (const bad of ["http://pbs.twimg.com/a.jpg", "https://evil.com/a.jpg", "https://pbs.twimg.com.evil.com/a.jpg", "file:///etc/passwd", "x"]) {
      expect(isAllowedImageUrl(bad)).toBe(false);
    }
  });
});

describe("savePost", () => {
  it("writes frontmatter + body + images that the library reads back as a post", async () => {
    const saved = await savePost(outdir, parsePost(photoTweet, "1"), imageFetch());
    expect(path.basename(saved.dir)).toBe("twitter-2116870392300073128");
    expect(saved.images).toEqual(["image-1.jpg", "image-2.jpg"]);
    expect(saved.warnings).toEqual([]);

    const list = await listSources(outdir);
    expect(list[0]).toMatchObject({ slug: "twitter-2116870392300073128", kind: "post", extractor: "Twitter" });
    const detail = await readSource(outdir, "twitter-2116870392300073128");
    expect(detail?.images).toEqual(["image-1.jpg", "image-2.jpg"]);
    expect(detail?.meta.source_url).toBe("https://x.com/someone/status/2116870392300073128");
    expect(detail?.body).toContain("Tips & tricks");
    expect(detail?.body).toContain("alt text: A chart of results");
  });

  it("keeps going when an image fails and records why; refuses foreign hosts and bad types", async () => {
    const post = parsePost(photoTweet, "1");
    post.images.push({ url: "https://evil.com/x.jpg" });
    const failing = (url: string) => (url.includes("BBB") ? Promise.reject(new Error("boom")) : imageFetch()());
    const saved = await savePost(outdir, post, failing);
    expect(saved.images).toEqual(["image-1.jpg"]);
    expect(saved.warnings.join("\n")).toMatch(/image 2 was not saved: boom/);
    expect(saved.warnings.join("\n")).toMatch(/image 3 was not saved: image host is not allowed/);

    const other = await savePost(outdir, parsePost({ ...photoTweet, id_str: "5" }, "5"), imageFetch("text/html"));
    expect(other.images).toEqual([]);
    expect(other.warnings[0]).toMatch(/unsupported content type/);
  });

  it("includes a quoted post", async () => {
    const saved = await savePost(outdir, parsePost(quoteTweet, "1"), imageFetch());
    const text = await fs.readFile(saved.mdPath, "utf8");
    expect(text).toContain("> Quoted post by @original:");
    expect(text).toContain("> the original take");
  });
});
