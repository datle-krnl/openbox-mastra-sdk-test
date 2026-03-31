import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface OpenBoxRequestRecord {
  body: Record<string, unknown>;
  method: string;
  pathname: string;
}

export interface OpenBoxServerHandlers {
  approval?: (
    body: Record<string, unknown>
  ) => OpenBoxHandlerResult | Promise<OpenBoxHandlerResult>;
  evaluate?: (
    body: Record<string, unknown>
  ) => OpenBoxHandlerResult | Promise<OpenBoxHandlerResult>;
  validate?: (
    body: Record<string, unknown>
  ) => OpenBoxHandlerResult | Promise<OpenBoxHandlerResult>;
}

export type OpenBoxHandlerResult =
  | Record<string, unknown>
  | {
      body: Record<string, unknown>;
      statusCode: number;
    };

export interface OpenBoxTestServer {
  close: () => Promise<void>;
  requests: OpenBoxRequestRecord[];
  url: string;
}

export async function startOpenBoxServer(
  handlers: OpenBoxServerHandlers
): Promise<OpenBoxTestServer> {
  const requests: OpenBoxRequestRecord[] = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readJsonBody(request);
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

      requests.push({
        body,
        method: request.method ?? "GET",
        pathname
      });

      if (pathname === "/api/v1/auth/validate") {
        const handlerResult = (await handlers.validate?.(body)) ?? { ok: true };
        const { body: payload, statusCode } = normalizeHandlerResult(handlerResult);
        writeJson(response, statusCode, payload);
        return;
      }

      if (pathname === "/api/v1/governance/evaluate") {
        const handlerResult =
          (await handlers.evaluate?.(body)) ?? { verdict: "allow" };
        const { body: payload, statusCode } = normalizeHandlerResult(handlerResult);
        writeJson(response, statusCode, payload);
        return;
      }

      if (pathname === "/api/v1/governance/approval") {
        const handlerResult =
          (await handlers.approval?.(body)) ?? { verdict: "allow" };
        const { body: payload, statusCode } = normalizeHandlerResult(handlerResult);
        writeJson(response, statusCode, payload);
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected an HTTP server address");
  }

  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    requests,
    url: `http://127.0.0.1:${address.port}`
  };
}

async function readJsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function normalizeHandlerResult(result: OpenBoxHandlerResult): {
  body: Record<string, unknown>;
  statusCode: number;
} {
  if (isStructuredHandlerResult(result)) {
    return {
      body: result.body,
      statusCode: result.statusCode
    };
  }

  return {
    body: result,
    statusCode: 200
  };
}

function isStructuredHandlerResult(
  result: OpenBoxHandlerResult
): result is { body: Record<string, unknown>; statusCode: number } {
  return (
    "statusCode" in result &&
    typeof result.statusCode === "number" &&
    "body" in result &&
    result.body !== null &&
    typeof result.body === "object"
  );
}
