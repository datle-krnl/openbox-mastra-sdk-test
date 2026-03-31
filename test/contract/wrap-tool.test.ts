import { createServer } from "node:http";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import {
  GuardrailsValidationError,
  GovernanceHaltError,
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  setupOpenBoxOpenTelemetry,
  wrapTool
} from "../../src/index.js";
import { startOpenBoxServer } from "../helpers/openbox-server.js";

function getHookSpan(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (payload.hook_trigger !== true) {
    return undefined;
  }

  const spans = payload.spans;

  if (!Array.isArray(spans) || spans.length === 0) {
    return undefined;
  }

  const first = spans[0];
  return first && typeof first === "object"
    ? (first as Record<string, unknown>)
    : undefined;
}

function getHookSpans(
  payload: Record<string, unknown>
): Array<Record<string, unknown>> {
  if (payload.hook_trigger !== true) {
    return [];
  }

  const spans = payload.spans;

  if (!Array.isArray(spans)) {
    return [];
  }

  return spans.filter(
    span => span && typeof span === "object"
  ) as Array<Record<string, unknown>>;
}

describe("wrapTool", () => {
  it("sends activity events and applies guardrail redaction before and after execution", async () => {
    const server = await startOpenBoxServer({
      evaluate(body) {
        if (body.event_type === "ActivityStarted") {
          return {
            guardrails_result: {
              input_type: "activity_input",
              redacted_input: [
                {
                  prompt: "[redacted]"
                }
              ],
              validation_passed: true
            },
            verdict: "allow"
          };
        }

        if (body.event_type === "ActivityCompleted") {
          return {
            guardrails_result: {
              input_type: "activity_output",
              redacted_input: {
                result: "safe-output"
              },
              validation_passed: true
            },
            verdict: "allow"
          };
        }

        return { verdict: "allow" };
      }
    });

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_contract",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const receivedInputs: Array<Record<string, unknown>> = [];
    const tool = createTool({
      description: "Process a prompt",
      id: "process-prompt",
      inputSchema: z.object({
        prompt: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      }),
      async execute(input) {
        receivedInputs.push({ ...input });

        return {
          result: `processed:${input.prompt}`
        };
      }
    });
    const wrapped = wrapTool(tool, {
      client,
      config,
      spanProcessor
    });

    const result = await wrapped.execute?.(
      { prompt: "secret prompt" },
      {
        workflow: {
          runId: "run-123",
          setState: vi.fn(),
          state: {},
          suspend: vi.fn(async () => undefined),
          workflowId: "wf-123"
        }
      }
    );

    await server.close();

    expect(receivedInputs).toEqual([{ prompt: "[redacted]" }]);
    expect(result).toEqual({ result: "safe-output" });
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toEqual(["ActivityStarted", "ActivityCompleted"]);

    const [startedEvent, completedEvent] = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body);

    expect(startedEvent).toMatchObject({
      activity_input: {
        prompt: "secret prompt"
      },
      activity_type: "processPrompt",
      event_type: "ActivityStarted",
      run_id: "run-123",
      workflow_id: "wf-123"
    });
    expect(completedEvent).toMatchObject({
      activity_input: [
        {
          prompt: "[redacted]"
        }
      ],
      activity_output: {
        result: "processed:[redacted]"
      },
      event_type: "ActivityCompleted",
      run_id: "run-123",
      status: "completed",
      workflow_id: "wf-123"
    });
    expect((completedEvent as Record<string, unknown>).activity_type).toBeUndefined();
    expect(completedEvent).toMatchObject({
      span_count: 0
    });
    expect((completedEvent as Record<string, unknown>)?.spans).toBeUndefined();
  });

  it("suspends execution when governance requires approval", async () => {
    const server = await startOpenBoxServer({
      evaluate(body) {
        if (body.event_type === "ActivityStarted") {
          return {
            approval_id: "approval-123",
            reason: "Needs human review",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_contract",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const execute = vi.fn(async () => ({ result: "should-not-run" }));
    const suspend = vi.fn(async () => undefined);
    const tool = createTool({
      description: "Delete a record",
      id: "delete-record",
      inputSchema: z.object({
        id: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      }),
      execute
    });
    const wrapped = wrapTool(tool, {
      client,
      config,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const result = await wrapped.execute?.(
      { id: "rec-1" },
      {
        workflow: {
          runId: "run-approve",
          setState: vi.fn(),
          state: {},
          suspend,
          workflowId: "wf-approve"
        }
      }
    );

    await server.close();

    expect(result).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledTimes(1);
    const suspendCall = suspend.mock.calls.at(0);

    expect(suspendCall).toBeDefined();

    const suspendPayload = suspendCall
      ? (suspendCall as unknown[])[0]
      : undefined;

    expect(suspendPayload).toMatchObject({
      openbox: {
        activityId: "wf-approve:delete-record",
        activityType: "deleteRecord",
        approvalId: "approval-123",
        reason: "Needs human review",
        runId: "run-approve",
        workflowId: "wf-approve"
      }
    });
  });

  it("requests approval only once when both activity start and completion require approval", async () => {
    let approvalCalls = 0;

    const server = await startOpenBoxServer({
      approval() {
        approvalCalls += 1;
        return { action: "allow" };
      },
      evaluate(body) {
        if (
          body.event_type === "ActivityStarted" ||
          body.event_type === "ActivityCompleted"
        ) {
          return {
            reason: "Needs approval",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_contract",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });

    const tool = createTool({
      description: "Create sandbox metadata",
      id: "create-sandbox-metadata",
      inputSchema: z.object({
        name: z.string()
      }),
      outputSchema: z.object({
        ok: z.boolean()
      }),
      async execute() {
        return { ok: true };
      }
    });

    const wrapped = wrapTool(tool, {
      client,
      config,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    const result = await wrapped.execute?.({ name: "demo" }, {});

    const lifecycleEventTypes = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body.event_type)
      .filter(
        (eventType): eventType is string =>
          eventType === "ActivityStarted" || eventType === "ActivityCompleted"
      );

    await server.close();

    expect(result).toEqual({ ok: true });
    expect(approvalCalls).toBe(1);
    expect(lifecycleEventTypes).toContain("ActivityStarted");
    expect(lifecycleEventTypes).toContain("ActivityCompleted");
  });

  it("fails closed when guardrails validation rejects tool input", async () => {
    const server = await startOpenBoxServer({
      evaluate(body) {
        if (body.event_type === "ActivityStarted") {
          return {
            guardrails_result: {
              input_type: "activity_input",
              reasons: [{ reason: "prompt contains secrets" }],
              redacted_input: {
                prompt: "[blocked]"
              },
              validation_passed: false
            },
            verdict: "allow"
          };
        }

        return { verdict: "allow" };
      }
    });

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_contract",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const tool = createTool({
      description: "Process prompt",
      id: "guarded-tool",
      inputSchema: z.object({
        prompt: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      }),
      async execute(input) {
        return {
          result: input.prompt
        };
      }
    });
    const wrapped = wrapTool(tool, {
      client,
      config,
      spanProcessor: new OpenBoxSpanProcessor()
    });

    await expect(
      wrapped.execute?.(
        { prompt: "secret prompt" },
        {
          workflow: {
            runId: "run-guardrails",
            setState: vi.fn(),
            state: {},
            suspend: vi.fn(async () => undefined),
            workflowId: "wf-guardrails"
          }
        }
      )
    ).rejects.toBeInstanceOf(GuardrailsValidationError);

    await server.close();
  });

  it("suspends when hook-level HTTP governance requires approval during execution", async () => {
    const server = await startOpenBoxServer({
      evaluate(body) {
        const span = getHookSpan(body);

        if (
          span?.hook_type === "http_request" &&
          span?.stage === "started"
        ) {
          return {
            reason: "External request needs approval",
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

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_approval_suspend",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const telemetry = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const suspend = vi.fn(async () => undefined);
    const wrapped = wrapTool(
      createTool({
        description: "Fetch remote data",
        id: "fetch-remote-data",
        inputSchema: z.object({
          id: z.string()
        }),
        outputSchema: z.object({
          ok: z.boolean()
        }),
        async execute() {
          const response = await fetch(`http://127.0.0.1:${address.port}/data`);

          return (await response.json()) as { ok: boolean };
        }
      }),
      {
        client,
        config,
        spanProcessor
      }
    );

    const result = await wrapped.execute?.(
      { id: "coin-1" },
      {
        workflow: {
          runId: "run-hook-approval",
          setState: vi.fn(),
          state: {},
          suspend,
          workflowId: "wf-hook-approval"
        }
      }
    );

    await telemetry.shutdown();
    await server.close();
    downstream.close();

    expect(result).toBeUndefined();
    expect(suspend).toHaveBeenCalledTimes(1);
    const suspendCall = suspend.mock.calls.at(0);
    const suspendPayload = suspendCall
      ? (suspendCall as unknown[])[0]
      : undefined;

    expect(suspendPayload).toMatchObject({
      openbox: {
        activityId: "wf-hook-approval:fetch-remote-data",
        activityType: "fetchRemoteData",
        reason: "External request needs approval",
        runId: "run-hook-approval",
        workflowId: "wf-hook-approval"
      }
    });
  });

  it("fails with GovernanceHaltError when hook-level HTTP governance returns HALT", async () => {
    const server = await startOpenBoxServer({
      evaluate(body) {
        const span = getHookSpan(body);

        if (
          span?.hook_type === "http_request" &&
          span?.stage === "started"
        ) {
          return {
            reason: "Emergency stop",
            verdict: "halt"
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

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_halt",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const telemetry = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const wrapped = wrapTool(
      createTool({
        description: "Fetch remote data",
        id: "fetch-remote-data",
        inputSchema: z.object({
          id: z.string()
        }),
        outputSchema: z.object({
          ok: z.boolean()
        }),
        async execute() {
          const response = await fetch(`http://127.0.0.1:${address.port}/data`);

          return (await response.json()) as { ok: boolean };
        }
      }),
      {
        client,
        config,
        spanProcessor
      }
    );

    await expect(
      wrapped.execute?.(
        { id: "coin-1" },
        {
          workflow: {
            runId: "run-hook-halt",
            setState: vi.fn(),
            state: {},
            suspend: vi.fn(async () => undefined),
            workflowId: "wf-hook-halt"
          }
        }
      )
    ).rejects.toBeInstanceOf(GovernanceHaltError);

    await telemetry.shutdown();
    await server.close();
    downstream.close();
  });

  it("uses hook-scoped activity IDs so hook completion cannot shadow final completion", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
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

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_hook_activity_ids",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const spanProcessor = new OpenBoxSpanProcessor();
    const telemetry = setupOpenBoxOpenTelemetry({
      captureHttpBodies: true,
      governanceClient: client,
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor
    });
    const wrapped = wrapTool(
      createTool({
        description: "Fetch remote data",
        id: "fetch-remote-data",
        inputSchema: z.object({
          id: z.string()
        }),
        outputSchema: z.object({
          ok: z.boolean()
        }),
        async execute() {
          const response = await fetch(`http://127.0.0.1:${address.port}/data`);

          return (await response.json()) as { ok: boolean };
        }
      }),
      {
        client,
        config,
        spanProcessor
      }
    );

    const result = await wrapped.execute?.(
      { id: "coin-1" },
      {
        workflow: {
          runId: "run-hook-ids",
          setState: vi.fn(),
          state: {},
          suspend: vi.fn(async () => undefined),
          workflowId: "wf-hook-ids"
        }
      }
    );

    await telemetry.shutdown();
    await server.close();
    downstream.close();

    expect(result).toEqual({ ok: true });

    const payloads = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body);
    const hookLifecycleEventTypes = payloads
      .filter(payload => payload.hook_trigger === true)
      .map(payload => payload.event_type);
    const hookStartedEvent = payloads.find(
      payload =>
        payload.event_type === "ActivityStarted" &&
        getHookSpans(payload).some(
          span =>
            span.hook_type === "http_request" &&
            span.stage === "started"
        )
    );
    const hookCompletedEvent = payloads.find(
      payload =>
        payload.event_type === "ActivityStarted" &&
        getHookSpans(payload).some(
          span =>
            span.hook_type === "http_request" &&
            span.stage === "completed"
        )
    );
    const finalCompleted = payloads.find(
      payload =>
        payload.event_type === "ActivityCompleted" &&
        payload.hook_trigger !== true &&
        Object.prototype.hasOwnProperty.call(payload, "activity_output")
    );

    expect(hookLifecycleEventTypes).toEqual([
      "ActivityStarted",
      "ActivityStarted"
    ]);
    expect(hookStartedEvent).toBeDefined();
    expect(hookCompletedEvent).toBeDefined();
    expect(finalCompleted).toBeDefined();
    expect(hookStartedEvent?.activity_id).toBe("wf-hook-ids:fetch-remote-data");
    expect(hookCompletedEvent?.activity_id).toBe("wf-hook-ids:fetch-remote-data");
    expect(finalCompleted?.activity_id).toBe("wf-hook-ids:fetch-remote-data");
    expect(finalCompleted?.activity_id).toBe(hookStartedEvent?.activity_id);
    expect(finalCompleted?.activity_output).toEqual({ ok: true });
  });

  it("normalizes spaced activity type names to camelCase", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });

    const config = parseOpenBoxConfig({
      apiKey: "obx_test_contract",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const wrapped = wrapTool(
      createTool({
        description: "Search all available crypto coins by a keyword",
        id: "Search crypto coins",
        inputSchema: z.object({
          keyword: z.string()
        }),
        outputSchema: z.object({
          id: z.string()
        }),
        async execute(input) {
          return {
            id: input.keyword
          };
        }
      }),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );

    await wrapped.execute?.(
      { keyword: "bitcoin" },
      {
        workflow: {
          runId: "run-camel",
          setState: vi.fn(),
          state: {},
          suspend: vi.fn(async () => undefined),
          workflowId: "wf-camel"
        }
      }
    );

    await server.close();

    const startedEvent = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body)
      .find(payload => payload.event_type === "ActivityStarted");

    expect(startedEvent).toBeDefined();
    expect(startedEvent?.activity_type).toBe("searchCryptoCoins");
  });
});
