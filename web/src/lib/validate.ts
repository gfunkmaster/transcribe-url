export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const MAX_URL_LENGTH = 2048;

/**
 * The URL goes to a subprocess. Accept only absolute http(s) URLs, so a value can never be
 * read as an option, a local path, or a file the server happens to have.
 */
export function validateUrl(input: unknown): UrlCheck {
  if (typeof input !== "string") return { ok: false, error: "url must be a string" };
  const value = input.trim();
  if (value.length === 0) return { ok: false, error: "url is required" };
  if (value.length > MAX_URL_LENGTH) return { ok: false, error: "url is too long" };
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: "url contains whitespace or control characters" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "url is not a valid absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "only http(s) URLs are allowed" };
  }
  return { ok: true, url: parsed.href };
}
