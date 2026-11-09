import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import InterpretButton from "@/components/InterpretButton";
import { getConfig } from "@/lib/config";
import { readSource } from "@/lib/library";
import { describeProvider } from "@/lib/llm/registry";

export const dynamic = "force-dynamic";

export default async function SourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const source = await readSource(getConfig().outdir, decodeURIComponent(slug));
  if (!source) notFound();

  return (
    <>
      <h1>{source.title}</h1>
      <p className="muted">
        {[source.uploader, source.uploadDate, source.duration, source.language].filter(Boolean).join(" · ")}
        {source.sourceUrl && (
          <>
            {" · "}
            <a href={source.sourceUrl} rel="noreferrer noopener" target="_blank">
              source
            </a>
          </>
        )}
      </p>

      <InterpretButton slug={source.slug} hasBrief={source.brief !== null} provider={describeProvider()} imageCount={source.images.length} blockedReason={source.unreadable} />

      {source.brief && (
        <section className="brief">
          <h2>Brief</h2>
          {/* react-markdown does not render raw HTML, so model output cannot inject markup. */}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{source.brief}</ReactMarkdown>
        </section>
      )}

      {source.images.length > 0 && (
        <section>
          <h2>Images</h2>
          {source.images.map((name) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={name}
              src={`/api/sources/${encodeURIComponent(source.slug)}/media/${name}`}
              alt={name}
              style={{ maxWidth: "100%", display: "block", margin: "0 0 1rem" }}
            />
          ))}
        </section>
      )}

      <h2>{source.kind === "post" ? "Post" : "Transcript"}</h2>
      <pre className="transcript">{source.body}</pre>
    </>
  );
}
