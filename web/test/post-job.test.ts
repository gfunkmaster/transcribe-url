import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProgressEvent } from "@/lib/events";
import { createPostHandler } from "@/lib/post-job";
import { JobManager } from "@/lib/jobs";
import { fakeImage, photoTweet, videoTweet } from "./post-fixtures";

const FAKE = path.resolve(import.meta.dirname, "fixtures/fake-transcribe.sh");
let outdir: string;
beforeEach(async () => {
  outdir = await fs.mkdtemp(path.join(os.tmpdir(), "tu-postjob-"));
});
afterEach(async () => {
  await fs.rm(outdir, { recursive: true, force: true });
});

const router = (tweet: unknown) => (url: string) =>
  url.includes("syndication")
    ? Promise.resolve(new Response(JSON.stringify(tweet), { status: 200 }))
    : Promise.resolve(new Response(fakeImage, { status: 200, headers: { "content-type": "image/jpeg" } }));

const run = async (url: string, fetchImpl: (u: string) => Promise<Response>) => {
  const events: ProgressEvent[] = [];
  const result = await createPostHandler({ outdir, fetchImpl })(url, (e) => events.push(e));
  return { result, events };
};

describe("post handler", () => {
  it("reads a photo post and reports the usual event sequence", async () => {
    const { result, events } = await run("https://x.com/someone/status/2116870392300073128", router(photoTweet));
    expect(result).toBe("handled");
    expect(events.map((e) => e.event)).toEqual(["stage", "item", "wrote", "done"]);
    expect(events.at(-1)).toMatchObject({ processed: 1, status: "ok" });
  });

  it("skips a post that is already saved", async () => {
    await run("https://x.com/someone/status/2116870392300073128", router(photoTweet));
    const again = await run("https://x.com/someone/status/2116870392300073128", router(photoTweet));
    expect(again.events.map((e) => e.event)).toEqual(["skip", "done"]);
    expect(again.events.at(-1)).toMatchObject({ skipped: 1 });
  });

  it("passes through videos, non-post URLs and unreadable posts to the CLI", async () => {
    expect((await run("https://x.com/someone/status/2116870392300073128", router(videoTweet))).result).toBe("passthrough");
    expect((await run("https://www.youtube.com/watch?v=abc", router(photoTweet))).result).toBe("passthrough");
    const down = () => Promise.resolve(new Response("", { status: 503 }));
    expect((await run("https://x.com/someone/status/2116870392300073128", down)).result).toBe("passthrough");
  });
});

describe("JobManager with a post handler", () => {
  it("finishes a post job without starting the CLI, and falls back to the CLI otherwise", async () => {
    const manager = new JobManager({
      bin: "/nonexistent/should-not-run.sh",
      outdir,
      postHandler: createPostHandler({ outdir, fetchImpl: router(photoTweet) }),
    });
    const job = manager.enqueue("https://x.com/someone/status/2116870392300073128");
    await manager.idle();
    expect(manager.get(job.id)?.status).toBe("done");

    const fallback = new JobManager({
      bin: FAKE,
      outdir,
      postHandler: createPostHandler({ outdir, fetchImpl: router(videoTweet) }),
    });
    const second = fallback.enqueue("https://x.com/someone/status/2116870392300073128");
    await fallback.idle();
    expect(fallback.get(second.id)?.status).toBe("done"); // the fake CLI ran
  });

  it("fails the job with the handler's message when saving breaks", async () => {
    const manager = new JobManager({
      bin: FAKE,
      outdir,
      postHandler: () => Promise.reject(new Error("disk full")),
    });
    const job = manager.enqueue("https://x.com/a/status/12345");
    await manager.idle();
    expect(manager.get(job.id)).toMatchObject({ status: "failed", error: "disk full" });
  });
});
