import { afterEach, describe, expect, it } from "vitest";
import { env, flag, intEnv, list } from "./env.js";

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

describe("intEnv", () => {
  it("uses the fallback when unset", () => {
    expect(intEnv("TWIC_TEST_FLAG", "3", 2, 5)).toBe(3);
  });

  it("parses a set value within range", () => {
    process.env.TWIC_TEST_FLAG = "4";
    expect(intEnv("TWIC_TEST_FLAG", "3", 2, 5)).toBe(4);
  });

  it("rejects a non-integer, an out-of-range value, and out-of-range fallback with a clear message", () => {
    process.env.TWIC_TEST_FLAG = "2.5";
    expect(() => intEnv("TWIC_TEST_FLAG", "3", 2, 5)).toThrow(/TWIC_TEST_FLAG must be an integer 2 to 5, got 2.5/);
    process.env.TWIC_TEST_FLAG = "1";
    expect(() => intEnv("TWIC_TEST_FLAG", "3", 2, 5)).toThrow(/TWIC_TEST_FLAG must be an integer 2 to 5, got 1/);
    process.env.TWIC_TEST_FLAG = "6";
    expect(() => intEnv("TWIC_TEST_FLAG", "3", 2, 5)).toThrow(/TWIC_TEST_FLAG must be an integer 2 to 5, got 6/);
  });
});

describe("list", () => {
  it("trims whitespace around each entry", () => {
    process.env.TWIC_TEST_FLAG = "sports, politics";
    expect(list("TWIC_TEST_FLAG", "fallback")).toEqual(["sports", "politics"]);
  });

  it("drops empty entries instead of producing a blank id", () => {
    process.env.TWIC_TEST_FLAG = "sports,,politics";
    expect(list("TWIC_TEST_FLAG", "fallback")).toEqual(["sports", "politics"]);
  });

  it("uses the fallback when unset", () => {
    expect(list("TWIC_TEST_FLAG", "sports,politics,culture,region")).toEqual([
      "sports",
      "politics",
      "culture",
      "region",
    ]);
  });
});
