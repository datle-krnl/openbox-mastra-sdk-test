import { createServer } from "node:http";

import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { getOpenBoxRuntime, withOpenBox } from "../../dist/index.js";

const openBoxServer = await startMockOpenBoxServer();
let governedMastra;

const transferTool = createTool({
  description: "Executes a transfer after governance checks pass.",
  id: "transfer-funds",
  inputSchema: z.object({
    amount: z.number(),
    destination: z.string()
  }),
  outputSchema: z.object({
    confirmationId: z.string(),
    destination: z.string(),
    status: z.literal("sent")
  }),
  async execute(input) {
    return {
      confirmationId: "tx-demo-001",
      destination: input.destination,
      status: "sent"
    };
  }
});

const summaryAgent = new Agent({
  id: "ops-summary-agent",
  instructions: "Summarize operational actions in one sentence.",
  model: createMockModel({
    mockText: "Transfer approved, sent, and summarized for operations.",
    version: "v2"
  }),
  name: "Operations Summary Agent"
});

const prepareTransferStep = createStep({
  execute: async ({ inputData }) => inputData,
  id: "prepare-transfer-step",
  inputSchema: z.object({
    amount: z.number(),
    destination: z.string()
  }),
  outputSchema: z.object({
    amount: z.number(),
    destination: z.string()
  }),
  resumeSchema: z
    .object({
      approved: z.boolean(),
      approvedBy: z.string()
    })
    .optional(),
  suspendSchema: z
    .object({
      openbox: z.object({
        approvalId: z.string().optional(),
        runId: z.string(),
        workflowId: z.string()
      })
    })
    .optional()
});

const executeTransferStep = createStep({
  execute: async ({ inputData, runId, setState, state, suspend, workflowId }) => {
    const result = await governedMastra.getTool("transfer").execute?.(
      {
        amount: inputData.amount,
        destination: inputData.destination
      },
      {
        workflow: {
          runId,
          setState,
          state,
          suspend,
          workflowId
        }
      }
    );

    if (!result) {
      throw new Error("Expected the transfer tool to return a result");
    }

    return {
      amount: inputData.amount,
      confirmationId: result.confirmationId,
      destination: result.destination,
      status: result.status
    };
  },
  id: "execute-transfer-step",
  inputSchema: z.object({
    amount: z.number(),
    destination: z.string()
  }),
  outputSchema: z.object({
    amount: z.number(),
    confirmationId: z.string(),
    destination: z.string(),
    status: z.literal("sent")
  })
});

const summarizeTransferStep = createStep({
  execute: async ({ inputData, runId }) => {
    const summary = await governedMastra
      .getAgent("opsSummary")
      .generate(
        `Summarize transfer ${inputData.confirmationId} to ${inputData.destination}.`,
        {
          runId: `${runId}:ops-summary`
        }
      );

    return {
      confirmationId: inputData.confirmationId,
      destination: inputData.destination,
      status: inputData.status,
      summary: summary.text
    };
  },
  id: "summarize-transfer-step",
  inputSchema: z.object({
    amount: z.number(),
    confirmationId: z.string(),
    destination: z.string(),
    status: z.literal("sent")
  }),
  outputSchema: z.object({
    confirmationId: z.string(),
    destination: z.string(),
    status: z.literal("sent"),
    summary: z.string()
  })
});

const transferWorkflow = createWorkflow({
  id: "governed-transfer-workflow",
  inputSchema: z.object({
    amount: z.number(),
    destination: z.string()
  }),
  outputSchema: z.object({
    confirmationId: z.string(),
    destination: z.string(),
    status: z.literal("sent"),
    summary: z.string()
  })
})
  .then(prepareTransferStep)
  .then(executeTransferStep)
  .then(summarizeTransferStep)
  .commit();

const mastra = new Mastra({
  agents: {
    opsSummary: summaryAgent
  },
  storage: new InMemoryStore(),
  tools: {
    transfer: transferTool
  },
  workflows: {
    transferApproval: transferWorkflow
  }
});

try {
  governedMastra = await withOpenBox(mastra, {
    apiKey: "obx_test_example_quickstart",
    apiUrl: openBoxServer.url,
    validate: false
  });

  const workflowRun = await governedMastra
    .getWorkflow("transferApproval")
    .createRun();

  console.log("Starting governed workflow...");

  const firstResult = await workflowRun.start({
    inputData: {
      amount: 4200,
      destination: "Vendor Escrow"
    }
  });

  if (firstResult.status !== "suspended") {
    throw new Error(`Expected workflow suspension, received ${firstResult.status}`);
  }

  console.log("Workflow suspended for approval:");
  console.log(JSON.stringify(firstResult.suspendPayload, null, 2));

  console.log("Resuming workflow after operator approval...");

  const resumedResult = await workflowRun.resume({
    resumeData: {
      approved: true,
      approvedBy: "operator@example.com"
    },
    step: "prepare-transfer-step"
  });

  if (resumedResult.status !== "success") {
    throw new Error(`Expected workflow success, received ${resumedResult.status}`);
  }

  console.log("Workflow completed:");
  console.log(JSON.stringify(resumedResult.result, null, 2));

  console.log("Governance events:");
  console.log(
    JSON.stringify(
      openBoxServer.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type),
      null,
      2
    )
  );
} finally {
  await getOpenBoxRuntime(governedMastra)?.shutdown();
  await openBoxServer.close();
}

async function startMockOpenBoxServer() {
  const requests = [];
  let approvalRequested = false;
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    requests.push({
      body,
      method: request.method ?? "GET",
      pathname
    });

    if (pathname === "/api/v1/auth/validate") {
      writeJson(response, 200, { ok: true });
      return;
    }

    if (pathname === "/api/v1/governance/evaluate") {
      if (
        body.event_type === "ActivityStarted" &&
        body.activity_type === "prepare-transfer-step" &&
        !approvalRequested
      ) {
        approvalRequested = true;
        writeJson(response, 200, {
          approval_id: "approval-demo-001",
          reason: "Operator approval required for high-value transfer",
          verdict: "require_approval"
        });
        return;
      }

      writeJson(response, 200, { verdict: "allow" });
      return;
    }

    if (pathname === "/api/v1/governance/approval") {
      writeJson(response, 200, { verdict: "allow" });
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  await new Promise(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected an HTTP address");
  }

  return {
    async close() {
      await new Promise((resolve, reject) => {
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

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
