import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { EXIT } from "../errors.js";
import { recordCommandModule } from "../command-modules.js";
import { inboxCommand } from "./inbox.js";
import { inboxActCommand } from "./inbox-act.js";

// The core has no email commands (the mail add-on owns `email`, `email-act` and the Emails room), so its text must not
// send anyone to them unless the add-on's room is registered. inbox-act.test.ts covers the build that has it.

const MAIL_HINT = /email-act|email review|Emails/i;
const ctx = {
  client: { getState: async () => ({ captures: [{ id: "c3", status: "pending", proposalType: "email_change" }] }) },
  mode: "json",
  now: () => new Date("2026-10-05T00:00:00Z"),
  stdout: () => {},
  stderr: () => {},
  setExitCode: () => {}
} as unknown as CommandContext;
const run = (positionals: string[]) => inboxActCommand.run(ctx, { positionals, values: {} as never });

describe("without a mail room registered", () => {
  it("names no email command in the help of inbox or inbox-act", () => {
    for (const command of [inboxCommand, inboxActCommand]) {
      const text = JSON.stringify({
        summary: command.summary,
        description: command.description,
        positionals: command.positionals,
        options: command.options
      });
      expect(text).not.toMatch(MAIL_HINT);
    }
  });

  it("treats emails as an unknown room and an email change as unsupported", async () => {
    await expect(run(["emails", "confirm"])).rejects.toMatchObject({
      exitCode: EXIT.usage,
      message: expect.stringMatching(/Unknown room "emails"/)
    });
    await expect(run(["captured", "ignore", "c3"])).rejects.toMatchObject({
      exitCode: EXIT.usage,
      message: expect.not.stringMatching(/email-act/)
    });
  });
});

describe("with a mail room registered", () => {
  it("brings the hints back", async () => {
    recordCommandModule({
      id: "mail-hints-test",
      commands: [],
      inboxRooms: [{ id: "emails", label: "Emails", about: "Emails (threads)", load: async () => [] }]
    });
    expect(inboxCommand.description).toMatch(/Emails \(threads\), Captured/);
    expect(inboxActCommand.description).toMatch(/email-act/);
    await expect(run(["emails", "confirm"])).rejects.toThrow(/email-act/);
  });
});
