import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const server = JSON.parse(
  readFileSync(new URL("../server.json", import.meta.url), "utf8"),
) as {
  name: string;
  packages: { identifier: string; transport: { type: string } }[];
};

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { mcpName: string; name: string };

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
});