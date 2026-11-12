import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobManager, type JobMessage } from "@/lib/jobs";

const FAKE = path.resolve(import.meta.dirname, "fixtures/fake-transcribe.sh");

function collect(manager: JobManager, id: string): JobMessage[] {
  const seen: JobMessage[] = [];
  manager.subscribe(id, (m) => seen.push(m));
  return seen;
}

describe("JobManager", () => {
  it("runs a job, streams the CLI events, and passes a safe argv", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tu-jobs-"));
    process.env.FAKE_ARGS_FILE = path.join(dir, "args.txt");
    const manager = new JobManager({ bin: FAKE, outdir: "/out" });
    const job = manager.enqueue("https://x.com/u/status/1");
    const seen = collect(manager, job.id);
    await manager.idle();

    expect(manager.get(job.id)?.status).toBe("done");
    const names = seen.map((m) => (m.event === "job" ? `job:${String(m.status)}` : m.event));
    expect(names).toEqual(expect.arrayContaining(["job:queued", "job:running", "start", "stage", "item", "done", "job:done"]));
    // the line that was split across two writes arrived intact
    expect(seen.find((m) => m.event === "stage")?.name).toBe("download");

    const args = (await fs.readFile(process.env.FAKE_ARGS_FILE, "utf8")).trim().split("\n");
    expect(args).toEqual(["--json-events", "--emit", "md", "--index", "-o", "/out", "--", "https://x.com/u/status/1"]);
    delete process.env.FAKE_ARGS_FILE;
  });

  it("passes --force to the CLI only when asked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tu-jobs-"));
    process.env.FAKE_ARGS_FILE = path.join(dir, "args.txt");
    const manager = new JobManager({ bin: FAKE, outdir: "/out" });
    manager.enqueue("https://example.com/v", { force: true });
    await manager.idle();
    const args = (await fs.readFile(process.env.FAKE_ARGS_FILE, "utf8")).trim().split("\n");
    expect(args).toEqual(["--json-events", "--emit", "md", "--index", "--force", "-o", "/out", "--", "https://example.com/v"]);
    delete process.env.FAKE_ARGS_FILE;
  });

  it("passes --playlist to the CLI only when asked, and reports both flags in the job view", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tu-jobs-"));
    process.env.FAKE_ARGS_FILE = path.join(dir, "args.txt");
    const manager = new JobManager({ bin: FAKE, outdir: "/out" });
    const url = "https://www.youtube.com/watch?v=abc&list=PLx";
    const job = manager.enqueue(url, { force: true, playlist: true });
    expect(job).toMatchObject({ force: true, playlist: true });
    await manager.idle();
    const args = (await fs.readFile(process.env.FAKE_ARGS_FILE, "utf8")).trim().split("\n");
    expect(args).toEqual(["--json-events", "--emit", "md", "--index", "--force", "--playlist", "-o", "/out", "--", url]);
    delete process.env.FAKE_ARGS_FILE;
  });

  it("marks a job failed with the CLI's error message", async () => {
    const manager = new JobManager({ bin: FAKE, outdir: "/out" });
    const job = manager.enqueue("https://x.com/fail");
    await manager.idle();
    expect(manager.get(job.id)).toMatchObject({ status: "failed", error: "boom" });
  });

  it("falls back to the stderr tail when the process dies without an error event", async () => {
    const manager = new JobManager({ bin: FAKE, outdir: "/out" });
    const job = manager.enqueue("https://x.com/silent-crash");
    await manager.idle();
    expect(manager.get(job.id)).toMatchObject({ status: "failed", error: "fatal: something broke" });
  });

  it("reports a missing binary as a failed job", async () => {
    const manager = new JobManager({ bin: "/nonexistent/transcribe-url.sh", outdir: "/out" });
    const job = manager.enqueue("https://x.com/u/status/2");
    await manager.idle();
    const view = manager.get(job.id);
    expect(view?.status).toBe("failed");
    expect(view?.error).toMatch(/could not start/);
  });

  it("de-duplicates an active URL and runs different URLs one at a time", async () => {
    const manager = new JobManager({ bin: FAKE, outdir: "/out" });
    const a = manager.enqueue("https://x.com/a");
    const again = manager.enqueue("https://x.com/a");
    const b = manager.enqueue("https://x.com/b");
    expect(again.id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
    expect(manager.get(b.id)?.status).toBe("queued");
    await manager.idle();
    expect(manager.list().map((j) => j.status)).toEqual(["done", "done"]);
  });

  it("does not swallow a forced or playlist request into a plain job for the same URL", async () => {
    const manager = new JobManager({ bin: FAKE, outdir: "/out" });
    const url = "https://www.youtube.com/watch?v=abc&list=PLx";
    const plain = manager.enqueue(url);
    const whole = manager.enqueue(url, { playlist: true });
    const forced = manager.enqueue(url, { force: true });
    expect(new Set([plain.id, whole.id, forced.id]).size).toBe(3);
    expect(manager.enqueue(url, { playlist: true }).id).toBe(whole.id);
    expect(manager.enqueue(url).id).toBe(plain.id);
    await manager.idle();
  });

  it("returns null when subscribing to an unknown job and replays history to late subscribers", async () => {
    const manager = new JobManager({ bin: FAKE, outdir: "/out" });
    expect(manager.subscribe("nope", () => undefined)).toBeNull();
    const job = manager.enqueue("https://x.com/late");
    await manager.idle();
    const replay = collect(manager, job.id);
    expect(replay.at(-1)).toMatchObject({ event: "job", status: "done" });
  });
});
