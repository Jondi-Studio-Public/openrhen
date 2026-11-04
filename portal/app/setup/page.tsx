"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DISPLAY_LOCALE_OPTIONS, isSupportedLocale, isValidTimeZone } from "@openrhen/contracts";
import { Banner } from "@/components/ui/banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { situationCommand } from "@/components/situation-panel";
import { dateInput, iso } from "@/features/today/local-datetime";
import { usePortal } from "@/state/portal-provider";
import { createClientId } from "@/shared/client-id";
import { timeZoneOptions } from "@/shared/time-zone-options";
import { isVersionConflictError, useServerDraft } from "@/shared/use-server-draft";
import styles from "./setup.module.css";

type SetupDraft = {
  timezone: string;
  locale: string | undefined;
  preferredBedtime: string;
  preferredWakeTime: string;
};

const STEPS = 3;
const STORAGE_KEY = "openrhen-setup-draft";
const ZONE_HELP = "Pick a timezone from the list, for example America/New_York.";
const UTC_NAMES = new Set(["UTC", "Etc/UTC", "Etc/GMT"]);

/** What survives a reload: the answers so far, never the settings version (that comes from the server). */
type StoredSetup = {
  v: 1;
  step: number;
  lastWake: string;
  firstThing: string;
  placeId: string;
  draft: Partial<SetupDraft>;
};

function readStored(): StoredSetup | null {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as StoredSetup | null;
    return parsed && parsed.v === 1 && typeof parsed.step === "number" && parsed.draft ? parsed : null;
  } catch {
    return null;
  }
}
function writeStored(value: StoredSetup) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked: the wizard still works, it just cannot survive a reload.
  }
}
function clearStored() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * What the browser says about the person: its IANA zone and, when it is one of the English formats
 * offered in Settings, its language. Nothing else is guessed; a zone or language the app cannot use
 * gives nothing, and the server's value stays.
 */
export function browserSetupDefaults(
  zone: string | undefined,
  language: string | undefined,
  serverZone?: string
): { timezone?: string; locale?: string } {
  const locale = language && isSupportedLocale(language) ? Intl.getCanonicalLocales(language)[0] : undefined;
  return {
    // A browser that says UTC (a VPN, a container) is a weak signal against a server zone someone set on purpose.
    ...(zone && isValidTimeZone(zone) && !(UTC_NAMES.has(zone) && serverZone && !UTC_NAMES.has(serverZone))
      ? { timezone: zone }
      : {}),
    ...(locale && (DISPLAY_LOCALE_OPTIONS as readonly string[]).includes(locale) ? { locale } : {})
  };
}

/** Minutes asleep between a bedtime and a wake time ("HH:MM"), wrapping past midnight; null when either is blank. */
export function sleepMinutes(bedtime: string, wake: string): number | null {
  const parse = (value: string) => {
    const match = /^(\d{1,2}):(\d{2})/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const from = parse(bedtime);
  const to = parse(wake);
  if (from === null || to === null) return null;
  return (to - from + 1440) % 1440;
}

export function sleepSentence(minutes: number | null): string {
  if (minutes === null) return "";
  return `That's ${Math.floor(minutes / 60)} h ${minutes % 60} m a night.`;
}

/**
 * First run, in three steps with a "1 of 3" counter: (1) sleep anchors, timezone and when you last woke, (2) where you
 * are, (3) the first thing you want planned, saved as an ordinary capture. Nothing is saved until the last step
 * (Finish setup, or Skip for now there), so the settings, the place and the capture go out in that order, as the
 * single form's saves did. "Where" is one of the places in the Conditions catalogue, saved as the current location
 * Now reads. With no places yet there is nothing to pick: the screens point to Conditions instead, since a place
 * needs an address the planner can travel to. "Last woke" is read in the app timezone, not the browser's.
 */
export default function SetupPage() {
  const { state, ready, saving, saveEntityCommand, addCapture } = usePortal();
  const serverValue = useMemo<SetupDraft>(
    () => ({
      timezone: state.settings.timezone,
      locale: state.settings.locale,
      preferredBedtime: state.settings.preferredBedtime,
      preferredWakeTime: state.settings.preferredWakeTime
    }),
    [state.settings]
  );
  const { draft, setDraft, seededVersion } = useServerDraft<SetupDraft>(
    serverValue,
    ready,
    state.settings.version ?? null
  );
  const latestState = useRef(state);
  useLayoutEffect(() => {
    latestState.current = state;
  });
  const places = state.conditionDefinitions.filter((entry) => entry.kind === "location" && entry.status !== "archived");
  const [step, setStep] = useState(1);
  const [lastWake, setLastWake] = useState("");
  const [firstThing, setFirstThing] = useState("");
  const [placeId, setPlaceId] = useState(
    () => state.currentSituation.locationId ?? state.settings.homeLocationId ?? ""
  );
  const [error, setError] = useState("");
  const [wakeInvalid, setWakeInvalid] = useState(false);
  const [zoneError, setZoneError] = useState("");
  const [savedFirstThing, setSavedFirstThing] = useState("");
  const [placeError, setPlaceError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [hydrated, setHydrated] = useState(false);
  const [focusField, setFocusField] = useState<"zone" | "wake" | null>(null);
  const finished = useRef(false);
  const zoneRef = useRef<HTMLInputElement>(null);
  const wakeRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  const skipFocus = useRef(false);
  const patch = (change: Partial<SetupDraft>) => setDraft({ ...draft, ...change });
  // First run only. A draft saved by an earlier visit in this tab (a reload, "Retry and reload", Back) comes back
  // first; otherwise start from the browser's zone and date format instead of the server default. Either way the
  // draft is then dirty, so later state reloads do not snap it back; the person can still change it.
  useEffect(() => {
    if (!ready || hydrated) return;
    if (state.settings.setupCompletedAt) {
      clearStored();
      // oxlint-disable-next-line react/set-state-in-effect -- reads sessionStorage once on arrival; reading it while rendering would mismatch hydration
      setHydrated(true);
      return;
    }
    const stored = readStored();
    if (stored) {
      setDraft((current) => ({ ...current, ...stored.draft }));
      setLastWake(stored.lastWake ?? "");
      setFirstThing(stored.firstThing ?? "");
      if (!stored.placeId || places.some((place) => place.id === stored.placeId)) setPlaceId(stored.placeId ?? "");
      const restored = stored.lastWake && stored.step >= 1 && stored.step <= STEPS ? stored.step : 1;
      // Arriving on a restored step is not a move the person made, so the heading must not grab focus.
      if (restored !== 1) skipFocus.current = true;
      setStep(restored);
    } else {
      const found = browserSetupDefaults(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        typeof navigator === "undefined" ? undefined : navigator.language,
        state.settings.timezone
      );
      if (Object.keys(found).length) setDraft((current) => ({ ...current, ...found }));
    }
    setHydrated(true);
  }, [ready, hydrated, state.settings.setupCompletedAt, state.settings.timezone, places, setDraft]);
  useEffect(() => {
    if (!hydrated || finished.current || state.settings.setupCompletedAt) return;
    writeStored({ v: 1, step, lastWake, firstThing, placeId, draft });
  }, [hydrated, step, lastWake, firstThing, placeId, draft, state.settings.setupCompletedAt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (state.settings.setupCompletedAt) return;
    const previous = document.title;
    document.title = `Setup ${step} of ${STEPS} - OpenRhen`;
    return () => {
      document.title = previous;
    };
  }, [step, state.settings.setupCompletedAt]);
  useEffect(() => {
    if (!focusField) return;
    (focusField === "zone" ? zoneRef : wakeRef).current?.focus();
    // oxlint-disable-next-line react/set-state-in-effect -- clears the one-shot focus request once it has moved focus
    setFocusField(null);
  }, [focusField]);
  // Keyboard and screen-reader users land on the new step's heading, not on <body>. Not on first paint.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    if (skipFocus.current) {
      skipFocus.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);
  /**
   * The place is a second save on the same version the settings save just moved, so it reads the version
   * after that state lands. A conflict (another device, or the state not landed yet) gets one retry; a
   * failure after that is reported on the done screen, since setup itself did save.
   */
  async function savePlace(locationId: string) {
    for (let attempt = 0; ; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await saveEntityCommand(situationCommand(latestState.current, { locationId }));
        return;
      } catch (reason) {
        if (attempt === 0 && isVersionConflictError(reason)) continue;
        setPlaceError("Setup saved, but where you are was not. Set it from Now.");
        return;
      }
    }
  }
  /** The zone the person's clocks run in: what they typed if it is a real zone, otherwise the saved one. */
  const zone = (() => {
    for (const candidate of [draft.timezone, state.settings.timezone]) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: candidate });
        return candidate;
      } catch {
        // Fall through to the next candidate.
      }
    }
    return "UTC";
  })();
  const nowLocal = dateInput(now.toISOString(), zone);
  const zoneNames = useMemo(() => timeZoneOptions(draft.timezone), [draft.timezone]);
  const localTime = new Intl.DateTimeFormat("en", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(now);

  function next() {
    if (step === 1) {
      const badZone = !isValidTimeZone(draft.timezone.trim());
      if (badZone) setZoneError(ZONE_HELP);
      if (!lastWake) {
        setWakeInvalid(true);
        setError("Add when you last woke.");
      }
      if (badZone || !lastWake) {
        setFocusField(badZone ? "zone" : "wake");
        return;
      }
      if (draft.timezone !== draft.timezone.trim()) patch({ timezone: draft.timezone.trim() });
    }
    setError("");
    setStep(step + 1);
  }
  function back() {
    setError("");
    setStep(Math.max(1, step - 1));
  }
  function skip() {
    setError("");
    if (step < STEPS) setStep(step + 1);
    else void finish(false);
  }
  async function finish(withFirstThing: boolean) {
    try {
      await saveEntityCommand({
        commandId: createClientId(),
        expectedVersion: seededVersion,
        type: "save_entity",
        entityType: "settings",
        entity: {
          timezone: draft.timezone,
          ...(draft.locale ? { locale: draft.locale } : {}),
          preferredBedtime: draft.preferredBedtime,
          preferredWakeTime: draft.preferredWakeTime,
          ...(lastWake ? { lastWokeAt: iso(lastWake, zone) } : {}),
          setupCompleted: true
        }
      });
      finished.current = true;
      clearStored();
      if (placeId) await savePlace(placeId);
      if (withFirstThing && firstThing.trim()) {
        try {
          await addCapture(firstThing.trim());
          setSavedFirstThing(firstThing.trim());
        } catch {
          setPlaceError("Setup saved, but your first item was not. Add it from Capture.");
        }
      }
      setError("");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Setup was not saved.";
      // A refused zone is fixed on step 1, in plain words, not with the server's wording for agents.
      if (!isValidTimeZone(draft.timezone.trim()) || message.startsWith('Timezone "')) {
        setStep(1);
        setZoneError(ZONE_HELP);
        setError("");
        setFocusField("zone");
      } else setError(message);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (step < STEPS) next();
    else void finish(true);
  }
  if (!ready)
    return (
      <main className="content-page">
        <p>Loading setup…</p>
      </main>
    );
  if (state.settings.setupCompletedAt)
    return (
      <main className="content-page">
        <h1>Setup</h1>
        <p className="reason">Your sleep, timezone and last wake are saved.</p>
        {placeError && <Banner tone="danger">{placeError}</Banner>}
        <ul>
          {savedFirstThing && (
            <li>
              Added to your Inbox: “{savedFirstThing}” (<a href="/inbox">open Inbox</a>).
            </li>
          )}
          {places.length === 0 ? (
            <li>
              You have not added a place yet. Add home so Now knows where you are and how far things are; until then Now
              has less to go on.
            </li>
          ) : (
            <li>{places.length === 1 ? "1 place is" : `${places.length} places are`} ready for Now to use.</li>
          )}
          <li>
            Setup also added seven starter areas (Work and income, Study, Career development, Health, Home and
            administration, Relationships, Recreation and recovery) on the Plan page. Rename them there to suit you.
          </li>
        </ul>
        <div className={styles.next}>
          {places.length === 0 ? (
            <>
              <ButtonLink variant="primary" href="/settings/catalogues/conditions">
                Add your home
              </ButtonLink>
              <ButtonLink variant="secondary" href="/capture">
                Capture some work
              </ButtonLink>
              <ButtonLink variant="ghost" href="/">
                Go to Now
              </ButtonLink>
            </>
          ) : (
            <>
              <ButtonLink variant="primary" href="/">
                Go to Now
              </ButtonLink>
              <ButtonLink variant="secondary" href="/capture">
                Capture some work
              </ButtonLink>
            </>
          )}
        </div>
      </main>
    );
  const minutes = sleepMinutes(draft.preferredBedtime, draft.preferredWakeTime);
  const last = step === STEPS;
  return (
    <main className={`content-page ${styles.page}`}>
      <div className={styles.progress}>
        <div
          className={styles.bars}
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={STEPS}
          aria-valuenow={step}
        >
          {[1, 2, 3].map((n) => (
            <i key={n} className={n <= step ? `${styles.bar} ${styles.done}` : styles.bar} />
          ))}
        </div>
        <p className={styles.caption}>
          {step} of {STEPS}
        </p>
      </div>
      <form className={styles.page} onSubmit={submit}>
        {step === 1 && (
          <>
            <div className={styles.intro}>
              <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
                When do you sleep?
              </h1>
              <p className={styles.lead}>
                OpenRhen plans around your sleep first, so nothing lands at 2 am. You can change this per night later.
              </p>
            </div>
            <div className={styles.fields}>
              <Field label="Usually in bed by">
                <input
                  type="time"
                  value={draft.preferredBedtime}
                  onChange={(event) => patch({ preferredBedtime: event.target.value })}
                />
              </Field>
              <Field label="Usually up at">
                <input
                  type="time"
                  value={draft.preferredWakeTime}
                  onChange={(event) => patch({ preferredWakeTime: event.target.value })}
                />
              </Field>
              <Field label="Timezone" wide>
                <input
                  ref={zoneRef}
                  list="setup-timezones"
                  autoComplete="off"
                  value={draft.timezone}
                  aria-invalid={zoneError ? true : undefined}
                  aria-describedby="setup-zone-note"
                  onChange={(event) => {
                    setZoneError("");
                    patch({ timezone: event.target.value });
                  }}
                />
              </Field>
              <datalist id="setup-timezones">
                {zoneNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <p
                id="setup-zone-note"
                className={`${styles.wide} ${styles.hint}`}
                role={zoneError ? "alert" : undefined}
              >
                {zoneError || `It is ${localTime} where you are. Every time in the app follows this zone.`}
              </p>
              <Field label="When did you last wake?" wide>
                <input
                  ref={wakeRef}
                  type="datetime-local"
                  value={lastWake}
                  max={nowLocal}
                  aria-invalid={wakeInvalid ? true : undefined}
                  onChange={(event) => {
                    setWakeInvalid(false);
                    setLastWake(event.target.value);
                  }}
                />
              </Field>
              <div className={styles.wide}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setWakeInvalid(false);
                    setError("");
                    setLastWake(nowLocal);
                  }}
                >
                  I woke just now
                </Button>
              </div>
            </div>
            {minutes !== null && (
              <Card className={styles.note}>
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
                </svg>
                <span>
                  {sleepSentence(minutes)}
                  <br />
                  Next: where you spend your days, then the first thing you want planned.
                </span>
              </Card>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <div className={styles.intro}>
              <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
                Where do you spend your days?
              </h1>
              <p className={styles.lead}>
                Pick where you are right now. Now uses your places to know where you are and how far things are.
              </p>
            </div>
            {places.length > 0 ? (
              <div className={styles.fields}>
                <Field label="Where are you right now?" wide>
                  <select value={placeId} onChange={(event) => setPlaceId(event.target.value)}>
                    <option value="">Not saying yet</option>
                    {places.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            ) : (
              <p className={styles.lead}>
                You have no places yet. Add home and the other places you work from in{" "}
                <a href="/settings/catalogues/conditions" target="_blank" rel="noopener">
                  Places and energy
                </a>{" "}
                (opens in a new tab; your answers here are kept), or after setup.
              </p>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <div className={styles.intro}>
              <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
                What do you want planned first?
              </h1>
              <p className={styles.lead}>
                Say it the way you would to a friend. It lands in your inbox to review, and nothing is scheduled until
                you say so.
              </p>
            </div>
            <div className={styles.fields}>
              <Field label="The first thing to plan" wide>
                <textarea
                  rows={3}
                  placeholder="For example: renew my passport before the March trip"
                  value={firstThing}
                  onChange={(event) => setFirstThing(event.target.value)}
                />
              </Field>
            </div>
          </>
        )}
        {error && (
          <Banner tone="danger" className={styles.error}>
            {error}
          </Banner>
        )}
        <div className={styles.actions}>
          <Button variant="primary" size="lg" block type="submit" disabled={saving}>
            {saving ? "Saving…" : last ? "Finish setup" : "Continue"}
          </Button>
          {saving && <p className={styles.waiting}>Waiting for the plan to finish updating…</p>}
          {/* Step 1 holds the last wake, which the plan's awake limit needs from day one, so it has no skip;
              with no navigation on this page it still needs a way out, which saves nothing. */}
          {step > 1 ? (
            <>
              <Button variant="ghost" block disabled={saving} onClick={skip}>
                Skip for now
              </Button>
              <Button variant="ghost" block disabled={saving} onClick={back}>
                Back
              </Button>
            </>
          ) : (
            <ButtonLink variant="ghost" block href="/">
              Back to Now
            </ButtonLink>
          )}
        </div>
      </form>
    </main>
  );
}
function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={wide ? `${styles.field} ${styles.wide}` : styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}
