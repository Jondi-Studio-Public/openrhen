import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState } from "./fixture-state.js";

interface RunResult {
  exitCode: number;
  lines: string[];
  text: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  overrides: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw
): Promise<RunResult> {
  const calls: RecordedCall[] = [];
  const lines: string[] = [];
  let stderr = "";
  const state = overrides(fixtureRawState());
  const exitCode = await runCli(["disruption", ...argv], {
    stdout: (text) => lines.push(text),
    stderr: (text) => {
      stderr += (stderr ? "\n" : "") + text;
    },
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state } }, ...routes }, calls)
  });
  return { exitCode, lines, text: lines.join("\n"), stderr, calls };
}

/** A live, open-ended disruption landed this morning — additive, so it never touches the shared fixture. */
function withDisruptionCommitment(fields: Record<string, unknown> = {}) {
  return (raw: Record<string, unknown>): Record<string, unknown> => {
    const commitments = raw.commitments as Record<string, unknown>[];
    return {
      ...raw,
      commitments: [
        ...commitments,
        {
          id: "commitment-car-trouble",
          title: "Car trouble",
          startsAt: "2026-09-03T08:00:00+10:00",
          endsAt: "2026-09-03T22:30:00+10:00",
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0,
          presence: "blocking",
          origin: "disruption",
          disruptionSource: "other",
          disruptionOpenEnded: true,
          landedAt: "2026-09-03T08:05:00+10:00",
          version: 3,
          ...fields
        }
      ]
    };
  };
}

describe("disruption start", () => {
  it("logs a disruption using a named duration preset, and starts tracking it since the window is live now", async () => {
    let createdId: string | undefined;
    const result = await run(["start", "--title", "Car trouble", "--duration", "1h"], {
      "/api/commands/entity": (call) => {
        const body = call.body as Record<string, unknown>;
        expect(body.type).toBe("save_entity");
        expect(body.entityType).toBe("commitment");
        expect(body.expectedVersion).toBeNull();
        const entity = body.entity as Record<string, unknown>;
        expect(entity.title).toBe("Car trouble");
        expect(entity.origin).toBe("disruption");
        expect(entity.disruptionSource).toBe("other");
        expect(entity.status).toBe("confirmed");
        expect(entity.presence).toBe("blocking");
        expect(entity.disruptionOpenEnded).toBe(false);
        expect(entity.startsAt).toBe(fixtureNow.toISOString());
        expect(entity.endsAt).toBe(new Date(fixtureNow.getTime() + 60 * 60_000).toISOString());
        expect(entity.landedAt).toBe(fixtureNow.toISOString());
        createdId = entity.id as string;
        return { body: { state: fixtureRawState() } };
      },
      // A disruption logged as happening now is live at capture time (its window
      // covers "now"), so `start` also starts tracking on the commitment it just created.
      "/api/commands/activity": (call) => {
        const body = call.body as Record<string, unknown>;
        expect(body.type).toBe("start_activity");
        expect(body.targetType).toBe("fixed_commitment");
        expect(body.targetId).toBe(createdId);
        expect(body.phase).toBe("active");
        expect(body.plannedMinutes).toBe(60);
        // The commitment did not exist before this run, so a fresh create always lands on version 1.
        expect(body.expectedVersion).toBe(1);
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/api/commands/entity",
      "/api/commands/activity"
    ]);
  });

  it("logs an unknown-duration disruption as open-ended, guessing the end from tonight's sleep plan, and tracks it", async () => {
    const result = await run(["start", "--title", "School called", "--source", "family", "--duration", "unknown"], {
      "/api/commands/entity": (call) => {
        const entity = (call.body as Record<string, unknown>).entity as Record<string, unknown>;
        expect(entity.disruptionSource).toBe("family");
        expect(entity.disruptionOpenEnded).toBe(true);
        // fixture's sleep-tonight plan starts 22:30 Australia/Sydney, after the 09:30 fixtureNow start.
        expect(entity.endsAt).toBe(new Date("2026-09-03T22:30:00+10:00").toISOString());
        return { body: { state: fixtureRawState() } };
      },
      // Open-ended is still live right now, so tracking uses the pessimistic end already computed for
      // the save (22:30) to plan its minutes, not some separate guess.
      "/api/commands/activity": (call) => {
        const body = call.body as Record<string, unknown>;
        expect(body.plannedMinutes).toBe(
          Math.round((new Date("2026-09-03T22:30:00+10:00").getTime() - fixtureNow.getTime()) / 60_000)
        );
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/api/commands/entity",
      "/api/commands/activity"
    ]);
  });

  it("resolves --when as a retro HH:MM and treats unknown duration as the retro fallback, not open-ended, with no tracking", async () => {
    const result = await run(["start", "--title", "Late meeting", "--when", "08:00", "--duration", "unknown"], {
      "/api/commands/entity": (call) => {
        const entity = (call.body as Record<string, unknown>).entity as Record<string, unknown>;
        expect(entity.startsAt).toBe(new Date("2026-09-03T08:00:00+10:00").toISOString());
        expect(entity.disruptionOpenEnded).toBe(false);
        // settings default disruptionRetroFallbackMinutes is 60.
        expect(entity.endsAt).toBe(new Date("2026-09-03T09:00:00+10:00").toISOString());
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    // Its window (08:00-09:00) had already ended by fixtureNow (09:30) — retro-logged and over, so no
    // start_activity follows the save.
    expect(result.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/api/commands/entity"
    ]);
  });

  it("does not start tracking when --no-track is passed for an otherwise live disruption", async () => {
    const result = await run(["start", "--title", "Car trouble", "--duration", "1h", "--no-track"], {
      "/api/commands/entity": () => ({ body: { state: fixtureRawState() } })
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
      "/api/commands/entity"
    ]);
  });

  it("refuses to start a live disruption while a session is already running on something else", async () => {
    const result = await run(["start", "--title", "Car trouble", "--duration", "1h"], {}, (raw) => ({
      ...raw,
      ...fixtureActiveSession()
    }));
    expect(result.exitCode).toBe(EXIT.usage);
    // fixtureActiveSession() is running on "Draft chapter 3".
    expect(result.stderr).toContain("Draft chapter 3");
    expect(result.stderr).toContain("--no-track");
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses a --when time that has not happened yet", async () => {
    const result = await run(["start", "--title", "Too soon", "--when", "23:59"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses start without --title", async () => {
    const result = await run(["start"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("--routine pins the preset and starts the disruption after its before-steps, with no tracking", async () => {
    const result = await run([
      "start",
      "--title",
      "Milk from the shops",
      "--routine",
      "Gym prep",
      "--duration",
      "30",
      "--dry-run"
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.lines).toHaveLength(1);
    const entity = (JSON.parse(result.lines[0]!) as { payload: { entity: Record<string, string> } }).payload.entity;
    expect(entity).toMatchObject({ routineSource: "preset", routinePresetId: "preset-gym", origin: "disruption" });
    // The fixture preset has one 10-minute before-step.
    expect(new Date(entity.startsAt!).getTime()).toBe(fixtureNow.getTime() + 10 * 60_000);
    expect(new Date(entity.endsAt!).getTime()).toBe(fixtureNow.getTime() + 40 * 60_000);
    expect(result.text).not.toContain("start_activity");
  });

  it("--routine leaves a start further ahead than the routine's lead alone", async () => {
    const result = await run(
      ["start", "--title", "Dentist run", "--when", "+3h", "--routine", "Gym prep", "--dry-run"],
      {},
      (raw) => {
        const settings = raw.settings as Record<string, unknown>;
        settings.disruptionWhenPresets = [{ id: "in-3h", label: "+3h", delayMinutes: 180 }];
        return raw;
      }
    );
    expect(result.exitCode).toBe(0);
    const entity = (JSON.parse(result.lines[0]!) as { payload: { entity: Record<string, string> } }).payload.entity;
    expect(new Date(entity.startsAt!).getTime()).toBe(fixtureNow.getTime() + 180 * 60_000);
  });

  it("prints both the save and the tracking payloads, and sends nothing, on --dry-run", async () => {
    const result = await run(["start", "--title", "Car trouble", "--dry-run"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    expect(result.lines).toHaveLength(2);
    const save = JSON.parse(result.lines[0]!) as {
      dryRun: boolean;
      path: string;
      payload: { type: string; entity: { title: string } };
    };
    expect(save.dryRun).toBe(true);
    expect(save.path).toBe("/api/commands/entity");
    expect(save.payload.type).toBe("save_entity");
    expect(save.payload.entity.title).toBe("Car trouble");
    const track = JSON.parse(result.lines[1]!) as {
      dryRun: boolean;
      path: string;
      payload: { type: string; targetType: string; phase: string };
    };
    expect(track.dryRun).toBe(true);
    expect(track.path).toBe("/api/commands/activity");
    expect(track.payload.type).toBe("start_activity");
    expect(track.payload.targetType).toBe("fixed_commitment");
    expect(track.payload.phase).toBe("active");
  });
});

describe("disruption extend", () => {
  it("pushes an open-ended disruption's end out and preserves the open-ended flag", async () => {
    const result = await run(
      ["extend", "commitment-car-trouble", "--minutes", "30"],
      {
        "/api/commands/entity": (call) => {
          const body = call.body as Record<string, unknown>;
          expect(body.expectedVersion).toBe(3);
          const entity = body.entity as Record<string, unknown>;
          expect(entity.id).toBe("commitment-car-trouble");
          expect(entity.title).toBe("Car trouble");
          expect(entity.setupBeforeMinutes).toBe(0);
          expect(entity.endsAt).toBe(new Date("2026-09-03T23:00:00+10:00").toISOString());
          expect(entity.disruptionOpenEnded).toBe(true);
          return { body: { state: fixtureRawState() } };
        }
      },
      withDisruptionCommitment()
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("refuses to extend a commitment that is not a disruption", async () => {
    const result = await run(["extend", "commitment-gym", "--minutes", "15"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("extends a non-disruption commitment when --force is passed", async () => {
    const result = await run(["extend", "commitment-gym", "--minutes", "15", "--force"], {
      "/api/commands/entity": () => ({ body: { state: fixtureRawState() } })
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("requires --minutes", async () => {
    const result = await run(["extend", "commitment-car-trouble"], {}, withDisruptionCommitment());
    expect(result.exitCode).toBe(EXIT.usage);
  });
});

describe("disruption finish", () => {
  it("ends the disruption now and clears its open-ended flag", async () => {
    const result = await run(
      ["finish", "commitment-car-trouble"],
      {
        "/api/commands/entity": (call) => {
          const entity = (call.body as Record<string, unknown>).entity as Record<string, unknown>;
          expect(entity.endsAt).toBe(fixtureNow.toISOString());
          expect(entity.disruptionOpenEnded).toBe(false);
          return { body: { state: fixtureRawState() } };
        }
      },
      withDisruptionCommitment()
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });
});

describe("disruption status", () => {
  it("reports the live disruption that landed today", async () => {
    const result = await run(["status", "--json"], {}, withDisruptionCommitment());
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    const printed = JSON.parse(result.text) as { id: string; liveNow: boolean; openEnded: boolean };
    expect(printed.id).toBe("commitment-car-trouble");
    expect(printed.liveNow).toBe(true);
    expect(printed.openEnded).toBe(true);
  });

  it("reports null when no disruption landed today", async () => {
    const result = await run(["status", "--json"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.text)).toBeNull();
  });
});

describe("disruption misc", () => {
  it("refuses an unknown disruption subcommand", async () => {
    const result = await run(["skip"]);
    expect(result.exitCode).toBe(EXIT.usage);
  });
});

describe("disruption --duration bounds (issue 776)", () => {
  it("refuses 0 on the plain CLI with the field, accepted forms and the flag to repeat", async () => {
    const result = await run(["start", "--title", "Car trouble", "--duration", "0"]);
    expect(result.exitCode).toBe(EXIT.usage);
    const said = `${result.stderr}${result.text}`;
    expect(said).toContain("--duration");
    expect(said).toContain('"0"');
    expect(said).toContain("1 to 1440");
    expect(said).toContain("rest_of_day");
    expect(said).toContain("unknown");
    expect(said).toContain("Repeat the command with --duration");
    expect(result.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("refuses more than 1440 minutes", async () => {
    const result = await run(["start", "--title", "Car trouble", "--duration", "1441"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(`${result.stderr}${result.text}`).toContain("1440");
  });

  it("accepts the bounds 1 and 1440", async () => {
    for (const minutes of ["1", "1440"]) {
      const result = await run(["start", "--title", "Car trouble", "--duration", minutes, "--no-track", "--dry-run"]);
      expect(result.exitCode, minutes).toBe(0);
    }
  });

  it("refuses a preset whose minutes is 0 by name", async () => {
    const result = await run(["start", "--title", "Car trouble", "--duration", "zero"], {}, (raw) => ({
      ...raw,
      settings: {
        ...(raw.settings as Record<string, unknown>),
        disruptionDurationPresets: [{ id: "zero", label: "Zero", kind: "minutes", minutes: 0 }]
      }
    }));
    expect(result.exitCode).toBe(EXIT.usage);
    expect(`${result.stderr}${result.text}`).toContain('"zero"');
  });
});
