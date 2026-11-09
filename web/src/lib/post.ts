import { decodeEntities } from "./library";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PostImage {
  url: string;
  alt?: string;
}

export interface Post {
  id: string;
  handle: string;
  name: string;
  /** ISO timestamp from the post. */
  createdAt: string;
  lang?: string;
  text: string;
  images: PostImage[];
  hasVideo: boolean;
  quoted?: { handle: string; text: string; images: PostImage[] };
  sourceUrl: string;
}

export class PostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostError";
  }
}

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

/** `https://x.com/<user>/status/<id>` or `/i/status/<id>`; anything else is not a post URL. */
export function parseTweetUrl(input: string): { id: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = /^\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status\/(\d{5,25})(?:\/|$)/.exec(url.pathname);
  return match?.[1] ? { id: match[1] } : null;
}

const ARTICLE_LINK = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+\/?$/i;

/** True when the whole post text is just a link to an X Article (long-form), which the embed endpoint cannot read. */
export function isArticleLinkOnly(text: string): boolean {
  return ARTICLE_LINK.test(text.trim());
}

export const ARTICLE_NOTICE =
  "This post is only a link to an X Article, which cannot be read here. Paste the article text into a .txt/.md file and run that instead.";

/** The embed endpoint wants a token derived from the id (same formula X's own embeds use). */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

interface RawMedia {
  type?: string;
  media_url_https?: string;
  ext_alt_text?: string;
}

export interface RawTweet {
  __typename?: string;
  id_str?: string;
  text?: string;
  lang?: string;
  created_at?: string;
  display_text_range?: [number, number];
  user?: { screen_name?: string; name?: string };
  entities?: { urls?: { url?: string; expanded_url?: string }[]; media?: { url?: string }[] };
  mediaDetails?: RawMedia[];
  photos?: { url?: string }[];
  video?: unknown;
  quoted_tweet?: RawTweet;
}

function cleanText(raw: RawTweet): string {
  const chars = Array.from(raw.text ?? "");
  const range = raw.display_text_range;
  // display_text_range counts code points and excludes the trailing media link.
  let text = range && range.length === 2 ? chars.slice(range[0], range[1]).join("") : chars.join("");
  for (const link of raw.entities?.urls ?? []) {
    if (link.url && link.expanded_url) text = text.split(link.url).join(link.expanded_url);
  }
  for (const media of raw.entities?.media ?? []) {
    if (media.url) text = text.split(media.url).join("");
  }
  return decodeEntities(text).trim();
}

function imagesOf(raw: RawTweet): PostImage[] {
  const fromDetails = (raw.mediaDetails ?? [])
    .filter((m) => m.type === "photo" && m.media_url_https)
    .map((m) => ({ url: m.media_url_https as string, ...(m.ext_alt_text ? { alt: m.ext_alt_text } : {}) }));
  if (fromDetails.length > 0) return fromDetails;
  return (raw.photos ?? []).flatMap((p) => (p.url ? [{ url: p.url }] : []));
}

export function parsePost(raw: RawTweet, id: string): Post {
  if (raw.__typename === "TweetTombstone") {
    throw new PostError("this post is unavailable (deleted, protected or age-restricted)");
  }
  if (!raw.text && !raw.mediaDetails && !raw.photos) throw new PostError("the post has no readable content");
  const quoted = raw.quoted_tweet;
  return {
    id: raw.id_str ?? id,
    handle: raw.user?.screen_name ?? "unknown",
    name: decodeEntities(raw.user?.name ?? ""),
    createdAt: raw.created_at ?? "",
    ...(raw.lang && raw.lang !== "zxx" ? { lang: raw.lang } : {}),
    text: cleanText(raw),
    images: imagesOf(raw),
    hasVideo: (raw.mediaDetails ?? []).some((m) => m.type === "video" || m.type === "animated_gif") || Boolean(raw.video),
    ...(quoted
      ? { quoted: { handle: quoted.user?.screen_name ?? "unknown", text: cleanText(quoted), images: imagesOf(quoted) } }
      : {}),
    sourceUrl: `https://x.com/${raw.user?.screen_name ?? "i"}/status/${raw.id_str ?? id}`,
  };
}

/**
 * Reads a public post through X's embed endpoint (undocumented, may change or disappear).
 * Long posts (more than ~280 characters) come back truncated by this endpoint.
 */
export async function fetchPost(id: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<Post> {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new PostError(`could not reach X: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) throw new PostError("post not found or not public");
  if (!response.ok) throw new PostError(`X returned HTTP ${response.status}`);
  let raw: RawTweet;
  try {
    raw = (await response.json()) as RawTweet;
  } catch {
    throw new PostError("X returned an unreadable response for this post");
  }
  return parsePost(raw, id);
}
