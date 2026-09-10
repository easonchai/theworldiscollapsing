import { afterEach, describe, expect, it } from "vitest";
import { env, flag } from "./env.js";

afterEach(() => {
  delete process.env.TWIC_TEST_FLAG;
});

describe("flag", () => {
  it("accepts 1 and true in any case", () => {
    for (const v of ["1", "true", "TRUE", "True", " true "]) {
      process.env.TWIC_TEST_FLAG = v;
      expect(flag("TWIC_TEST_FLAG"), v).toBe(true);
    }
  });

  it("treats everything else, unset included, as off", () => {
    for (const v of ["", "0", "false", "yes", "on", "2"]) {
      process.env.TWIC_TEST_FLAG = v;
      expect(flag("TWIC_TEST_FLAG"), v).toBe(false);
    }
    delete process.env.TWIC_TEST_FLAG;
    expect(flag("TWIC_TEST_FLAG")).toBe(false);
  });
});

describe("env", () => {
  it("uses the fallback when unset and refuses a missing or blank var", () => {
    expect(env("TWIC_TEST_FLAG", "fallback")).toBe("fallback");
    expect(() => env("TWIC_TEST_FLAG")).toThrow(/missing env TWIC_TEST_FLAG/);
    process.env.TWIC_TEST_FLAG = "";
    expect(() => env("TWIC_TEST_FLAG")).toThrow(/missing env TWIC_TEST_FLAG/);
    process.env.TWIC_TEST_FLAG = "set";
    expect(env("TWIC_TEST_FLAG", "fallback")).toBe("set");
  });
});
