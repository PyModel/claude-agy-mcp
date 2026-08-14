export interface Config {
  agyPath: string;
  timeoutSec: number;
  maxRuntimeSec: number;
  maxOutputChars: number;
  defaultModel: string | undefined;
  skipPermissions: boolean;
  sandbox: boolean;
  onFailure: "strict" | "fallback";
}
