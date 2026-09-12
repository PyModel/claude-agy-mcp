import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertWithinRoots,
  canonical,
  PathNotAllowedError,
  redact,
  redactDeep,
} from "../src/egress.js";

describe("assertWithinRoots", () => {
  it("allows anything when no roots are configured", () => {
    expect(() => assertWithinRoots(["/etc/shadow"], [])).not.toThrow();
  });

  it("allows a path inside a root, including the root itself", () => {
    expect(() => assertWithinRoots(["/repo", "/repo/src/a.ts"], ["/repo"])).not.toThrow();
  });

  it("refuses a path outside every root, naming it", () => {
    expect(() => assertWithinRoots(["/repo/a.ts", "/etc/shadow"], ["/repo"])).toThrow(
      PathNotAllowedError,
    );
    expect(() => assertWithinRoots(["/etc/shadow"], ["/repo"])).toThrow(/etc\/shadow/);
  });

  it("is not fooled by a traversal that climbs back out", () => {
    expect(() => assertWithinRoots(["/repo/../etc/shadow"], ["/repo"])).toThrow(
      PathNotAllowedError,
    );
  });

  it("is not fooled by a sibling directory sharing the root's prefix", () => {
    expect(() => assertWithinRoots(["/repo-secrets/x"], ["/repo"])).toThrow(PathNotAllowedError);
  });

  it("follows a symlink inside the root to where it really points", () => {
    const base = mkdtempSync(path.join(tmpdir(), "egress-"));
    try {
      const root = path.join(base, "repo");
      const outside = path.join(base, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(outside, path.join(root, "link"));
      expect(() => assertWithinRoots([path.join(root, "link", "x")], [root])).toThrow(
        PathNotAllowedError,
      );
      expect(() => assertWithinRoots([path.join(root, "real", "x")], [root])).not.toThrow();
      expect(canonical(path.join(root, "link", "new", "file"))).toBe(
        path.join(canonical(outside), "new", "file"),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("redact", () => {
  it.each([
    ["sk-abcdefghijklmnopqrstuvwxyz012345", "openai key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456", "github token"],
    ["AKIAIOSFODNN7EXAMPLE", "aws access key"],
    ["AIzaSyA1234567890abcdefghijklmnopqrstuvw", "google api key"],
    ["xoxb-123456789012-abcdefghijkl", "slack token"],
  ])("replaces %s", (secret, label) => {
    const out = redact(`the value is ${secret} ok`);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain(`[redacted ${label}]`);
    expect(out.count).toBe(1);
  });

  it("redacts the value of an assignment whose name says secret, keeping the name", () => {
    const out = redact('DATABASE_PASSWORD="s3cr3t-value-here"');
    expect(out.text).toContain("DATABASE_PASSWORD");
    expect(out.text).not.toContain("s3cr3t-value-here");
  });

  it("redacts a private key block whole", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redact(key).text).toBe("[redacted private key block]");
  });

  it("leaves a git SHA alone, because a review is full of them", () => {
    const sha = "b70cc7f6fcb5be39dbc136263765f487d1c84756";
    const out = redact(`fixed in ${sha}`);
    expect(out.text).toContain(sha);
    expect(out.count).toBe(0);
  });

  it("leaves ordinary prose and code alone", () => {
    const text = "function parse(input: string) { return input.trim(); }";
    expect(redact(text)).toEqual({ text, count: 0 });
  });
});

describe("redaction coverage (SEC-M3)", () => {
  it("scrubs underscore-style keys the sk- rule never matched", () => {
    expect(redact("stripe sk_live_51H8xQrKlMnOpQrSt").text).toContain("[redacted stripe key]");
    expect(redact("glpat-abcdefghijklmnopqrstu").text).toContain("[redacted gitlab token]");
    expect(redact(`npm_${"a".repeat(36)}`).text).toContain("[redacted npm token]");
    expect(redact("ASIAIOSFODNN7EXAMPLE").text).toContain("[redacted aws access key]");
  });

  it("scrubs credentials embedded in a connection string", () => {
    const r = redact("postgres://admin:Sup3rS3cret@db.internal:5432/prod");
    expect(r.text).not.toContain("Sup3rS3cret");
    expect(r.text).toContain("postgres://admin:[redacted]@");
    expect(r.count).toBe(1);
  });

  it("leaves an ordinary URL and a git SHA alone", () => {
    const clean = "see https://github.com/o/r/commit/9f2a1c3d4e5f60718293a4b5c6d7e8f901234567";
    expect(redact(clean).text).toBe(clean);
    expect(redact(clean).count).toBe(0);
  });

  it("scrubs strings nested anywhere in structured output", () => {
    const r = redactDeep({ files: [{ path: "a", body: "key AKIAIOSFODNN7EXAMPLE here" }], n: 3 });
    expect(JSON.stringify(r.value)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.count).toBe(1);
  });
});
