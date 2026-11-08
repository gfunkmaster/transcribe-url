import { describe, expect, it } from "vitest";
import { checkLocalRequest } from "@/lib/guard";

const h = (init: Record<string, string>) => new Headers(init);

describe("checkLocalRequest", () => {
  it("allows loopback hosts with no or matching Origin", () => {
    expect(checkLocalRequest(h({ host: "127.0.0.1:3000" })).ok).toBe(true);
    expect(checkLocalRequest(h({ host: "localhost:3000", origin: "http://localhost:3000" })).ok).toBe(true);
    expect(checkLocalRequest(h({ host: "[::1]:3000", origin: "http://[::1]:3000" })).ok).toBe(true);
  });
  it("rejects non-loopback Host (DNS rebinding)", () => {
    const result = checkLocalRequest(h({ host: "evil.example:3000" }));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });
  it("rejects a missing Host", () => {
    expect(checkLocalRequest(h({})).ok).toBe(false);
  });
  it("rejects cross-origin and malformed Origin", () => {
    expect(checkLocalRequest(h({ host: "localhost:3000", origin: "https://evil.example" })).ok).toBe(false);
    expect(checkLocalRequest(h({ host: "localhost:3000", origin: "http://localhost:4000" })).ok).toBe(false);
    expect(checkLocalRequest(h({ host: "localhost:3000", origin: "not a url" })).ok).toBe(false);
  });
});
