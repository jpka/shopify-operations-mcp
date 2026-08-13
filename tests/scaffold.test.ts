import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  mcpName: string;
  type: string;
};

describe("repo scaffold", () => {
  it("declares the MCP name io.github.jpka/shopify-operations-mcp", () => {
    expect(pkg.mcpName).toBe("io.github.jpka/shopify-operations-mcp");
  });

  it("is an ES module package", () => {
    expect(pkg.type).toBe("module");
  });
});
