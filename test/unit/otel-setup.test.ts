import { createServer } from "node:http";

import { context, trace } from "@opentelemetry/api";

import {
  ApprovalPendingError,
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry,
  traced
} from "../../src/index.js";
import {
  clearActivityApproval,
  markActivityApproved
} from "../../src/governance/approval-registry.js";
import { runWithOpenBoxExecutionContext } from "../../src/governance/context.js";
import { startOpenBoxServer } from "../helpers/openbox-server.js";

function getHookSpans(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (payload.hook_trigger !== true) {
    return [];
  }

  const spans = payload.spans;

  if (!Array.isArray(spans) || spans.length === 0) {
    return [];
  }

  return spans.filter(
    (span): span is Record<string, unknown> =>
      span !== null && typeof span === "object"
  );
}

function getHookSpan(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  return getHookSpans(payload)[0];
}

function isHookSpanPayload(
  payload: Record<string, unknown>,
  hookType: string,
  stage: "completed" | "started"
): boolean {
  return (
    getHookSpans(payload).some(
      span => span.hook_type === hookType && span.stage === stage
    ) &&
    payload.event_type === "ActivityStarted"
  );
}

describe("setupOpenBoxOpenTelemetry", () => {
  it("respects instrumentation toggles", async () => {
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const names = controller.instrumentations.map(
      instrumentation => instrumentation.instrumentationName
    );

    expect(names).not.toContain("@opentelemetry/instrumentation-fs");
    expect(names).not.toContain("@opentelemetry/instrumentation-pg");
    expect(names).not.toContain("@opentelemetry/instrumentation-http");

    await controller.shutdown();
  });

  it("selects only requested database instrumentations", async () => {
    const controller = setupOpenBoxOpenTelemetry({
      dbLibraries: new Set(["pg", "redis"]),
      instrumentDatabases: true,
      instrumentFileIo: false,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const names = controller.instrumentations.map(
      instrumentation => instrumentation.instrumentationName
    );

    expect(names).toContain("@opentelemetry/instrumentation-http");
    expect(names).toContain("@opentelemetry/instrumentation-undici");
    expect(names).toContain("@opentelemetry/instrumentation-pg");
    expect(names).toContain("@opentelemetry/instrumentation-redis");
    expect(names).not.toContain("@opentelemetry/instrumentation-mysql");

    await controller.shutdown();
  });

  it("emits started/completed hook governance events for HTTP requests", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const downstream = createServer((request, response) => {
      let body = "";

      request.setEncoding("utf8");
      request.on("data", chunk => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ echoed: body }));
      });
    });

    await new Promise<void>(resolve => {
      downstream.listen(0, "127.0.0.1", () => resolve());
    });

    const address = downstream.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected downstream server address");
    }

    const downstreamUrl = `http://127.0.0.1:${address.port}/echo`;
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_events",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("activity.searchCryptoCoins", {
      attributes: {
        "openbox.activity_id": "act-123",
        "openbox.run_id": "run-123",
        "openbox.workflow_id": "wf-123"
      }
    });

    spanProcessor.registerTrace(
      rootSpan.spanContext().traceId,
      "wf-123",
      "act-123",
      "run-123"
    );
    spanProcessor.setActivityContext("wf-123", "act-123", {
      activity_id: "act-123",
      activity_input: {
        keyword: "bitcoin"
      },
      activity_type: "searchCryptoCoins",
      run_id: "run-123",
      workflow_id: "wf-123",
      workflow_type: "crypto-agent"
    });

    await runWithOpenBoxExecutionContext(
      {
        activityId: "act-123",
        activityType: "searchCryptoCoins",
        attempt: 1,
        goal: "Search crypto prices and summarize findings",
        runId: "run-123",
        source: "tool",
        taskQueue: "mastra",
        workflowId: "wf-123",
        workflowType: "crypto-agent"
      },
      async () => {
        await context.with(trace.setSpan(context.active(), rootSpan), async () => {
          const response = await fetch(downstreamUrl, {
            body: JSON.stringify({
              model: "gpt-4o-mini"
            }),
            headers: {
              "content-type": "application/json"
            },
            method: "POST"
          });

          await response.text();
        });
      }
    );

    rootSpan.end();
    await controller.shutdown();
    await openBoxServer.close();
    downstream.close();

    const hookEvents = openBoxServer.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(payload => payload.hook_trigger === true);

    expect(hookEvents.length).toBeGreaterThanOrEqual(2);

    const startedEvent = hookEvents.find(payload =>
      isHookSpanPayload(payload, "http_request", "started")
    );
    const completedEvent = hookEvents.find(payload =>
      isHookSpanPayload(payload, "http_request", "completed")
    );

    expect(startedEvent).toBeDefined();
    expect(completedEvent).toBeDefined();

    if (!startedEvent || !completedEvent) {
      throw new Error("Expected started/completed hook events for http_request");
    }

    const startedSpan = getHookSpan(startedEvent);
    const completedSpan = getHookSpan(completedEvent);

    expect(startedEvent.attempt).toBe(1);
    expect(startedEvent.hook_trigger).toBe(true);
    expect(startedEvent).toMatchObject({
      activity_input: [
        {
          keyword: "bitcoin",
          goal: "Search crypto prices and summarize findings"
        }
      ],
      event_type: "ActivityStarted",
      activity_type: "http_request",
      goal: "Search crypto prices and summarize findings",
      run_id: "run-123",
      workflow_id: "wf-123",
      workflow_type: "crypto-agent"
    });
    expect(completedEvent).toMatchObject({
      event_type: "ActivityStarted",
      activity_type: "http_request",
      run_id: "run-123",
      workflow_id: "wf-123",
      workflow_type: "crypto-agent"
    });
    expect(startedEvent.activity_id).toBe("act-123");
    expect(completedEvent.activity_id).toBe("act-123");
    expect(startedEvent.span_count).toBe(1);
    expect(completedEvent.span_count).toBe(1);
    expect(startedSpan).toMatchObject({
      hook_type: "http_request",
      http_method: "POST",
      http_url: downstreamUrl,
      stage: "started"
    });
    expect(completedSpan).toMatchObject({
      hook_type: "http_request",
      http_method: "POST",
      http_url: downstreamUrl,
      stage: "completed"
    });
    expect(startedSpan?.data).toMatchObject({
      method: "POST",
      url: downstreamUrl
    });
    expect(completedSpan?.data).toMatchObject({
      method: "POST",
      url: downstreamUrl,
      status_code: 200
    });
  });

  it("does not emit synthetic hook governance events for agent context without tool activity context", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const downstream = createServer((request, response) => {
      let body = "";

      request.setEncoding("utf8");
      request.on("data", chunk => {
        body += chunk;
      });
      request.on("end", () => {
        let model = "gpt-4.1";

        try {
          const parsed = JSON.parse(body) as { model?: unknown };

          if (typeof parsed.model === "string" && parsed.model.trim().length > 0) {
            model = parsed.model;
          }
        } catch {
          // Ignore malformed request body in test fixture.
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model,
            usage: {
              input_tokens: 42,
              output_tokens: 7,
              total_tokens: 49
            }
          })
        );
      });
    });

    await new Promise<void>(resolve => {
      downstream.listen(0, "127.0.0.1", () => resolve());
    });

    const address = downstream.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected downstream server address");
    }

    const downstreamUrl = `http://127.0.0.1:${address.port}/echo`;
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_events_agent_context",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("agent.run");

    await runWithOpenBoxExecutionContext(
      {
        goal: "Create a sandbox and write hello world",
        runId: "run-agent-1",
        source: "agent",
        taskQueue: "mastra",
        workflowId: "wf-agent-1",
        workflowType: "coding-agent"
      },
      async () => {
        await context.with(trace.setSpan(context.active(), rootSpan), async () => {
          const response = await fetch(downstreamUrl, {
            body: JSON.stringify({
              messages: [
                {
                  content: [
                    {
                      text:
                        '[{"type":"text","text":"Create a sandbox and write hello world"}]',
                      type: "text"
                    }
                  ],
                  role: "user"
                }
              ],
              model: "gpt-4.1"
            }),
            headers: {
              "content-type": "application/json"
            },
            method: "POST"
          });

          await response.text();
        });
      }
    );

    rootSpan.end();
    await controller.shutdown();
    await openBoxServer.close();
    downstream.close();

    const hookEvents = openBoxServer.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(payload => payload.hook_trigger === true);
    expect(hookEvents).toHaveLength(0);
  });

  it("raises ApprovalPendingError when hook-level governance returns REQUIRE_APPROVAL", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate(body) {
        const span = getHookSpan(body);

        if (
          span?.hook_type === "http_request" &&
          span?.stage === "started"
        ) {
          return {
            reason: "Hook-level approval required",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const downstream = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => {
      downstream.listen(0, "127.0.0.1", () => resolve());
    });

    const address = downstream.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected downstream server address");
    }

    const downstreamUrl = `http://127.0.0.1:${address.port}/echo`;
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_approval",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("activity.searchCryptoCoins", {
      attributes: {
        "openbox.activity_id": "act-approval-123",
        "openbox.run_id": "run-approval-123",
        "openbox.workflow_id": "wf-approval-123"
      }
    });

    spanProcessor.registerTrace(
      rootSpan.spanContext().traceId,
      "wf-approval-123",
      "act-approval-123",
      "run-approval-123"
    );

    await expect(
      runWithOpenBoxExecutionContext(
        {
          activityId: "act-approval-123",
          activityType: "searchCryptoCoins",
          attempt: 1,
          runId: "run-approval-123",
          source: "tool",
          taskQueue: "mastra",
          workflowId: "wf-approval-123",
          workflowType: "crypto-agent"
        },
        async () => {
          return context.with(trace.setSpan(context.active(), rootSpan), async () => {
            await fetch(downstreamUrl, {
              body: JSON.stringify({
                symbol: "btc"
              }),
              headers: {
                "content-type": "application/json"
              },
              method: "POST"
            });
          });
        }
      )
    ).rejects.toBeInstanceOf(ApprovalPendingError);

    rootSpan.end();
    await controller.shutdown();
    await openBoxServer.close();
    downstream.close();
  });

  it("allows approved activities to continue when nested hook requests approval", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate(body) {
        const span = getHookSpan(body);

        if (
          span?.hook_type === "http_request" &&
          span?.stage === "started"
        ) {
          return {
            reason: "Hook-level approval required",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const downstream = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => {
      downstream.listen(0, "127.0.0.1", () => resolve());
    });

    const address = downstream.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected downstream server address");
    }

    const downstreamUrl = `http://127.0.0.1:${address.port}/echo`;
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_approval_already_granted",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("activity.createSandbox", {
      attributes: {
        "openbox.activity_id": "act-approved-123",
        "openbox.run_id": "run-approved-123",
        "openbox.workflow_id": "wf-approved-123"
      }
    });

    spanProcessor.registerTrace(
      rootSpan.spanContext().traceId,
      "wf-approved-123",
      "act-approved-123",
      "run-approved-123"
    );
    markActivityApproved("run-approved-123", "act-approved-123");

    await expect(
      runWithOpenBoxExecutionContext(
        {
          activityId: "act-approved-123",
          activityType: "createSandbox",
          attempt: 1,
          runId: "run-approved-123",
          source: "tool",
          taskQueue: "mastra",
          workflowId: "wf-approved-123",
          workflowType: "coding-agent"
        },
        async () => {
          return context.with(trace.setSpan(context.active(), rootSpan), async () => {
            const response = await fetch(downstreamUrl, {
              body: JSON.stringify({
                action: "create-sandbox"
              }),
              headers: {
                "content-type": "application/json"
              },
              method: "POST"
            });

            await response.text();
          });
        }
      )
    ).resolves.toBeUndefined();

    clearActivityApproval("run-approved-123", "act-approved-123");
    rootSpan.end();
    await controller.shutdown();
    await openBoxServer.close();
    downstream.close();
  });

  it("emits started/completed hook governance events for traced function calls", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_events_function",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracedFn = traced(
      async (a: number, b: number) => a + b,
      {
        captureArgs: true,
        captureResult: true,
        module: "math",
        name: "sum"
      }
    );

    const result = await runWithOpenBoxExecutionContext(
      {
        activityId: "act-fn-123",
        activityType: "calculateTotals",
        attempt: 1,
        runId: "run-fn-123",
        source: "tool",
        taskQueue: "mastra",
        workflowId: "wf-fn-123",
        workflowType: "crypto-agent"
      },
      async () => tracedFn(2, 3)
    );

    await controller.shutdown();
    await openBoxServer.close();

    expect(result).toBe(5);

    const hookEvents = openBoxServer.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(
        payload =>
          isHookSpanPayload(
            payload,
            "function_call",
            "started"
          ) ||
          isHookSpanPayload(
            payload,
            "function_call",
            "completed"
          )
      );

    expect(hookEvents.length).toBeGreaterThanOrEqual(2);
    const startedEvent = hookEvents.find(payload =>
      isHookSpanPayload(payload, "function_call", "started")
    );
    const completedEvent = hookEvents.find(payload =>
      isHookSpanPayload(payload, "function_call", "completed")
    );
    expect(startedEvent).toBeDefined();
    expect(completedEvent).toBeDefined();
    if (!startedEvent || !completedEvent) {
      throw new Error("Expected started/completed function_call hook events");
    }
    const startedSpan = getHookSpan(startedEvent);
    const completedSpan = getHookSpan(completedEvent);

    expect(startedSpan).toMatchObject({
      args: [2, 3],
      function: "sum",
      hook_type: "function_call",
      module: "math"
    });
    expect(completedSpan).toMatchObject({
      function: "sum",
      hook_type: "function_call",
      module: "math",
      result: 5
    });
    expect(startedSpan?.data).toMatchObject({
      args: [2, 3],
      function: "sum",
      module: "math"
    });
    expect(completedSpan?.data).toMatchObject({
      function: "sum",
      module: "math",
      result: 5
    });
    expect(startedEvent.span_count).toBe(1);
    expect(completedEvent.span_count).toBe(1);
  });

  it("raises ApprovalPendingError for traced function calls when governance requires approval", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate(body) {
        const span = getHookSpan(body);

        if (
          span?.hook_type === "function_call" &&
          span?.stage === "started"
        ) {
          return {
            reason: "Function execution requires approval",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_approval_function",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const tracedFn = traced(
      async () => 42,
      {
        module: "math",
        name: "constant"
      }
    );

    await expect(
      runWithOpenBoxExecutionContext(
        {
          activityId: "act-fn-approval-123",
          activityType: "calculateTotals",
          attempt: 1,
          runId: "run-fn-approval-123",
          source: "tool",
          taskQueue: "mastra",
          workflowId: "wf-fn-approval-123",
          workflowType: "crypto-agent"
        },
        async () => tracedFn()
      )
    ).rejects.toBeInstanceOf(ApprovalPendingError);

    await controller.shutdown();
    await openBoxServer.close();
  });

  it("emits started/completed hook governance events for database queries", async () => {
    const openBoxServer = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_events_db",
      apiUrl: openBoxServer.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      captureHttpBodies: false,
      dbLibraries: new Set(["pg"]),
      governanceClient: client,
      instrumentDatabases: true,
      instrumentFileIo: false,
      spanProcessor
    });
    const pgInstrumentation = controller.instrumentations.find(
      instrumentation =>
        instrumentation.instrumentationName ===
        "@opentelemetry/instrumentation-pg"
    );

    expect(pgInstrumentation).toBeDefined();

    const pgConfig = (
      pgInstrumentation as {
        getConfig: () => {
          requestHook?: (
            span: unknown,
            info: {
              connection?: {
                database?: string;
                host?: string;
                port?: number;
              };
              query?: {
                text?: string;
              };
            }
          ) => void;
          responseHook?: (span: unknown) => void;
        };
      }
    ).getConfig();
    const requestHook = pgConfig.requestHook;
    const responseHook = pgConfig.responseHook;

    expect(requestHook).toBeTypeOf("function");
    expect(responseHook).toBeTypeOf("function");

    const tracer = trace.getTracer("openbox-test-db");
    const rootSpan = tracer.startSpan("activity.getCryptoPrice", {
      attributes: {
        "openbox.activity_id": "act-db-123",
        "openbox.run_id": "run-db-123",
        "openbox.workflow_id": "wf-db-123"
      }
    });
    const dbSpan = tracer.startSpan("SELECT bitcoin", {
      attributes: {
        "db.name": "crypto",
        "db.operation": "SELECT",
        "db.statement": "select * from coins where id = $1",
        "db.system": "postgresql",
        "server.address": "127.0.0.1",
        "server.port": 5432
      }
    });

    spanProcessor.registerTrace(
      rootSpan.spanContext().traceId,
      "wf-db-123",
      "act-db-123",
      "run-db-123"
    );

    await runWithOpenBoxExecutionContext(
      {
        activityId: "act-db-123",
        activityType: "getCryptoPrice",
        attempt: 1,
        runId: "run-db-123",
        source: "tool",
        taskQueue: "mastra",
        workflowId: "wf-db-123",
        workflowType: "crypto-agent"
      },
      async () => {
        await context.with(trace.setSpan(context.active(), rootSpan), async () => {
          requestHook?.(dbSpan as never, {
            connection: {
              database: "crypto",
              host: "127.0.0.1",
              port: 5432
            },
            query: {
              text: "select * from coins where id = $1"
            }
          });
          responseHook?.(dbSpan as never);
        });
      }
    );

    dbSpan.end();
    rootSpan.end();
    await waitFor(
      () =>
        openBoxServer.requests
          .filter(request => request.pathname === "/api/v1/governance/evaluate")
          .map(request => request.body)
          .filter(
            payload =>
              isHookSpanPayload(
                payload,
                "db_query",
                "started"
              ) ||
              isHookSpanPayload(
                payload,
                "db_query",
                "completed"
              )
          ).length >= 1,
      2000
    );
    await controller.shutdown();
    await openBoxServer.close();

    const hookEvents = openBoxServer.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .filter(
        payload =>
          isHookSpanPayload(
            payload,
            "db_query",
            "started"
          ) ||
          isHookSpanPayload(
            payload,
            "db_query",
            "completed"
          )
      );

    expect(hookEvents.length).toBeGreaterThanOrEqual(2);
    const startedEvent = hookEvents.find(payload =>
      isHookSpanPayload(payload, "db_query", "started")
    );
    const completedEvent = hookEvents.find(payload =>
      isHookSpanPayload(payload, "db_query", "completed")
    );
    expect(startedEvent).toBeDefined();
    expect(completedEvent).toBeDefined();
    if (!startedEvent || !completedEvent) {
      throw new Error("Expected started/completed db_query hook events");
    }
    const startedSpan = getHookSpan(startedEvent);
    const completedSpan = getHookSpan(completedEvent);

    expect(startedSpan).toMatchObject({
      db_name: "crypto",
      db_operation: "SELECT",
      db_system: "postgresql",
      hook_type: "db_query"
    });
    expect(completedSpan).toMatchObject({
      db_name: "crypto",
      db_operation: "SELECT",
      db_system: "postgresql",
      hook_type: "db_query"
    });
    expect(startedSpan?.data).toMatchObject({
      db_name: "crypto",
      db_operation: "SELECT",
      db_system: "postgresql"
    });
    expect(completedSpan?.data).toMatchObject({
      db_name: "crypto",
      db_operation: "SELECT",
      db_system: "postgresql"
    });
    expect(startedSpan?.semantic_type).toBe("database_select");
    expect(completedSpan?.semantic_type).toBe("database_select");
    expect(startedSpan?.span_id).toBe(completedSpan?.span_id);
    expect(startedEvent.span_count).toBe(1);
    expect(completedEvent.span_count).toBe(1);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}
