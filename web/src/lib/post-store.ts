import fs from "node:fs/promises";
import path from "node:path";
import type { FetchLike, Post } from "./post";

const IMAGE_HOST = "pbs.twimg.com";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 8;
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface SavedPost {
  dir: string;
  mdPath: string;
  title: string;
  images: string[];
  warnings: string[];
}

/** First line of the post, safe for a file name. */
export function postTitle(text: string): string {
  const first = (text.split("\n").find((line) => line.trim()) ?? "post").replace(/https?:\/\/\S+/g, "").trim();
  const clean = first.replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return (clean.length > 70 ? `${clean.slice(0, 67)}...` : clean) || "post";
}

/** Only X's own image host over https: the URL came from a remote response, so don't follow it blindly. */
export function isAllowedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === IMAGE_HOST;
  } catch {
    return false;
  }
}

async function downloadImage(url: string, fetchImpl: FetchLike): Promise<{ bytes: Buffer; ext: string }> {
  if (!isAllowedImageUrl(url)) throw new Error("image host is not allowed");
  const sized = `${url}${url.includes("?") ? "&" : "?"}name=large`;
  const response = await fetchImpl(sized, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = EXTENSIONS[type];
  if (!ext) throw new Error(`unsupported content type "${type}"`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) throw new Error("image is too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image is too large");
  return { bytes, ext };
}

function frontmatter(values: Record<string, string | number>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${typeof value === "number" ? value : JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Writes `<outdir>/twitter-<id>/` in the same shape the CLI uses, so the library and Interpret just work. */
export async function savePost(outdir: string, post: Post, fetchImpl: FetchLike): Promise<SavedPost> {
  const dir = path.join(outdir, `twitter-${post.id}`);
  await fs.mkdir(dir, { recursive: true });

  const warnings: string[] = [];
  const images: string[] = [];
  const wanted = post.images.slice(0, MAX_IMAGES);
  for (const [index, image] of wanted.entries()) {
    try {
      const { bytes, ext } = await downloadImage(image.url, fetchImpl);
      const name = `image-${index + 1}.${ext}`;
      await fs.writeFile(path.join(dir, name), bytes);
      images.push(name);
    } catch (error) {
      warnings.push(`image ${index + 1} was not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const title = postTitle(post.text);
  const date = post.createdAt ? post.createdAt.slice(0, 10) : "";
  const body: string[] = [`# ${title}`, "", post.text || "(no text)"];
  if (post.quoted) {
    body.push("", `> Quoted post by @${post.quoted.handle}:`, ...post.quoted.text.split("\n").map((line) => `> ${line}`));
  }
  if (post.images.length > 0) {
    body.push("", "## Images");
    for (const [index, image] of post.images.entries()) {
      const saved = images.find((name) => name.startsWith(`image-${index + 1}.`));
      body.push(`- image ${index + 1}${saved ? ` (saved as ${saved})` : " (not saved)"}${image.alt ? `: alt text: ${image.alt}` : ""}`);
    }
  }
  if (warnings.length > 0) body.push("", ...warnings.map((w) => `> note: ${w}`));

  const mdPath = path.join(dir, `${post.handle} - ${title} [${post.id}].md`);
  const head = frontmatter({
    source_url: post.sourceUrl,
    extractor: "Twitter",
    id: post.id,
    kind: "post",
    title: `@${post.handle} - ${title}`,
    uploader: post.name || post.handle,
    upload_date: date,
    ...(post.lang ? { language: post.lang } : {}),
    image_count: images.length,
    transcribed_at: new Date().toISOString(),
    tool: "transcribe-url web (post reader)",
  });
  await fs.writeFile(mdPath, `${head}\n${body.join("\n")}\n`, "utf8");
  return { dir, mdPath, title, images, warnings };
}
