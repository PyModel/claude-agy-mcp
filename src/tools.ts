import { z } from "zod";

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  chain: string[];
  buildPrompt(args: Record<string, unknown>, cwd: string): string;
}

export const TOOLS: ToolDef[] = [];
