import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyCapped } from "./capped-body";

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });

describe("readBodyCapped", () => {
  it("reads a body under the cap, whatever Content-Length says", async () => {
    const request = new Request("http://x/", { method: "POST", body: "hello world" });
    expect(await readBodyCapped(request, 100)).toBe("hello world");
  });

  it("stops reading at the cap when no Content-Length is declared", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1000));
        if (pulled > 10_000) controller.close();
      }
    });
    const request = new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(readBodyCapped(request, 5000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled).toBeLessThan(100);
  });

  it("refuses a declared length over the cap without reading", async () => {
    const request = new Request("http://x/", {
      method: "POST",
      body: streamOf(["a"]),
      headers: { "content-length": "999999" },
      duplex: "half"
    } as RequestInit);
    await expect(readBodyCapped(request, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("joins multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("é");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 1));
        c.enqueue(bytes.slice(1));
        c.close();
      }
    });
    expect(
      await readBodyCapped(new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit), 10)
    ).toBe("é");
  });
});
