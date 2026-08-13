import { afterEach, describe, expect, test } from "bun:test";

import {
  clearCachedOverrides,
  setCachedOverrides,
} from "../../config/feature-flag-cache.js";
import { isPluginSchedulesEnabled } from "../plugin-schedules-gate.js";

afterEach(() => {
  clearCachedOverrides();
});

describe("isPluginSchedulesEnabled", () => {
  test("defaults to disabled (registry defaultEnabled: false)", () => {
    clearCachedOverrides();
    expect(isPluginSchedulesEnabled()).toBe(false);
  });

  test("an explicit override turns the surface on", () => {
    setCachedOverrides({ "plugin-schedules": true }, { fromGateway: true });
    expect(isPluginSchedulesEnabled()).toBe(true);
  });

  test("an explicit off override wins", () => {
    setCachedOverrides({ "plugin-schedules": false }, { fromGateway: true });
    expect(isPluginSchedulesEnabled()).toBe(false);
  });
});
