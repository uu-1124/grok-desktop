import { describe, expect, it } from "vitest";

import {
  getXaiApiCredentialScope,
  normalizeRequiredXaiConnection,
  xaiApiBaseUrlCandidates,
} from "./xai-connection";

describe("explicit xAI connection pair", () => {
  it("normalizes a complete URL and key pair", () => {
    expect(normalizeRequiredXaiConnection(
      " https://gateway.example.com/v1 ",
      " test-key ",
    )).toEqual({
      xaiApiBaseUrl: "https://gateway.example.com/v1",
      xaiApiKey: "test-key",
    });
  });

  it.each([
    [undefined, "test-key", /base URL/u],
    [null, "test-key", /base URL/u],
    ["https://gateway.example.com/v1", undefined, /API key/u],
    ["https://gateway.example.com/v1", "", /API key/u],
  ])("rejects an incomplete connection pair %#", (baseUrl, apiKey, expected) => {
    expect(() => normalizeRequiredXaiConnection(baseUrl, apiKey)).toThrow(expected);
  });
});

describe("xAI API credential scope", () => {
  it("binds credentials to the normalized origin instead of an API path", () => {
    expect(getXaiApiCredentialScope("https://API.EXAMPLE.COM:443/v1")).toBe(
      "https://api.example.com",
    );
    expect(getXaiApiCredentialScope("http://localhost:8080/v1")).toBe(
      "http://localhost:8080",
    );
  });
});

describe("xAI API base URL discovery candidates", () => {
  it("prefers the conventional API path for an arbitrary remote root URL", () => {
    expect(xaiApiBaseUrlCandidates("https://gateway.example.com")).toEqual([
      "https://gateway.example.com/v1",
      "https://gateway.example.com/",
    ]);
  });

  it("keeps every candidate on the user-authorized origin", () => {
    const candidates = xaiApiBaseUrlCandidates("https://provider.example.net/openai");

    expect(candidates).toEqual([
      "https://provider.example.net/openai",
      "https://provider.example.net/openai/v1",
    ]);
    expect(candidates.every((candidate) =>
      new URL(candidate).origin === "https://provider.example.net"
    )).toBe(true);
  });

  it("does not invent an extra path when the user already supplied a versioned base", () => {
    expect(xaiApiBaseUrlCandidates("https://gateway.example.com/v1")).toEqual([
      "https://gateway.example.com/v1",
    ]);
  });
});
