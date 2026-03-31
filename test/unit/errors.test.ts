import {
  GovernanceAPIError,
  GovernanceHaltError,
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxInsecureURLError,
  OpenBoxNetworkError
} from "../../src/index.js";

describe("OpenBox error hierarchy", () => {
  it("matches config error inheritance", () => {
    expect(new OpenBoxAuthError("auth")).toBeInstanceOf(OpenBoxConfigError);
    expect(new OpenBoxNetworkError("network")).toBeInstanceOf(
      OpenBoxConfigError
    );
    expect(new OpenBoxInsecureURLError("insecure")).toBeInstanceOf(
      OpenBoxConfigError
    );
  });

  it("preserves custom messages", () => {
    expect(String(new OpenBoxAuthError("Auth failed"))).toContain(
      "Auth failed"
    );
    expect(String(new GovernanceAPIError("API failed"))).toContain("API failed");
    expect(String(new GovernanceHaltError("Blocked"))).toContain("Blocked");
  });

  it("keeps governance errors catchable as Error", () => {
    expect(new GovernanceAPIError("api")).toBeInstanceOf(Error);
    expect(new GovernanceHaltError("halt")).toBeInstanceOf(Error);
  });
});
