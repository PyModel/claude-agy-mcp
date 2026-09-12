#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

createServer()
  .then(async (server) => {
    await server.connect(new StdioServerTransport());
    // The SDK's stdio transport never notices its client going away: it listens
    // for data and errors, not for the end of input. A client that quits by
    // closing the pipe left this process, and every agy it had started, running.
    // Exiting runs the shutdown hook, which reaps them.
    const exit = () => process.exit(0);
    process.stdin.once("end", exit);
    process.stdin.once("close", exit);
  })
  .catch((err) => {
    console.error("claude-agy-mcp failed to start:", err);
    process.exit(1);
  });
