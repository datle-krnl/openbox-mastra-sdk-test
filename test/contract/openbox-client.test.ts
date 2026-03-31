import { HttpResponse, delay, http } from "msw";
import { setupServer } from "msw/node";

import {
  GovernanceAPIError,
  GovernanceVerdictResponse,
  OpenBoxAuthError,
  OpenBoxClient,
  OpenBoxNetworkError,
  Verdict
} from "../../src/index.js";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("OpenBoxClient.validateApiKey", () => {
  it("calls the auth endpoint with required headers", async () => {
    let observedAuthHeader = "";
    let observedContentType = "";
    let observedUserAgent = "";

    server.use(
      http.get("https://api.openbox.ai/api/v1/auth/validate", ({ request }) => {
        observedAuthHeader = request.headers.get("authorization") ?? "";
        observedContentType = request.headers.get("content-type") ?? "";
        observedUserAgent = request.headers.get("user-agent") ?? "";

        return HttpResponse.json({ ok: true }, { status: 200 });
      })
    );

    const client = new OpenBoxClient({
      apiKey: "obx_live_valid_key",
      apiUrl: "https://api.openbox.ai/"
    });

    await expect(client.validateApiKey()).resolves.toBeUndefined();
    expect(observedAuthHeader).toBe("Bearer obx_live_valid_key");
    expect(observedContentType).toBe("application/json");
    expect(observedUserAgent).toBe("OpenBox-SDK/1.0");
  });

  it.each([401, 403])(
    "raises OpenBoxAuthError on %s",
    async statusCode => {
      server.use(
        http.get("https://api.openbox.ai/api/v1/auth/validate", () =>
          HttpResponse.json(
            { error: "invalid" },
            { status: statusCode }
          )
        )
      );

      const client = new OpenBoxClient({
        apiKey: "obx_live_bad_key",
        apiUrl: "https://api.openbox.ai"
      });

      await expect(client.validateApiKey()).rejects.toBeInstanceOf(
        OpenBoxAuthError
      );
    }
  );

  it("raises OpenBoxNetworkError on non-auth HTTP errors", async () => {
    server.use(
      http.get("https://api.openbox.ai/api/v1/auth/validate", () =>
        HttpResponse.text("Internal Server Error", { status: 500 })
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_live_test_key",
      apiUrl: "https://api.openbox.ai"
    });

    await expect(client.validateApiKey()).rejects.toBeInstanceOf(
      OpenBoxNetworkError
    );
  });
});

describe("OpenBoxClient.evaluate", () => {
  it("posts governance payloads to the evaluate endpoint", async () => {
    let observedBody: unknown;
    let observedAuthHeader = "";

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/evaluate",
        async ({ request }) => {
          observedBody = await request.json();
          observedAuthHeader = request.headers.get("authorization") ?? "";

          return HttpResponse.json({
            reason: "Needs review",
            verdict: "require_approval"
          });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai/"
    });

    const response = await client.evaluate({
      event_type: "WorkflowStarted",
      workflow_id: "wf-123"
    });

    expect(response).toBeInstanceOf(GovernanceVerdictResponse);
    expect(response?.verdict).toBe(Verdict.REQUIRE_APPROVAL);
    expect(response?.reason).toBe("Needs review");
    expect(observedAuthHeader).toBe("Bearer obx_test_eval_key");
    expect(observedBody).toEqual({
      event_type: "WorkflowStarted",
      workflow_id: "wf-123"
    });
  });

  it("normalizes ActivityStarted hook payloads with variable span counts", async () => {
    let observedBody: unknown;

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/evaluate",
        async ({ request }) => {
          observedBody = await request.json();
          return HttpResponse.json({ verdict: "allow" });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai/"
    });

    await client.evaluate({
      activity_id: "act-1",
      event_type: "ActivityStarted",
      hook_trigger: {
        stage: "completed",
        type: "http_request"
      },
      run_id: "run-1",
      span_count: 99,
      spans: [
        { hook_type: "http_request", stage: "started" },
        "invalid-span",
        { hook_type: "http_request", stage: "completed" }
      ],
      workflow_id: "wf-1"
    });

    expect(observedBody).toMatchObject({
      activity_id: "act-1",
      event_type: "ActivityStarted",
      hook_trigger: true,
      run_id: "run-1",
      span_count: 2,
      workflow_id: "wf-1"
    });
    expect(
      Array.isArray((observedBody as Record<string, unknown>).spans)
    ).toBe(true);
    expect(
      ((observedBody as Record<string, unknown>).spans as unknown[]).length
    ).toBe(2);
  });

  it("drops spans from non-hook ActivityCompleted payloads", async () => {
    let observedBody: unknown;

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/evaluate",
        async ({ request }) => {
          observedBody = await request.json();
          return HttpResponse.json({ verdict: "allow" });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai/"
    });

    await client.evaluate({
      activity_id: "act-2",
      event_type: "ActivityCompleted",
      run_id: "run-2",
      span_count: 7,
      spans: [{ hook_type: "http_request", stage: "completed" }],
      workflow_id: "wf-2"
    });

    expect(observedBody).toMatchObject({
      activity_id: "act-2",
      event_type: "ActivityCompleted",
      run_id: "run-2",
      span_count: 0,
      workflow_id: "wf-2"
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        observedBody as Record<string, unknown>,
        "spans"
      )
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        observedBody as Record<string, unknown>,
        "hook_trigger"
      )
    ).toBe(false);
  });

  it("keeps spans for hook-style ActivityCompleted payloads", async () => {
    let observedBody: unknown;

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/evaluate",
        async ({ request }) => {
          observedBody = await request.json();
          return HttpResponse.json({ verdict: "allow" });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai/"
    });

    await client.evaluate({
      activity_id: "act-2-hook",
      event_type: "ActivityCompleted",
      hook_trigger: true,
      run_id: "run-2-hook",
      spans: [
        {
          hook_type: "http_request",
          stage: "completed"
        }
      ],
      workflow_id: "wf-2-hook"
    });

    expect(observedBody).toMatchObject({
      activity_id: "act-2-hook",
      event_type: "ActivityCompleted",
      hook_trigger: true,
      run_id: "run-2-hook",
      span_count: 1,
      workflow_id: "wf-2-hook"
    });
    expect(
      Array.isArray((observedBody as Record<string, unknown>).spans)
    ).toBe(true);
    expect(
      ((observedBody as Record<string, unknown>).spans as unknown[]).length
    ).toBe(1);
  });

  it("normalizes single span objects into one-item ActivityStarted span arrays", async () => {
    let observedBody: unknown;

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/evaluate",
        async ({ request }) => {
          observedBody = await request.json();
          return HttpResponse.json({ verdict: "allow" });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai/"
    });

    await client.evaluate({
      activity_id: "act-3",
      event_type: "ActivityStarted",
      hook_trigger: true,
      run_id: "run-3",
      spans: { hook_type: "http_request", stage: "completed" },
      workflow_id: "wf-3"
    });

    expect(observedBody).toMatchObject({
      activity_id: "act-3",
      event_type: "ActivityStarted",
      hook_trigger: true,
      run_id: "run-3",
      span_count: 1,
      workflow_id: "wf-3"
    });
    expect(
      Array.isArray((observedBody as Record<string, unknown>).spans)
    ).toBe(true);
    expect(
      ((observedBody as Record<string, unknown>).spans as unknown[]).length
    ).toBe(1);
  });

  it("supports backward-compatible hook_trigger values and keeps payload immutable", async () => {
    let observedBody: unknown;

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/evaluate",
        async ({ request }) => {
          observedBody = await request.json();
          return HttpResponse.json({ verdict: "allow" });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai/"
    });

    const originalPayload: Record<string, unknown> = {
      activity_id: "act-4",
      event_type: "ActivityStarted",
      hook_trigger: "yes",
      run_id: "run-4",
      spans: [{ hook_type: "db_query", stage: "started" }],
      workflow_id: "wf-4"
    };

    await client.evaluate(originalPayload);

    expect(observedBody).toMatchObject({
      activity_id: "act-4",
      event_type: "ActivityStarted",
      hook_trigger: true,
      run_id: "run-4",
      span_count: 1,
      workflow_id: "wf-4"
    });
    expect(originalPayload.hook_trigger).toBe("yes");
    expect(originalPayload.span_count).toBeUndefined();
  });

  it("extracts legacy hook span objects from hook_trigger when spans are omitted", async () => {
    let observedBody: unknown;

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/evaluate",
        async ({ request }) => {
          observedBody = await request.json();
          return HttpResponse.json({ verdict: "allow" });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai/"
    });

    await client.evaluate({
      activity_id: "act-legacy-hook",
      event_type: "ActivityStarted",
      hook_trigger: {
        method: "POST",
        stage: "completed",
        type: "http_request",
        url: "https://api.openai.com/v1/responses"
      },
      run_id: "run-legacy-hook",
      workflow_id: "wf-legacy-hook"
    });

    expect(observedBody).toMatchObject({
      activity_id: "act-legacy-hook",
      event_type: "ActivityStarted",
      hook_trigger: true,
      run_id: "run-legacy-hook",
      span_count: 1,
      workflow_id: "wf-legacy-hook"
    });

    const spans = (observedBody as Record<string, unknown>).spans as Array<
      Record<string, unknown>
    >;
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      hook_type: "http_request",
      method: "POST",
      stage: "completed",
      url: "https://api.openai.com/v1/responses"
    });
    expect(spans[0]).not.toHaveProperty("type");
  });

  it("drops non-object spans while preserving ActivityStarted governance event", async () => {
    let observedBody: unknown;

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/evaluate",
        async ({ request }) => {
          observedBody = await request.json();
          return HttpResponse.json({ verdict: "allow" });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai/"
    });

    await client.evaluate({
      activity_id: "act-5",
      event_type: "ActivityStarted",
      hook_trigger: true,
      run_id: "run-5",
      spans: [null, 1, "bad", undefined],
      workflow_id: "wf-5"
    });

    expect(observedBody).toMatchObject({
      activity_id: "act-5",
      event_type: "ActivityStarted",
      hook_trigger: true,
      run_id: "run-5",
      span_count: 0,
      workflow_id: "wf-5"
    });
    expect((observedBody as Record<string, unknown>).spans).toEqual([]);
  });

  it("parses legacy action responses", async () => {
    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/evaluate", () =>
        HttpResponse.json({
          action: "continue",
          reason: "Allowed by policy"
        })
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai"
    });

    const response = await client.evaluate({ event_type: "WorkflowStarted" });

    expect(response?.verdict).toBe(Verdict.ALLOW);
    expect(response?.action).toBe("continue");
  });

  it("returns null on HTTP failure in fail_open mode", async () => {
    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/evaluate", () =>
        HttpResponse.text("Service Unavailable", { status: 503 })
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai",
      onApiError: "fail_open"
    });

    await expect(
      client.evaluate({ event_type: "WorkflowStarted" })
    ).resolves.toBeNull();
  });

  it("raises GovernanceAPIError on HTTP failure in fail_closed mode", async () => {
    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/evaluate", () =>
        HttpResponse.text("Service Unavailable", { status: 503 })
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai",
      onApiError: "fail_closed"
    });

    await expect(
      client.evaluate({ event_type: "WorkflowStarted" })
    ).rejects.toBeInstanceOf(GovernanceAPIError);
  });

  it("returns null on timeout in fail_open mode", async () => {
    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/evaluate", async () => {
        await delay(50);

        return HttpResponse.json({ verdict: "allow" });
      })
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai",
      onApiError: "fail_open",
      timeoutSeconds: 0.001
    });

    await expect(
      client.evaluate({ event_type: "WorkflowStarted" })
    ).resolves.toBeNull();
  });

  it("retries transient evaluate failures with bounded backoff", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/evaluate", () => {
        attempts += 1;

        if (attempts < 3) {
          return HttpResponse.text("Service Unavailable", { status: 503 });
        }

        return HttpResponse.json({ verdict: "allow" });
      })
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai",
      evaluateMaxRetries: 2,
      evaluateRetryBaseDelayMs: 0,
      onApiError: "fail_closed"
    });

    await expect(
      client.evaluate({ event_type: "WorkflowStarted" })
    ).resolves.toMatchObject({
      verdict: Verdict.ALLOW
    });
    expect(attempts).toBe(3);
  });

  it("does not retry non-transient evaluate failures", async () => {
    let attempts = 0;

    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/evaluate", () => {
        attempts += 1;
        return HttpResponse.text("Bad Request", { status: 400 });
      })
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_eval_key",
      apiUrl: "https://api.openbox.ai",
      evaluateMaxRetries: 3,
      evaluateRetryBaseDelayMs: 0,
      onApiError: "fail_closed"
    });

    await expect(
      client.evaluate({ event_type: "WorkflowStarted" })
    ).rejects.toBeInstanceOf(GovernanceAPIError);
    expect(attempts).toBe(1);
  });
});

describe("OpenBoxClient.pollApproval", () => {
  it("posts workflow, run, and activity identifiers with JSON content type", async () => {
    let observedBody: unknown;
    let observedContentType: string | null = null;

    server.use(
      http.post(
        "https://api.openbox.ai/api/v1/governance/approval",
        async ({ request }) => {
          observedBody = await request.json();
          observedContentType = request.headers.get("content-type");

          return HttpResponse.json({
            reason: "Approved by admin",
            verdict: "allow"
          });
        }
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_approval_key",
      apiUrl: "https://api.openbox.ai"
    });

    const response = await client.pollApproval({
      activityId: "act-789",
      runId: "run-456",
      workflowId: "wf-123"
    });

    expect(observedBody).toEqual({
      activity_id: "act-789",
      run_id: "run-456",
      workflow_id: "wf-123"
    });
    expect(observedContentType).toContain("application/json");
    expect(response).toEqual({ reason: "Approved by admin", verdict: "allow" });
  });

  it.each([
    "2020-01-01T00:00:00Z",
    "2020-01-01T00:00:00+00:00",
    "2020-01-01 00:00:00"
  ])("marks expired approvals across supported timestamp formats", async timestamp => {
    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/approval", () =>
        HttpResponse.json({
          approval_expiration_time: timestamp,
          verdict: "require_approval"
        })
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_approval_key",
      apiUrl: "https://api.openbox.ai"
    });

    const response = await client.pollApproval({
      activityId: "act-789",
      runId: "run-456",
      workflowId: "wf-123"
    });

    expect(response).toMatchObject({
      approval_expiration_time: timestamp,
      expired: true,
      verdict: "require_approval"
    });
  });

  it("leaves null expiration values unexpired", async () => {
    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/approval", () =>
        HttpResponse.json({
          approval_expiration_time: null,
          verdict: "require_approval"
        })
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_approval_key",
      apiUrl: "https://api.openbox.ai"
    });

    const response = await client.pollApproval({
      activityId: "act-789",
      runId: "run-456",
      workflowId: "wf-123"
    });

    expect(response).toEqual({
      approval_expiration_time: null,
      verdict: "require_approval"
    });
  });

  it("returns null on API error", async () => {
    server.use(
      http.post("https://api.openbox.ai/api/v1/governance/approval", () =>
        HttpResponse.text("Internal Server Error", { status: 500 })
      )
    );

    const client = new OpenBoxClient({
      apiKey: "obx_test_approval_key",
      apiUrl: "https://api.openbox.ai"
    });

    await expect(
      client.pollApproval({
        activityId: "act-789",
        runId: "run-456",
        workflowId: "wf-123"
      })
    ).resolves.toBeNull();
  });
});
