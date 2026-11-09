import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, CommandSpec } from "../src/command.js";
import type { CommandModule } from "../src/command-modules.js";

afterEach(() => {
  vi.doUnmock("../src/drop-ins.js");
  vi.resetModules();
});

/** The registry as a build with no drop-in folders sees it. */
async function bareRegistry() {
  vi.resetModules();
  vi.doMock("../src/drop-ins.js", () => ({ dropInModules: () => [] }));
  return import("../src/registry.js");
}

const fakeModule = (id: string, after?: string): CommandModule => ({
  id,
  ...(after === undefined ? {} : { after }),
  commands: [{ name: `${id}-one` } as CommandSpec, { name: `${id}-two` } as CommandSpec]
});

describe("command modules", () => {
  it("a CLI built with no module has only the core Inbox rooms", async () => {
    const { findCommand } = await bareRegistry();
    const inbox = findCommand("inbox")!;
    const context = {
      mode: "json",
      stdout: () => undefined,
      client: { getState: async () => ({ captures: [] }), get: async () => ({}) }
    } as unknown as CommandContext;
    await expect(inbox.run(context, { positionals: ["nope"], values: {} } as never)).rejects.toThrow(
      /Unknown room "nope". Rooms: captured, calendar, map, kept, compare, facts\./
    );
  });

  it("registers a module's commands after the one it names, once", async () => {
    const { commands, registerCommandModule } = await bareRegistry();
    const before = commands.map((command) => command.name);
    registerCommandModule(fakeModule("demo", "status"));
    registerCommandModule(fakeModule("demo", "status"));
    const names = commands.map((command) => command.name);
    expect(names.slice(0, 4)).toEqual([before[0], "demo-one", "demo-two", before[1]]);
    expect(names.filter((name) => name === "demo-one")).toHaveLength(1);
  });

  it("appends a module that names no known command", async () => {
    const { commands, registerCommandModule } = await bareRegistry();
    registerCommandModule(fakeModule("tail", "no-such-command"));
    expect(commands.slice(-2).map((command) => command.name)).toEqual(["tail-one", "tail-two"]);
  });
});
