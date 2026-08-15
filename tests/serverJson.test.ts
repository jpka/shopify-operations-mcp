import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const server = JSON.parse(
  readFileSync(new URL("../server.json", import.meta.url), "utf8"),
) as {
  name: string;
  version: string;
  packages: { identifier: string; version: string; transport: { type: string } }[];
};

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { mcpName: string; name: string; version: string };

describe("server.json (MCP Registry)", () => {
  it("stays in sync with package.json mcpName", () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it("registers the npm package identifier", () => {
    expect(server.packages[0].identifier).toBe(pkg.name);
  });

  it("declares the stdio transport", () => {
    expect(server.packages[0].transport.type).toBe("stdio");
  });

  it("stays in sync with package.json version", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });
});