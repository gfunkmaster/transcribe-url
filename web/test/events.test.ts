import { describe, expect, it } from "vitest";
import { createEventParser, parseEventLine, type ProgressEvent } from "@/lib/events";

describe("parseEventLine", () => {
  it("parses an event object", () => {
    expect(parseEventLine('{"event":"audio","seconds":102}')).toEqual({ event: "audio", seconds: 102 });
  });
  it.each(["", "  ", "plain text", "[1,2]", '{"no":"event"}', '{"event":5}', "{broken"])("ignores %j", (line) => {
    expect(parseEventLine(line)).toBeNull();
  });
});

describe("createEventParser", () => {
  it("reassembles lines split across chunks and flushes a trailing line", () => {
    const seen: ProgressEvent[] = [];
    const parser = createEventParser((e) => seen.push(e));
    parser.push('{"event":"sta');
    parser.push('rt"}\n{"event":"stage","name":"download"}\nnoise\n{"event":"done"');
    expect(seen.map((e) => e.event)).toEqual(["start", "stage"]);
    parser.push("}");
    parser.end();
    expect(seen.map((e) => e.event)).toEqual(["start", "stage", "done"]);
  });
});
