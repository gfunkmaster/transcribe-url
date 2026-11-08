import fs from "node:fs/promises";
import path from "node:path";
import type { ProgressEvent } from "./events";
import { fetchPost, parseTweetUrl, PostError, type FetchLike } from "./post";
import { savePost } from "./post-store";

/**
 * 'handled' = the post was read and saved, no CLI run needed.
 * 'passthrough' = not a post, has a video, or X could not be read: let the CLI try.
 */
export type PostHandler = (url: string, emit: (event: ProgressEvent) => void) => Promise<"handled" | "passthrough">;

export function createPostHandler(options: { outdir: string; fetchImpl?: FetchLike }): PostHandler {
  return async (url, emit) => {
    const parsed = parseTweetUrl(url);
    if (!parsed) return "passthrough";

    let post;
    try {
      post = await fetchPost(parsed.id, options.fetchImpl);
    } catch (error) {
      if (error instanceof PostError) return "passthrough";
      throw error;
    }
    if (post.hasVideo) return "passthrough";

    const dir = path.join(options.outdir, `twitter-${post.id}`);
    const existing = await fs.readdir(dir).catch(() => [] as string[]);
    if (existing.some((name) => name.endsWith(".md") && !name.endsWith(".brief.md"))) {
      emit({ event: "skip", input: url, reason: "already saved" });
      emit({ event: "done", processed: 0, skipped: 1, outdir: options.outdir, status: "ok" });
      return "handled";
    }

    emit({ event: "stage", name: "read-post", input: url });
    const saved = await savePost(options.outdir, post, options.fetchImpl ?? ((u, i) => fetch(u, i)));
    emit({ event: "item", title: saved.title, dest: saved.dir });
    emit({ event: "wrote", path: saved.mdPath, format: "post" });
    for (const warning of saved.warnings) emit({ event: "error", stage: "image", message: warning });
    emit({ event: "done", processed: 1, skipped: 0, outdir: options.outdir, status: "ok" });
    return "handled";
  };
}
