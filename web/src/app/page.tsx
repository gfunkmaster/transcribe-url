import Link from "next/link";
import NewJob from "@/components/NewJob";
import { getConfig } from "@/lib/config";
import { listSources } from "@/lib/library";

export const dynamic = "force-dynamic";

export default async function Home() {
  const sources = await listSources(getConfig().outdir);
  return (
    <>
      <NewJob />
      <h2>Library</h2>
      {sources.length === 0 ? (
        <p className="muted">Nothing transcribed yet.</p>
      ) : (
        <ul className="library">
          {sources.map((s) => (
            <li key={s.slug}>
              <Link className="title" href={`/sources/${encodeURIComponent(s.slug)}`}>
                {s.title}
              </Link>
              {s.kind === "post" && <span className="badge">post</span>}
              {s.hasBrief && <span className="badge">brief</span>}
              <div className="muted">
                {[s.extractor, s.uploader, s.uploadDate, s.duration, s.language].filter(Boolean).join(" · ")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
