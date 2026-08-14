#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

createServer()
  .connect(new StdioServerTransport())
  .catch((err) => {
    console.error("claude-agy-mcp failed to start:", err);
    process.exit(1);
  });
