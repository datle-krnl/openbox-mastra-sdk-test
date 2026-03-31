import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { context, trace } from "@opentelemetry/api";

import {
  OpenBoxSpanProcessor,
  setupOpenBoxOpenTelemetry,
  WorkflowSpanBuffer
} from "../../src/index.js";

describe("setupOpenBoxOpenTelemetry", () => {
  it("captures HTTP bodies outside span attributes and ignores configured URLs", async () => {
    const server = createServer((request, response) => {
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
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Expected an HTTP server address");
    }

    const processor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      ignoredUrls: ["https://api.openbox.ai"],
      instrumentDatabases: false,
      instrumentFileIo: false,
      spanProcessor: processor
    });
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });

    processor.registerWorkflow("wf-123", buffer);

    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("workflow.fetch", {
      attributes: {
        "openbox.workflow_id": "wf-123"
      }
    });

    await context.with(trace.setSpan(context.active(), rootSpan), async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/echo`, {
        body: JSON.stringify({ secret: "top-secret" }),
        headers: {
          "content-type": "application/json",
          "x-test-header": "value"
        },
        method: "POST"
      });

      await response.text();
    });

    rootSpan.end();
    await controller.shutdown();
    server.close();

    expect(buffer.spans.length).toBeGreaterThan(0);

    const spanWithBodies = buffer.spans.find(
      span =>
        typeof span === "object" &&
        span !== null &&
        "requestBody" in span &&
        "responseBody" in span
    ) as {
      attributes: Record<string, unknown>;
      requestBody: string;
      requestHeaders: Record<string, string>;
      responseBody: string;
    };

    expect(spanWithBodies.requestBody).toBe('{"secret":"top-secret"}');
    expect(spanWithBodies.responseBody).toContain("top-secret");
    expect(spanWithBodies.requestHeaders["content-type"]).toBe(
      "application/json"
    );
    const requestUrl =
      (spanWithBodies.attributes["http.url"] as string | undefined) ??
      (spanWithBodies.attributes["url.full"] as string | undefined);
    expect(requestUrl).toBe(`http://127.0.0.1:${address.port}/echo`);
    expect(JSON.stringify(spanWithBodies.attributes)).not.toContain(
      "top-secret"
    );

    const workflowSpan = buffer.spans.find(
      span =>
        typeof span === "object" &&
        span !== null &&
        (span as { name?: string }).name === "workflow.fetch"
    ) as { requestBody?: string | undefined } | undefined;
    expect(workflowSpan?.requestBody).toBeUndefined();
  });

  it("creates file spans only when file I/O instrumentation is enabled and skips system paths", async () => {
    const processor = new OpenBoxSpanProcessor();
    const controller = setupOpenBoxOpenTelemetry({
      instrumentDatabases: false,
      instrumentFileIo: true,
      spanProcessor: processor
    });
    const buffer = new WorkflowSpanBuffer({
      runId: "run-456",
      taskQueue: "test-queue",
      workflowId: "wf-123",
      workflowType: "TestWorkflow"
    });
    const tempDir = await mkdtemp(join(tmpdir(), "openbox-otel-"));
    const filePath = join(tempDir, "sample.txt");

    processor.registerWorkflow("wf-123", buffer);

    const tracer = trace.getTracer("openbox-test");
    const rootSpan = tracer.startSpan("workflow.fs", {
      attributes: {
        "openbox.workflow_id": "wf-123"
      }
    });

    await context.with(trace.setSpan(context.active(), rootSpan), async () => {
      const fsPromises = await import("node:fs/promises");

      await fsPromises.writeFile(filePath, "hello world", "utf8");
      await fsPromises.readFile(filePath, "utf8");
      await fsPromises.readFile("/dev/null", "utf8");
    });

    rootSpan.end();
    await controller.shutdown();
    await rm(tempDir, { force: true, recursive: true });

    const serialized = JSON.stringify(buffer.spans);

    expect(serialized).toContain(filePath);
    expect(serialized).not.toContain("/dev/null");
  });
});
