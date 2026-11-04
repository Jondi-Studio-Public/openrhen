import { describe, expect, it, vi } from "vitest";
import { OpenAIImportExtractor } from "./openai-import-extractor";

describe("OpenAI import extraction", () => {
  it("uses ephemeral structured Responses input and preserves unavailable fields as null", async () => {
    const request = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              records: [
                {
                  importKey: "draft-report",
                  entityType: "action",
                  fields: [
                    {
                      name: "title",
                      value: "Draft the report",
                      basis: "explicit",
                      confidence: "high",
                      evidence: ["Draft the report"],
                      needsReview: false
                    },
                    {
                      name: "expectedMinutes",
                      value: null,
                      basis: "missing",
                      confidence: null,
                      evidence: [],
                      needsReview: true
                    }
                  ],
                  relationships: [{ name: "projectKey", value: null }]
                }
              ]
            })
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const extractor = new OpenAIImportExtractor(
      { OUTBOUND_PROXY_URL: "http://proxy.internal:4200", OUTBOUND_PROXY_TOKEN: "test-token" },
      "gpt-5.6-sol",
      request as typeof fetch
    );
    const records = await extractor.extract({
      inputKind: "task_list",
      timezone: "Australia/Sydney",
      text: "Draft the report",
      images: [{ filename: "notes.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
      currentState: { areas: [], outcomes: [], projects: [], actions: [] }
    });

    expect(request.mock.calls[0]?.[0]).toBe("http://proxy.internal:4200/capabilities/model_provider/openai/extract");
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer test-token" });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.input[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "input_text" }),
        expect.objectContaining({ type: "input_image", image_url: "data:image/png;base64,AQID" })
      ])
    );
    expect(records[0]?.fields.title).toMatchObject({
      value: "Draft the report",
      basis: "explicit",
      needsReview: false
    });
    expect(records[0]?.fields.expectedMinutes).toMatchObject({ value: null, basis: "missing", needsReview: true });
    expect(records[0]?.fields.status).toMatchObject({ value: null, basis: "missing", needsReview: true });
    expect(records[0]?.relationships.projectKey).toBeNull();
  });

  it("uses a configured model override instead of the default", async () => {
    const request = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ output_text: JSON.stringify({ records: [] }) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const extractor = new OpenAIImportExtractor(
      { OUTBOUND_PROXY_URL: "http://proxy.internal:4200", OUTBOUND_PROXY_TOKEN: "test-token" },
      "gpt-5",
      request as typeof fetch
    );
    await extractor.extract({
      inputKind: "task_list",
      timezone: "Australia/Sydney",
      text: "Draft the report",
      currentState: { areas: [], outcomes: [], projects: [], actions: [] }
    });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("gpt-5");
  });

  it("bounds the call with an abort signal that fires when the sidecar never answers", async () => {
    const neverResponds = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "TimeoutError"))
          );
        })
    );
    const extractor = new OpenAIImportExtractor(
      {
        OUTBOUND_PROXY_URL: "http://proxy.internal:4200",
        OUTBOUND_PROXY_TOKEN: "test-token",
        OUTBOUND_REQUEST_TIMEOUT_MS: "20"
      },
      "gpt-5.6-sol",
      neverResponds as typeof fetch
    );
    await expect(
      extractor.extract({
        inputKind: "task_list",
        timezone: "Australia/Sydney",
        text: "Draft the report",
        currentState: { areas: [], outcomes: [], projects: [], actions: [] }
      })
    ).rejects.toThrow();
  });
});
