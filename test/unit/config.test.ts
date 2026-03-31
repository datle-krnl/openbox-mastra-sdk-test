import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

import {
  API_KEY_PATTERN,
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxInsecureURLError,
  getOpenBoxConfig,
  initializeOpenBox,
  parseOpenBoxConfig,
  validateApiKeyFormat,
  validateUrlSecurity
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

describe("validateApiKeyFormat", () => {
  it("matches the SDK key pattern", () => {
    expect(API_KEY_PATTERN.test("obx_live_abc123")).toBe(true);
    expect(API_KEY_PATTERN.test("obx_test_abc_def_123")).toBe(true);
    expect(validateApiKeyFormat("obx_live_abc123")).toBe(true);
    expect(validateApiKeyFormat("bad-key")).toBe(false);
  });
});

describe("validateUrlSecurity", () => {
  it("allows HTTPS and localhost HTTP URLs", () => {
    expect(() => {
      validateUrlSecurity("https://api.openbox.ai");
    }).not.toThrow();
    expect(() => {
      validateUrlSecurity("http://localhost:8086");
    }).not.toThrow();
    expect(() => {
      validateUrlSecurity("http://127.0.0.1:8086");
    }).not.toThrow();
    expect(() => {
      validateUrlSecurity("http://[::1]:8086");
    }).not.toThrow();
  });

  it("rejects non-localhost HTTP URLs", () => {
    expect(() => {
      validateUrlSecurity("http://api.openbox.ai");
    }).toThrow(OpenBoxInsecureURLError);
  });
});

describe("parseOpenBoxConfig", () => {
  it("applies SDK defaults", () => {
    const config = parseOpenBoxConfig({
      apiKey: "obx_live_abc123",
      apiUrl: "https://api.openbox.ai"
    });

    expect(config.apiUrl).toBe("https://api.openbox.ai");
    expect(config.apiKey).toBe("obx_live_abc123");
    expect(config.evaluateMaxRetries).toBe(2);
    expect(config.evaluateRetryBaseDelayMs).toBe(150);
    expect(config.governanceTimeout).toBe(30);
    expect(config.onApiError).toBe("fail_open");
    expect(config.sendStartEvent).toBe(true);
    expect(config.sendActivityStartEvent).toBe(true);
    expect(config.skipWorkflowTypes).toEqual(new Set());
    expect(config.skipSignals).toEqual(new Set());
    expect(config.skipActivityTypes).toEqual(new Set(["send_governance_event"]));
    expect(config.skipHitlActivityTypes).toEqual(
      new Set(["send_governance_event"])
    );
    expect(config.hitlEnabled).toBe(true);
    expect(config.instrumentDatabases).toBe(true);
    expect(config.instrumentFileIo).toBe(false);
    expect(config.maxEvaluatePayloadBytes).toBe(256_000);
    expect(config.httpCapture).toBe(true);
    expect(config.validate).toBe(true);
  });

  it("parses environment variables", () => {
    const config = parseOpenBoxConfig(
      {},
      {
        OPENBOX_API_KEY: "obx_test_env_key",
        OPENBOX_EVALUATE_MAX_RETRIES: "4",
        OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS: "25",
        OPENBOX_GOVERNANCE_POLICY: "fail_closed",
        OPENBOX_GOVERNANCE_TIMEOUT: "45.5",
        OPENBOX_HITL_ENABLED: "false",
        OPENBOX_HTTP_CAPTURE: "false",
        OPENBOX_INSTRUMENT_DATABASES: "false",
        OPENBOX_INSTRUMENT_FILE_IO: "true",
        OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES: "1024",
        OPENBOX_SEND_ACTIVITY_START_EVENT: "false",
        OPENBOX_SEND_START_EVENT: "false",
        OPENBOX_SKIP_ACTIVITY_TYPES: "toolA,toolB",
        OPENBOX_SKIP_HITL_ACTIVITY_TYPES: "approval-tool",
        OPENBOX_SKIP_SIGNALS: "resume_a,resume_b",
        OPENBOX_SKIP_WORKFLOW_TYPES: "wfA,wfB",
        OPENBOX_URL: "https://api.openbox.ai/"
      }
    );

    expect(config.apiUrl).toBe("https://api.openbox.ai");
    expect(config.apiKey).toBe("obx_test_env_key");
    expect(config.evaluateMaxRetries).toBe(4);
    expect(config.evaluateRetryBaseDelayMs).toBe(25);
    expect(config.governanceTimeout).toBe(45.5);
    expect(config.onApiError).toBe("fail_closed");
    expect(config.sendStartEvent).toBe(false);
    expect(config.sendActivityStartEvent).toBe(false);
    expect(config.skipWorkflowTypes).toEqual(new Set(["wfA", "wfB"]));
    expect(config.skipSignals).toEqual(new Set(["resume_a", "resume_b"]));
    expect(config.skipActivityTypes).toEqual(new Set(["toolA", "toolB"]));
    expect(config.skipHitlActivityTypes).toEqual(new Set(["approval-tool"]));
    expect(config.hitlEnabled).toBe(false);
    expect(config.instrumentDatabases).toBe(false);
    expect(config.instrumentFileIo).toBe(true);
    expect(config.maxEvaluatePayloadBytes).toBe(1024);
    expect(config.httpCapture).toBe(false);
  });

  it("raises on invalid API key format", () => {
    expect(() =>
      parseOpenBoxConfig({
        apiKey: "invalid",
        apiUrl: "https://api.openbox.ai"
      })
    ).toThrow(OpenBoxAuthError);
  });

  it("raises when required config is missing", () => {
    expect(() => parseOpenBoxConfig({})).toThrow(OpenBoxConfigError);
  });
});

describe("initializeOpenBox", () => {
  it("validates the API key by default and stores global config", async () => {
    server.use(
      http.get("https://api.openbox.ai/api/v1/auth/validate", () =>
        HttpResponse.json({ ok: true }, { status: 200 })
      )
    );

    const config = await initializeOpenBox({
      apiKey: "obx_live_valid_key",
      apiUrl: "https://api.openbox.ai"
    });

    expect(config.apiKey).toBe("obx_live_valid_key");
    expect(getOpenBoxConfig()?.apiUrl).toBe("https://api.openbox.ai");
  });

  it("can skip remote validation", async () => {
    const config = await initializeOpenBox({
      apiKey: "obx_live_valid_key",
      apiUrl: "https://api.openbox.ai",
      validate: false
    });

    expect(config.validate).toBe(false);
    expect(getOpenBoxConfig()?.apiKey).toBe("obx_live_valid_key");
  });

  it("surfaces auth failures from the validation endpoint", async () => {
    server.use(
      http.get("https://api.openbox.ai/api/v1/auth/validate", () =>
        HttpResponse.json({ error: "invalid" }, { status: 401 })
      )
    );

    await expect(
      initializeOpenBox({
        apiKey: "obx_live_invalid_key",
        apiUrl: "https://api.openbox.ai"
      })
    ).rejects.toBeInstanceOf(OpenBoxAuthError);
  });
});
