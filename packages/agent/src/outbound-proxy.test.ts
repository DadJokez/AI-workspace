import { NodeHttpHandler } from "@smithy/node-http-handler";
import { describe, expect, it } from "vitest";
import { awsSdkProxyConfig, describeOutboundProxy } from "./outbound-proxy";

const PROXIED = {
  NODE_USE_ENV_PROXY: "1",
  HTTPS_PROXY: "http://user:secret@proxy.corp.example:3128",
  NO_PROXY: "vpce.example, 169.254.170.2 ,localhost,",
};

describe("describeOutboundProxy", () => {
  it("is off with no proxy variables", () => {
    expect(describeOutboundProxy({})).toEqual({
      enabled: false,
      proxyHost: null,
      noProxy: [],
    });
  });

  it("reports host and port without the proxy credentials", () => {
    const description = describeOutboundProxy(PROXIED);
    expect(description).toEqual({
      enabled: true,
      proxyHost: "proxy.corp.example:3128",
      noProxy: ["vpce.example", "169.254.170.2", "localhost"],
    });
    expect(JSON.stringify(description)).not.toContain("secret");
  });

  it("is not enabled unless Node was started with NODE_USE_ENV_PROXY=1", () => {
    expect(
      describeOutboundProxy({ HTTPS_PROXY: "http://proxy.corp.example:3128" }),
    ).toMatchObject({ enabled: false, proxyHost: "proxy.corp.example:3128" });
  });

  it("reads the lowercase and HTTP-only spellings", () => {
    expect(
      describeOutboundProxy({
        NODE_USE_ENV_PROXY: "1",
        http_proxy: "http://proxy.corp.example:8080",
        no_proxy: "internal.example",
      }),
    ).toEqual({
      enabled: true,
      proxyHost: "proxy.corp.example:8080",
      noProxy: ["internal.example"],
    });
  });

  it("treats an unparseable proxy URL as no proxy", () => {
    expect(
      describeOutboundProxy({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "::" }),
    ).toMatchObject({ enabled: false, proxyHost: null });
  });
});

describe("awsSdkProxyConfig", () => {
  it("leaves the SDK's default handler alone with no proxy", () => {
    expect(awsSdkProxyConfig({})).toEqual({});
    expect(
      awsSdkProxyConfig({ HTTPS_PROXY: "http://proxy.corp.example:3128" }),
    ).toEqual({});
  });

  it("supplies an HTTP/1.1 handler when a proxy is enabled", () => {
    expect(awsSdkProxyConfig(PROXIED).requestHandler).toBeInstanceOf(
      NodeHttpHandler,
    );
  });
});
