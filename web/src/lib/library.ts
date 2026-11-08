import fs from "node:fs/promises";
import path from "node:path";

export type Meta = Record<string, string>;

export interface SourceSummary {
  slug: string;
  title: string;
  uploader: string;
  uploadDate: string;
  duration: string;
  language: string;
  sourceUrl: string;
  extractor: string;
  hasBrief: boolean;
  /** Sort key (ms since epoch). */
  sortKey: number;
}

export interface SourceDetail extends SourceSummary {
  meta: Meta;
  body: string;
  brief: string | null;
  mdFile: string;
}

/** yt-dlp titles sometimes carry HTML entities (`Build &amp; Automate`); React would show them literally. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Slugs are folder names such as `twitter-2117296186533257223` or `twitter:spaces-…`. */
export function isSafeSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/.test(slug) && !slug.includes("..");
}

export function resolveSourceDir(outdir: string, slug: string): string | null {
  if (!isSafeSlug(slug)) return null;
  const root = path.resolve(outdir);
  const dir = path.resolve(root, slug);
  return dir.startsWith(root + path.sep) ? dir : null;
}

/** Minimal parser for the flat `key: "value"` frontmatter the CLI writes. */
export function parseFrontmatter(text: string): { meta: Meta; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Meta = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] as string;
    let value = (kv[2] ?? "").trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.replace(/^"|"$/g, "");
      }
    }
    meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

export function briefPathFor(mdPath: string): string {
  return mdPath.replace(/\.md$/, ".brief.md");
}

async function findTranscriptMd(dir: string): Promise<string | null> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const md = names.filter((n) => n.endsWith(".md") && !n.endsWith(".brief.md")).sort();
  return md[0] ? path.join(dir, md[0]) : null;
}

function summarise(slug: string, meta: Meta, hasBrief: boolean, mtimeMs: number): SourceSummary {
  const transcribedAt = Date.parse(meta.transcribed_at ?? "");
  return {
    slug,
    title: decodeEntities(meta.title || slug),
    uploader: decodeEntities(meta.uploader ?? ""),
    uploadDate: meta.upload_date ?? "",
    duration: meta.duration ?? "",
    language: meta.language ?? "",
    sourceUrl: meta.source_url ?? "",
    extractor: meta.extractor ?? slug.split("-")[0] ?? "",
    hasBrief,
    sortKey: Number.isFinite(transcribedAt) ? transcribedAt : mtimeMs,
  };
}

export async function listSources(outdir: string): Promise<SourceSummary[]> {
  const entries = await fs.readdir(outdir, { withFileTypes: true }).catch(() => []);
  const out: SourceSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSlug(entry.name)) continue;
    const dir = path.join(outdir, entry.name);
    const md = await findTranscriptMd(dir);
    if (!md) continue;
    const [text, stat, brief] = await Promise.all([
      fs.readFile(md, "utf8"),
      fs.stat(md),
      fs.stat(briefPathFor(md)).then(() => true, () => false),
    ]);
    out.push(summarise(entry.name, parseFrontmatter(text).meta, brief, stat.mtimeMs));
  }
  return out.sort((a, b) => b.sortKey - a.sortKey);
}

export async function readSource(outdir: string, slug: string): Promise<SourceDetail | null> {
  const dir = resolveSourceDir(outdir, slug);
  if (!dir) return null;
  const md = await findTranscriptMd(dir);
  if (!md) return null;
  const text = await fs.readFile(md, "utf8");
  const stat = await fs.stat(md);
  const { meta, body } = parseFrontmatter(text);
  const brief = await fs.readFile(briefPathFor(md), "utf8").catch(() => null);
  return { ...summarise(slug, meta, brief !== null, stat.mtimeMs), meta, body, brief, mdFile: md };
}

export async function writeBrief(mdFile: string, content: string): Promise<void> {
  await fs.writeFile(briefPathFor(mdFile), content, "utf8");
}
