"use client";

import { useSyncExternalStore } from "react";

/**
 * The portal's one clock.
 *
 * `now` used to be React state in the portal provider, ticking every second and travelling in the
 * context value. That made every component reading the context — the shell, the nav, whichever page
 * was open, the capture sheet — re-render once a second whether or not it showed a time, and on a slow
 * phone that re-render landed in the middle of every scroll. Here the clock is a store outside React:
 * a component asks for it at the coarsest rate it can use, and only that component re-renders.
 *
 * The interval runs only while something is subscribed, and a single interval serves every
 * subscriber. The `minute` snapshot is a `Date` that only changes identity when the minute changes,
 * which is what lets a minute subscriber stay still for the other fifty-nine ticks.
 */
export type ClockGranularity = "second" | "minute";

/** Before hydration, and on the server, the clock reads the epoch — the value it has always read there. */
const INITIAL_RENDER_TIME = new Date(0);

let current = INITIAL_RENDER_TIME;
let currentMinute = INITIAL_RENDER_TIME;
let frozen = false;
let timer: ReturnType<typeof setInterval> | null = null;
const secondListeners = new Set<() => void>();
const minuteListeners = new Set<() => void>();

function minuteOf(date: Date) {
  return Math.floor(date.getTime() / 60_000);
}

function advance(next: Date) {
  current = next;
  const minuteChanged = minuteOf(next) !== minuteOf(currentMinute);
  if (minuteChanged) currentMinute = new Date(minuteOf(next) * 60_000);
  for (const listener of secondListeners) listener();
  if (minuteChanged) for (const listener of minuteListeners) listener();
}

function tick() {
  if (!frozen) advance(new Date());
}

function ensureRunning() {
  if (frozen || timer !== null || typeof window === "undefined") return;
  // Read the real time at once rather than waiting a second, so a subscriber never renders the epoch.
  tick();
  timer = setInterval(tick, 1000);
}

function stopIfIdle() {
  if (timer === null || secondListeners.size || minuteListeners.size) return;
  clearInterval(timer);
  timer = null;
}

function subscribeSecond(listener: () => void) {
  secondListeners.add(listener);
  ensureRunning();
  return () => {
    secondListeners.delete(listener);
    stopIfIdle();
  };
}

function subscribeMinute(listener: () => void) {
  minuteListeners.add(listener);
  ensureRunning();
  return () => {
    minuteListeners.delete(listener);
    stopIfIdle();
  };
}

const readSecond = () => current;
const readMinute = () => currentMinute;
const readServer = () => INITIAL_RENDER_TIME;

/**
 * The current time, re-rendering the caller once a second or once a minute. Ask for `minute` unless
 * the component shows seconds or must react within a second; the difference is a sixtyfold reduction
 * in how often that subtree is rebuilt.
 */
export function useNow(granularity: ClockGranularity = "second"): Date {
  const second = granularity === "second";
  return useSyncExternalStore(second ? subscribeSecond : subscribeMinute, second ? readSecond : readMinute, readServer);
}

/**
 * The clock's current reading without subscribing to it, for event handlers and timers that need the
 * time once. Outside a frozen replay this is simply the wall clock, read fresh.
 */
export function readNow(): Date {
  return frozen ? current : new Date();
}

/**
 * Stops the clock at `at`. A replay of a captured snapshot is frozen at the instant it was taken;
 * ticking would drift the page away from the moment being investigated, and the countdowns and
 * validity checks along with it. Tests freeze the clock for the same reason.
 */
export function freezeClock(at: Date) {
  frozen = true;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  advance(at);
}
