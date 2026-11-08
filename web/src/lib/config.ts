import path from "node:path";

export interface Config {
  bin: string;
  outdir: string;
  model: string;
  /** Refuse to send transcripts larger than this many characters to the API. */
  maxInputChars: number;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `next dev` / `next start` run with cwd = web/, so the repo root is one level up.
  const repoRoot = path.resolve(env.TRANSCRIBE_REPO_ROOT ?? path.join(process.cwd(), ".."));
  return {
    bin: env.TRANSCRIBE_BIN ?? path.join(/* turbopackIgnore: true */ repoRoot, "transcribe-url.sh"),
    outdir: path.resolve(/* turbopackIgnore: true */ env.TRANSCRIBE_OUTDIR ?? path.join(repoRoot, "transcripts")),
    model: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    maxInputChars: 600_000,
  };
}
