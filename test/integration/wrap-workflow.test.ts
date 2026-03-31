import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  ApprovalExpiredError,
  OpenBoxClient,
  OpenBoxSpanProcessor,
  parseOpenBoxConfig,
  wrapWorkflow
} from "../../src/index.js";
import { startOpenBoxServer } from "../helpers/openbox-server.js";

describe("wrapWorkflow", () => {
  it("emits workflow lifecycle and step activity events for successful runs", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_workflow",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const step = createStep({
      execute: async ({ inputData }) => ({
        result: inputData.value.toUpperCase()
      }),
      id: "uppercase-step",
      inputSchema: z.object({
        value: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      })
    });
    const workflow = wrapWorkflow(
      createWorkflow({
        id: "uppercase-workflow",
        inputSchema: z.object({
          value: z.string()
        }),
        outputSchema: z.object({
          result: z.string()
        })
      })
        .then(step)
        .commit(),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );
    const mastra = new Mastra({
      storage: new InMemoryStore(),
      workflows: {
        uppercase: workflow
      }
    });
    const run = await mastra.getWorkflow("uppercase").createRun();
    const result = await run.start({
      inputData: {
        value: "hello"
      }
    });

    await server.close();

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(`Expected success, received ${result.status}`);
    }
    expect(result.result).toEqual({ result: "HELLO" });
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toEqual([
      "WorkflowStarted",
      "ActivityStarted",
      "ActivityCompleted",
      "WorkflowCompleted"
    ]);

    const [, stepStarted, stepCompleted, workflowCompleted] = server.requests
      .filter(request => request.pathname === "/api/v1/governance/evaluate")
      .map(request => request.body);

    expect(stepStarted).toMatchObject({
      activity_input: {
        value: "hello"
      },
      activity_type: "uppercaseStep"
    });
    expect(stepCompleted).toMatchObject({
      activity_output: {
        result: "HELLO"
      },
      status: "completed"
    });
    expect(workflowCompleted).toMatchObject({
      event_type: "WorkflowCompleted",
      workflow_output: {
        result: "HELLO"
      }
    });
  });

  it("polls approval on resume and completes the workflow once OpenBox allows it", async () => {
    let startedCount = 0;
    let executions = 0;
    const server = await startOpenBoxServer({
      approval(body) {
        expect(body).toMatchObject({
          activity_id: "approval-workflow:approve-step",
          run_id: expect.any(String),
          workflow_id: "approval-workflow"
        });

        return { verdict: "allow" };
      },
      evaluate(body) {
        if (body.event_type === "ActivityStarted" && startedCount === 0) {
          startedCount += 1;

          return {
            approval_id: "approval-123",
            reason: "Needs review",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_workflow",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const step = createStep({
      execute: async ({ inputData }) => {
        executions += 1;

        return {
          result: inputData.value.toUpperCase()
        };
      },
      id: "approve-step",
      inputSchema: z.object({
        value: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      }),
      resumeSchema: z.object({
        approved: z.boolean()
      }).optional(),
      suspendSchema: z.object({
        openbox: z.object({
          approvalId: z.string().optional(),
          runId: z.string(),
          workflowId: z.string()
        })
      }).optional()
    });
    const workflow = wrapWorkflow(
      createWorkflow({
        id: "approval-workflow",
        inputSchema: z.object({
          value: z.string()
        }),
        outputSchema: z.object({
          result: z.string()
        })
      })
        .then(step)
        .commit(),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );
    const mastra = new Mastra({
      storage: new InMemoryStore(),
      workflows: {
        approval: workflow
      }
    });
    const run = await mastra.getWorkflow("approval").createRun();
    const firstResult = await run.start({
      inputData: {
        value: "hello"
      }
    });

    expect(firstResult.status).toBe("suspended");
    if (firstResult.status !== "suspended") {
      throw new Error(`Expected suspended, received ${firstResult.status}`);
    }
    expect(firstResult.suspendPayload).toMatchObject({
      "approve-step": {
        openbox: {
          approvalId: "approval-123",
          workflowId: "approval-workflow"
        }
      }
    });
    expect(executions).toBe(0);

    const resumedResult = await run.resume({
      resumeData: {
        approved: true
      },
      step: "approve-step"
    });

    await server.close();

    expect(resumedResult.status).toBe("success");
    if (resumedResult.status !== "success") {
      throw new Error(`Expected success, received ${resumedResult.status}`);
    }
    expect(resumedResult.result).toEqual({ result: "HELLO" });
    expect(executions).toBe(1);
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toEqual([
      "WorkflowStarted",
      "ActivityStarted",
      "SignalReceived",
      "ActivityStarted",
      "ActivityCompleted",
      "WorkflowCompleted"
    ]);
  });

  it("raises ApprovalExpiredError when the stored approval has expired on resume", async () => {
    const server = await startOpenBoxServer({
      approval() {
        return {
          approval_expiration_time: "2000-01-01T00:00:00Z",
          verdict: "allow"
        };
      },
      evaluate(body) {
        if (body.event_type === "ActivityStarted") {
          return {
            approval_id: "approval-expired",
            reason: "Needs review",
            verdict: "require_approval"
          };
        }

        return { verdict: "allow" };
      }
    });
    const config = parseOpenBoxConfig({
      apiKey: "obx_test_workflow",
      apiUrl: server.url,
      validate: false
    });
    const client = new OpenBoxClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      onApiError: config.onApiError,
      timeoutSeconds: config.governanceTimeout
    });
    const execute = vi.fn(async ({ inputData }: { inputData: { value: string } }) => ({
      result: inputData.value.toUpperCase()
    }));
    const workflow = wrapWorkflow(
      createWorkflow({
        id: "expired-workflow",
        inputSchema: z.object({
          value: z.string()
        }),
        outputSchema: z.object({
          result: z.string()
        })
      })
        .then(
          createStep({
            execute,
            id: "approve-step",
            inputSchema: z.object({
              value: z.string()
            }),
            outputSchema: z.object({
              result: z.string()
            }),
            resumeSchema: z.object({
              approved: z.boolean()
            }).optional(),
            suspendSchema: z.object({
              openbox: z.object({
                approvalId: z.string().optional(),
                runId: z.string(),
                workflowId: z.string()
              })
            }).optional()
          })
        )
        .commit(),
      {
        client,
        config,
        spanProcessor: new OpenBoxSpanProcessor()
      }
    );
    const mastra = new Mastra({
      storage: new InMemoryStore(),
      workflows: {
        expired: workflow
      }
    });
    const run = await mastra.getWorkflow("expired").createRun();
    const firstResult = await run.start({
      inputData: {
        value: "hello"
      }
    });

    expect(firstResult.status).toBe("suspended");

    await expect(
      run.resume({
        resumeData: {
          approved: true
        },
        step: "approve-step"
      })
    ).rejects.toBeInstanceOf(ApprovalExpiredError);

    await server.close();

    expect(execute).not.toHaveBeenCalled();
  });
});
