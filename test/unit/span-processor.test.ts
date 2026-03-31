import { OpenBoxSpanProcessor, Verdict, WorkflowSpanBuffer } from "../../src/index.js";

enum MockStatusCode {
  UNSET = "UNSET",
  OK = "OK",
  ERROR = "ERROR"
}

type MockReadableSpan = {
  attributes?: Record<string, unknown>;
  context: {
    spanId: number;
    traceId: number;
  };
  spanContext?: () => {
    spanId: string;
    traceId: string;
  };
  endTime?: number | undefined;
  events?: Array<{
    attributes?: Record<string, unknown>;
    name: string;
    timestamp: number;
  }>;
  kind?: { name: string } | undefined;
  name: string;
  parentSpanContext?: { spanId: string } | undefined;
  startTime?: number | undefined;
  status?: {
    description?: string | undefined;
    statusCode?: { name: string } | MockStatusCode | undefined;
  } | undefined;
};

function createSpan(overrides: Partial<MockReadableSpan> = {}): MockReadableSpan {
  return {
    attributes: {},
    context: {
      spanId: 0x123456,
      traceId: 0xabcdef
    },
    spanContext: () => ({
      spanId: "abcdef0123456789",
      traceId: "0000000000000000123456789abcdef0"
    }),
    endTime: 2_000_000_000,
    events: [],
    kind: { name: "INTERNAL" },
    name: "test-span",
    parentSpanContext: undefined,
    startTime: 1_000_000_000,
    status: {
      description: undefined,
      statusCode: { name: MockStatusCode.UNSET }
    },
    ...overrides
  };
}

describe("OpenBoxSpanProcessor", () => {
  it("registers, retrieves, and removes workflow buffers", () => {
    const processor = new OpenBoxSpanProcessor();
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    expect(processor.getBuffer("wf-123")).toBe(buffer);
    expect(processor.removeBuffer("wf-123")).toBe(buffer);
    expect(processor.getBuffer("wf-123")).toBeUndefined();
  });

  it("keeps workflow buffers isolated by run id", () => {
    const processor = new OpenBoxSpanProcessor();
    const runABuffer = new WorkflowSpanBuffer({
      runId: "run-a",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });
    const runBBuffer = new WorkflowSpanBuffer({
      runId: "run-b",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", runABuffer);
    processor.registerWorkflow("wf-123", runBBuffer);

    processor.registerTrace(
      "00000000000000000000000000000aa1",
      "wf-123",
      "act-a",
      "run-a"
    );
    processor.registerTrace(
      "00000000000000000000000000000bb2",
      "wf-123",
      "act-b",
      "run-b"
    );

    processor.onEnd(
      createSpan({
        context: {
          spanId: 0xaaaaaa,
          traceId: 0
        },
        name: "span-a",
        spanContext: () => ({
          spanId: "aaaaaaaaaaaaaaaa",
          traceId: "00000000000000000000000000000aa1"
        })
      }) as never
    );
    processor.onEnd(
      createSpan({
        context: {
          spanId: 0xbbbbbb,
          traceId: 0
        },
        name: "span-b",
        spanContext: () => ({
          spanId: "bbbbbbbbbbbbbbbb",
          traceId: "00000000000000000000000000000bb2"
        })
      }) as never
    );

    expect(runABuffer.spans).toHaveLength(1);
    expect(runABuffer.spans[0]).toMatchObject({
      activityId: "act-a",
      name: "span-a"
    });
    expect(runBBuffer.spans).toHaveLength(1);
    expect(runBBuffer.spans[0]).toMatchObject({
      activityId: "act-b",
      name: "span-b"
    });
  });

  it("stores verdicts and mirrors them onto an existing buffer", () => {
    const processor = new OpenBoxSpanProcessor();
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    processor.setVerdict("wf-123", Verdict.BLOCK, "policy violation", "run-456");

    expect(processor.getVerdict("wf-123")).toEqual({
      reason: "policy violation",
      runId: "run-456",
      verdict: Verdict.BLOCK
    });
    expect(buffer.verdict).toBe(Verdict.BLOCK);
    expect(buffer.verdictReason).toBe("policy violation");

    processor.clearVerdict("wf-123");
    expect(processor.getVerdict("wf-123")).toBeUndefined();
  });

  it("stores bodies separately from span attributes and exposes pending body data", () => {
    const processor = new OpenBoxSpanProcessor();

    processor.storeBody(0x123, {
      requestBody: '{"input":"test"}',
      responseBody: '{"output":"result"}',
      requestHeaders: { "Content-Type": "application/json" },
      responseHeaders: { "X-Request-Id": "abc123" }
    });

    expect(processor.getPendingBody(0x123)).toEqual({
      requestBody: '{"input":"test"}',
      requestHeaders: { "Content-Type": "application/json" },
      responseBody: '{"output":"result"}',
      responseHeaders: { "X-Request-Id": "abc123" }
    });
  });

  it("ignores spans for configured URL prefixes but still forwards to the fallback processor", () => {
    const fallback = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      shutdown: vi.fn(async () => {})
    };
    const processor = new OpenBoxSpanProcessor({
      fallbackProcessor: fallback,
      ignoredUrlPrefixes: ["https://openbox.internal/"]
    });
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    processor.onEnd(
      createSpan({
        attributes: {
          "http.url": "https://openbox.internal/api/v1/evaluate",
          "openbox.workflow_id": "wf-123"
        }
      }) as never
    );

    expect(buffer.spans).toEqual([]);
    expect(fallback.onEnd).toHaveBeenCalledTimes(1);
  });

  it("buffers spans directly from workflow attributes", () => {
    const processor = new OpenBoxSpanProcessor();
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    processor.onEnd(
      createSpan({
        attributes: {
          "openbox.activity_id": "act-789",
          "openbox.workflow_id": "wf-123"
        }
      }) as never
    );

    expect(buffer.spans).toHaveLength(1);
    expect(buffer.spans[0]).toMatchObject({
      activityId: "act-789",
      name: "test-span"
    });
  });

  it("buffers child spans via trace correlation and merges pending privacy data", () => {
    const processor = new OpenBoxSpanProcessor();
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    processor.registerTrace(
      "0000000000000000123456789abcdef0",
      "wf-123",
      "act-789"
    );
    processor.storeBody("abcdef0123456789", {
      requestBody: '{"input":"test"}',
      responseBody: '{"output":"result"}'
    });

    processor.onEnd(
      createSpan({
        attributes: {},
        name: "http-call"
      }) as never
    );

    expect(buffer.spans[0]).toMatchObject({
      activityId: "act-789",
      name: "http-call",
      requestBody: '{"input":"test"}',
      responseBody: '{"output":"result"}'
    });
    const firstSpan = buffer.spans[0]!;

    expect(firstSpan.attributes).toEqual({});
    expect(processor.getPendingBody("abcdef0123456789")).toBeUndefined();
  });

  it("stores activity context and resolves it by trace id", () => {
    const processor = new OpenBoxSpanProcessor();
    const traceId = "0000000000000000123456789abcdef0";
    const workflowId = "wf-123";
    const activityId = "act-789";
    const contextPayload = {
      activity_type: "searchCryptoCoins",
      run_id: "run-456",
      workflow_id: workflowId
    };

    processor.registerTrace(traceId, workflowId, activityId, "run-456");
    processor.setActivityContext(workflowId, activityId, contextPayload);

    expect(processor.getActivityContextByTrace(traceId)).toEqual(contextPayload);

    processor.clearActivityContext(workflowId, activityId);
    expect(processor.getActivityContextByTrace(traceId)).toBeUndefined();
  });

  it("skips buffering spans marked as governed", () => {
    const processor = new OpenBoxSpanProcessor();
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    processor.markGoverned("abcdef0123456789");
    processor.onEnd(
      createSpan({
        attributes: {
          "openbox.workflow_id": "wf-123"
        },
        spanContext: () => ({
          spanId: "abcdef0123456789",
          traceId: "0000000000000000123456789abcdef0"
        })
      }) as never
    );

    expect(buffer.spans).toEqual([]);
  });

  it("merges trace-scoped HTTP privacy data into matching HTTP spans", () => {
    const processor = new OpenBoxSpanProcessor();
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    processor.registerTrace(
      "0000000000000000123456789abcdef0",
      "wf-123",
      "act-789"
    );
    processor.storeTraceBody("0000000000000000123456789abcdef0", {
      method: "POST",
      requestBody: '{"model":"gpt-4o"}',
      responseBody: '{"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      url: "https://api.openai.com/v1/responses"
    });

    processor.onEnd(
      createSpan({
        attributes: {
          "http.method": "POST",
          "http.url": "https://api.openai.com/v1/responses"
        },
        name: "llm.http"
      }) as never
    );

    expect(buffer.spans[0]).toMatchObject({
      activityId: "act-789",
      name: "llm.http",
      requestBody: '{"model":"gpt-4o"}',
      responseBody: '{"usage":{"prompt_tokens":10,"completion_tokens":2}}'
    });
  });

  it("retrofits trace-scoped HTTP privacy data when body arrives after span end", () => {
    const processor = new OpenBoxSpanProcessor();
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    processor.registerTrace(
      "0000000000000000123456789abcdef0",
      "wf-123",
      "act-789"
    );

    processor.onEnd(
      createSpan({
        attributes: {
          "http.method": "POST",
          "http.url": "https://api.openai.com/v1/responses"
        },
        name: "llm.http"
      }) as never
    );

    processor.storeTraceBody("0000000000000000123456789abcdef0", {
      method: "POST",
      requestBody: '{"model":"gpt-4o"}',
      responseBody: '{"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      url: "https://api.openai.com/v1/responses"
    });

    expect(buffer.spans[0]).toMatchObject({
      activityId: "act-789",
      name: "llm.http",
      requestBody: '{"model":"gpt-4o"}',
      responseBody: '{"usage":{"prompt_tokens":10,"completion_tokens":2}}'
    });
  });

  it("registers trace correlation from started workflow spans for later child spans", () => {
    const processor = new OpenBoxSpanProcessor();
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);
    processor.onStart(
      createSpan({
        attributes: {
          "openbox.workflow_id": "wf-123"
        }
      }) as never,
      {} as never
    );

    processor.onEnd(
      createSpan({
        attributes: {},
        name: "child-span"
      }) as never
    );

    expect(buffer.spans[0]).toMatchObject({
      name: "child-span",
      traceId: "0000000000000000123456789abcdef0"
    });
  });

  it("extracts OpenBox-compatible span data", () => {
    const processor = new OpenBoxSpanProcessor();

    const data = processor.extractSpanData(
      createSpan({
        attributes: {
          "http.method": "POST"
        },
        events: [
          {
            attributes: { key: "value" },
            name: "event-1",
            timestamp: 1_500_000_000
          }
        ],
        kind: { name: "CLIENT" },
        parentSpanContext: { spanId: "1111111111111111" },
        status: {
          description: "Something went wrong",
          statusCode: { name: MockStatusCode.ERROR }
        }
      }) as never
    );

    expect(data).toMatchObject({
      attributes: { "http.method": "POST" },
      durationNs: 1_000_000_000,
      endTime: 2_000_000_000,
      kind: "CLIENT",
      name: "test-span",
      parentSpanId: "1111111111111111",
      spanId: "abcdef0123456789",
      startTime: 1_000_000_000,
      status: {
        code: "ERROR",
        description: "Something went wrong"
      },
      traceId: "0000000000000000123456789abcdef0"
    });
    expect(data.events).toEqual([
      {
        attributes: { key: "value" },
        name: "event-1",
        timestamp: 1_500_000_000
      }
    ]);
  });

  it("delegates shutdown and forceFlush to the fallback processor", async () => {
    const fallback = {
      forceFlush: vi.fn(async () => {}),
      onEnd: vi.fn(),
      shutdown: vi.fn(async () => {})
    };
    const processor = new OpenBoxSpanProcessor({
      fallbackProcessor: fallback
    });

    await processor.forceFlush(5_000);
    await processor.shutdown();

    expect(fallback.forceFlush).toHaveBeenCalledWith(5_000);
    expect(fallback.shutdown).toHaveBeenCalledTimes(1);
  });
});
