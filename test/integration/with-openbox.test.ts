import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  getOpenBoxRuntime,
  withOpenBox
} from "../../src/index.js";
import { startOpenBoxServer } from "../helpers/openbox-server.js";

describe("withOpenBox", () => {
  it("wires existing Mastra tools, workflows, and agents in place", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });

    const topLevelTool = createTool({
      description: "Echo input",
      id: "echo-tool",
      inputSchema: z.object({
        value: z.string()
      }),
      outputSchema: z.object({
        echoed: z.string()
      }),
      async execute(input) {
        return {
          echoed: input.value
        };
      }
    });
    const workflow = createWorkflow({
      id: "uppercase-workflow",
      inputSchema: z.object({
        value: z.string()
      }),
      outputSchema: z.object({
        result: z.string()
      })
    })
      .then(
        createStep({
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
        })
      )
      .commit();
    const agent = new Agent({
      id: "assistant-agent",
      instructions: "Be concise.",
      model: createMockModel({
        mockText: "hello from governed agent",
        version: "v2"
      }) as never,
      name: "Assistant Agent"
    });
    const mastra = new Mastra({
      agents: {
        assistant: agent
      },
      storage: new InMemoryStore(),
      tools: {
        echo: topLevelTool as never
      },
      workflows: {
        uppercase: workflow
      }
    });

    const governed = await withOpenBox(mastra, {
      apiKey: "obx_test_with_openbox",
      apiUrl: server.url,
      validate: false
    });
    const runtime = getOpenBoxRuntime(governed);

    expect(governed).toBe(mastra);
    expect(runtime).toBeDefined();

    const echoTool = governed.getTool("echo") as {
      execute?: (input: { value: string }, context: unknown) => Promise<unknown>;
    };
    const toolResult = await echoTool.execute?.(
      { value: "hello" },
      {
        workflow: {
          runId: "tool-run",
          setState: vi.fn(),
          state: {},
          suspend: vi.fn(async () => undefined),
          workflowId: "tool-workflow"
        }
      }
    );
    const run = await governed.getWorkflow("uppercase").createRun();
    const workflowResult = await run.start({
      inputData: {
        value: "hello"
      }
    });
    const agentResult = await governed.getAgent("assistant").generate("hello", {
      runId: "agent-run"
    });

    await runtime?.shutdown();
    await server.close();

    expect(toolResult).toEqual({
      echoed: "hello"
    });
    expect(workflowResult.status).toBe("success");
    if (workflowResult.status !== "success") {
      throw new Error(`Expected success, received ${workflowResult.status}`);
    }
    expect(workflowResult.result).toEqual({
      result: "HELLO"
    });
    expect(agentResult.text).toBe("hello from governed agent");
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toEqual([
      "ActivityStarted",
      "ActivityCompleted",
      "WorkflowStarted",
      "ActivityStarted",
      "ActivityCompleted",
      "WorkflowCompleted",
      "WorkflowStarted",
      "SignalReceived",
      "SignalReceived",
      "WorkflowCompleted"
    ]);
  });

  it("wraps tools, workflows, agents, and agent-local tools added after initialization", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const mastra = new Mastra({
      storage: new InMemoryStore()
    });
    const governed = await withOpenBox(mastra, {
      apiKey: "obx_test_with_openbox",
      apiUrl: server.url,
      validate: false
    });
    const runtime = getOpenBoxRuntime(governed);

    governed.addTool(
      createTool({
        description: "Ping tool",
        id: "ping-tool",
        inputSchema: z.object({
          value: z.string()
        }),
        outputSchema: z.object({
          echoed: z.string()
        }),
        async execute(input) {
          return {
            echoed: `${input.value}:pong`
          };
        }
      }) as never,
      "ping"
    );
    governed.addWorkflow(
      createWorkflow({
        id: "dynamic-workflow",
        inputSchema: z.object({
          value: z.string()
        }),
        outputSchema: z.object({
          result: z.string()
        })
      })
        .then(
          createStep({
            execute: async ({ inputData }) => ({
              result: inputData.value.toUpperCase()
            }),
            id: "dynamic-step",
            inputSchema: z.object({
              value: z.string()
            }),
            outputSchema: z.object({
              result: z.string()
            })
          })
        )
        .commit(),
      "dynamicWorkflow"
    );
    governed.addAgent(
      new Agent({
        id: "dynamic-agent",
        instructions: "Use tools when needed.",
        model: createMockModel({
          mockText: "dynamic agent",
          version: "v2"
        }) as never,
        name: "Dynamic Agent",
        tools: {
          localEcho: createTool({
            description: "Agent-local echo",
            id: "agent-local-echo",
            inputSchema: z.object({
              value: z.string()
            }),
            outputSchema: z.object({
              echoed: z.string()
            }),
            async execute(input) {
              return {
                echoed: input.value.toUpperCase()
              };
            }
          }) as never
        }
      }),
      "dynamicAgent"
    );

    const pingTool = governed.getTool("ping") as {
      execute?: (input: { value: string }, context: unknown) => Promise<unknown>;
    };
    const toolResult = await pingTool.execute?.(
      { value: "hello" },
      {
        workflow: {
          runId: "ping-run",
          setState: vi.fn(),
          state: {},
          suspend: vi.fn(async () => undefined),
          workflowId: "ping-workflow"
        }
      }
    );
    const workflowRun = await governed.getWorkflow("dynamicWorkflow").createRun();
    const workflowResult = await workflowRun.start({
      inputData: {
        value: "hello"
      }
    });
    const dynamicAgent = governed.getAgent("dynamicAgent");
    const agentToolRecord = await dynamicAgent.listTools();
    const localEchoTool = agentToolRecord.localEcho;

    expect(localEchoTool).toBeDefined();

    const agentToolResult = await localEchoTool?.execute?.(
      { value: "hello" },
      {
        agent: {
          suspend: vi.fn(async () => undefined),
          toolCallId: "agent-tool-call"
        }
      } as never
    );
    const agentResult = await dynamicAgent.generate("hello", {
      runId: "dynamic-agent-run"
    });

    await runtime?.shutdown();
    await server.close();

    expect(toolResult).toEqual({
      echoed: "hello:pong"
    });
    expect(workflowResult.status).toBe("success");
    if (workflowResult.status !== "success") {
      throw new Error(`Expected success, received ${workflowResult.status}`);
    }
    expect(workflowResult.result).toEqual({
      result: "HELLO"
    });
    expect(agentToolResult).toEqual({
      echoed: "HELLO"
    });
    expect(agentResult.text).toBe("dynamic agent");
    expect(
      server.requests
        .filter(request => request.pathname === "/api/v1/governance/evaluate")
        .map(request => request.body.event_type)
    ).toEqual([
      "ActivityStarted",
      "ActivityCompleted",
      "WorkflowStarted",
      "ActivityStarted",
      "ActivityCompleted",
      "WorkflowCompleted",
      "ActivityStarted",
      "ActivityCompleted",
      "WorkflowStarted",
      "SignalReceived",
      "SignalReceived",
      "WorkflowCompleted"
    ]);
  });

  it("returns the original app object while wiring the nested Mastra instance", async () => {
    const server = await startOpenBoxServer({
      evaluate() {
        return { verdict: "allow" };
      }
    });
    const mastra = new Mastra({
      storage: new InMemoryStore()
    });
    const app = {
      fetch: vi.fn(),
      mastra
    };

    const governedApp = await withOpenBox(app, {
      apiKey: "obx_test_with_openbox",
      apiUrl: server.url,
      validate: false
    });
    const runtimeFromApp = getOpenBoxRuntime(governedApp);
    const runtimeFromMastra = getOpenBoxRuntime(mastra);

    await runtimeFromMastra?.shutdown();
    await server.close();

    expect(governedApp).toBe(app);
    expect(runtimeFromApp).toBeDefined();
    expect(runtimeFromApp).toBe(runtimeFromMastra);
  });
});
