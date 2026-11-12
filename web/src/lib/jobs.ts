import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createEventParser, type ProgressEvent } from "./events";
import type { PostHandler } from "./post-job";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobView {
  id: string;
  url: string;
  status: JobStatus;
  createdAt: number;
  error?: string;
  /** Re-do the work even if the output already exists. */
  force?: boolean;
}

/** What a subscriber receives: the CLI's own events, plus synthetic `job` status events. */
export type JobMessage = ProgressEvent;

interface Job extends JobView {
  events: JobMessage[];
  subscribers: Set<(message: JobMessage) => void>;
}

export interface JobManagerOptions {
  bin: string;
  outdir: string;
  maxHistory?: number;
  /** Optional: read X/Twitter posts without video directly, before falling back to the CLI. */
  postHandler?: PostHandler;
}

const MAX_EVENTS_PER_JOB = 2000;
const STDERR_TAIL = 4096;

/**
 * Runs transcribe-url one job at a time (the model is GPU/memory heavy) and fans its
 * NDJSON events out to subscribers. State is in memory: a server restart forgets jobs,
 * but finished transcripts live on disk and are picked up by the library page.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private running = false;

  constructor(private readonly options: JobManagerOptions) {}

  enqueue(url: string, options: { force?: boolean } = {}): JobView {
    for (const job of this.jobs.values()) {
      if (job.url === url && (job.status === "queued" || job.status === "running")) return view(job);
    }
    const job: Job = {
      id: randomUUID(),
      url,
      status: "queued",
      createdAt: Date.now(),
      ...(options.force ? { force: true } : {}),
      events: [],
      subscribers: new Set(),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.prune();
    this.emit(job, { event: "job", status: "queued" });
    void this.pump();
    return view(job);
  }

  list(): JobView[] {
    return [...this.jobs.values()].map(view).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    return job ? view(job) : undefined;
  }

  /** Replays past events, then streams new ones. Returns an unsubscribe function. */
  subscribe(id: string, listener: (message: JobMessage) => void): (() => void) | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    for (const message of job.events) listener(message);
    job.subscribers.add(listener);
    return () => job.subscribers.delete(listener);
  }

  /** Resolves when no job is queued or running (used by tests). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length > 0) await new Promise((r) => setTimeout(r, 10));
  }

  private emit(job: Job, message: JobMessage) {
    if (job.events.length < MAX_EVENTS_PER_JOB) job.events.push(message);
    for (const subscriber of job.subscribers) subscriber(message);
  }

  private prune() {
    const max = this.options.maxHistory ?? 50;
    const finished = [...this.jobs.values()]
      .filter((j) => j.status === "done" || j.status === "failed")
      .sort((a, b) => a.createdAt - b.createdAt);
    while (this.jobs.size > max && finished.length > 0) {
      const old = finished.shift();
      if (old) this.jobs.delete(old.id);
    }
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
        const job = this.jobs.get(id);
        if (job) await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: Job): Promise<void> {
    job.status = "running";
    this.emit(job, { event: "job", status: "running" });
    if (this.options.postHandler) {
      try {
        const result = await this.options.postHandler(job.url, (event) => this.emit(job, event), { force: job.force === true });
        if (result === "handled") {
          job.status = "done";
          this.emit(job, { event: "job", status: "done" });
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit(job, { event: "error", stage: "read-post", message });
        job.status = "failed";
        job.error = message;
        this.emit(job, { event: "job", status: "failed", error: message });
        return;
      }
    }
    await this.spawnCli(job);
  }

  private spawnCli(job: Job): Promise<void> {
    return new Promise((resolve) => {
      let doneStatus: string | undefined;
      const errors: string[] = [];
      let stderrTail = "";
      let settled = false;

      const finish = (status: JobStatus, error?: string) => {
        if (settled) return;
        settled = true;
        job.status = status;
        if (error) job.error = error;
        this.emit(job, { event: "job", status, ...(error ? { error } : {}) });
        resolve();
      };

      const parser = createEventParser((event) => {
        if (event.event === "done") doneStatus = String(event.status ?? "");
        if (event.event === "error") errors.push(String(event.message ?? "unknown error"));
        this.emit(job, event);
      });

      // Arguments are an array (no shell) and `--` ends option parsing, so the URL can
      // never be interpreted as a flag.
      const child = spawn(
        this.options.bin,
        [
          "--json-events",
          "--emit",
          "md",
          "--index",
          ...(job.force ? ["--force"] : []),
          "-o",
          this.options.outdir,
          "--",
          job.url,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => parser.push(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
      });
      child.on("error", (err) => finish("failed", `could not start transcribe-url: ${err.message}`));
      child.on("close", (code) => {
        parser.end();
        if (code === 0 && doneStatus === "ok") return finish("done");
        const message =
          errors.at(-1) ??
          (stderrTail.trim().split("\n").at(-1) || `transcribe-url exited with code ${String(code)}`);
        finish("failed", message);
      });
    });
  }
}

function view(job: Job): JobView {
  const { id, url, status, createdAt, error } = job;
  return { id, url, status, createdAt, ...(error ? { error } : {}) };
}

const globalKey = Symbol.for("transcribe-url.jobManager");

/** One manager per server process (Next dev hot-reload would otherwise create several). */
export function getJobManager(options: JobManagerOptions): JobManager {
  const store = globalThis as unknown as Record<symbol, JobManager | undefined>;
  store[globalKey] ??= new JobManager(options);
  return store[globalKey];
}
