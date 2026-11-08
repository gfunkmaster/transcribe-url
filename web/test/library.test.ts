import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEntities, isSafeSlug, listSources, parseFrontmatter, readSource, resolveSourceDir, writeBrief } from "@/lib/library";

let outdir: string;

const doc = (title: string, extra = "") =>
  `---\nsource_url: "https://x.com/u/status/1"\nextractor: "Twitter"\ntitle: ${JSON.stringify(title)}\nuploader: "Someone"\nduration: "66:53"\nlanguage: "en"\n${extra}---\n\n# ${title}\n\n- **00:00** hello\n`;

beforeEach(async () => {
  outdir = await fs.mkdtemp(path.join(os.tmpdir(), "tu-web-"));
});
afterEach(async () => {
  await fs.rm(outdir, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  it("parses quoted values (with escapes) and returns the body", () => {
    const { meta, body } = parseFrontmatter(doc('He said "hi" &amp; left'));
    expect(meta.title).toBe('He said "hi" &amp; left');
    expect(meta.duration).toBe("66:53");
    expect(body).toContain("- **00:00** hello");
  });
  it("returns the whole text when there is no frontmatter", () => {
    expect(parseFrontmatter("just text")).toEqual({ meta: {}, body: "just text" });
  });
});

describe("decodeEntities", () => {
  it("decodes common entities once, with &amp; last so &amp;lt; stays literal", () => {
    expect(decodeEntities("Build &amp; Automate &lt;b&gt; &quot;x&quot; it&#39;s")).toBe("Build & Automate <b> \"x\" it's");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });
});

describe("slug safety", () => {
  it.each(["twitter-123", "twitter:spaces-9", "local-interview.v2"])("accepts %s", (s) => {
    expect(isSafeSlug(s)).toBe(true);
  });
  it.each(["", "..", "../etc", "a/b", "a\\b", ".hidden", "a..b", "/abs"])("rejects %j", (s) => {
    expect(isSafeSlug(s)).toBe(false);
    expect(resolveSourceDir("/srv/out", s)).toBeNull();
  });
});

describe("library", () => {
  it("lists sources newest first, flags briefs, skips folders without .md", async () => {
    await fs.mkdir(path.join(outdir, "twitter-1"));
    await fs.mkdir(path.join(outdir, "twitter-2"));
    await fs.mkdir(path.join(outdir, "empty-3"));
    await fs.writeFile(path.join(outdir, "twitter-1", "a.md"), doc("Old", 'transcribed_at: "2026-01-01T00:00:00Z"\n'));
    await fs.writeFile(path.join(outdir, "twitter-2", "b.md"), doc("New", 'transcribed_at: "2026-02-01T00:00:00Z"\n'));
    await fs.writeFile(path.join(outdir, "twitter-2", "b.brief.md"), "brief");
    await fs.writeFile(path.join(outdir, "index.html"), "<html>");
    const list = await listSources(outdir);
    expect(list.map((s) => [s.slug, s.title, s.hasBrief])).toEqual([
      ["twitter-2", "New", true],
      ["twitter-1", "Old", false],
    ]);
  });

  it("returns an empty list when the output dir does not exist", async () => {
    expect(await listSources(path.join(outdir, "missing"))).toEqual([]);
  });

  it("reads a source, writes a brief next to it, and never reads the brief as the transcript", async () => {
    await fs.mkdir(path.join(outdir, "twitter-1"));
    const md = path.join(outdir, "twitter-1", "a.md");
    await fs.writeFile(md, doc("T"));
    const first = await readSource(outdir, "twitter-1");
    expect(first?.brief).toBeNull();
    await writeBrief(first!.mdFile, "# Brief\n");
    const second = await readSource(outdir, "twitter-1");
    expect(second?.brief).toBe("# Brief\n");
    expect(second?.mdFile).toBe(md);
    expect(second?.body).toContain("hello");
  });

  it("refuses traversal and unknown slugs", async () => {
    expect(await readSource(outdir, "../etc")).toBeNull();
    expect(await readSource(outdir, "nope")).toBeNull();
  });
});
