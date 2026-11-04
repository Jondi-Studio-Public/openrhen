import type postgres from "postgres";

/** Places, readings and requests shared by the location-observation integration suites. */

export type Place = { id: string; name: string; latitude: number; longitude: number };

export const home: Place = { id: "home", name: "Home", latitude: -33.8688, longitude: 151.2093 };
/** Metres per degree of latitude on the matcher's own sphere, so fixtures sit at exact distances. */
const METRES_PER_DEGREE = (Math.PI * 6371 * 1000) / 180;
export const northOf = (metres: number) => ({
  latitude: home.latitude + metres / METRES_PER_DEGREE,
  longitude: home.longitude
});
export const shed: Place = { id: "shed", name: "Shed", ...northOf(4000) };

export function reading(place: { latitude: number; longitude: number }, minutesAgo: number, accuracyMeters = 12) {
  return {
    latitude: place.latitude,
    longitude: place.longitude,
    accuracyMeters,
    observedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString()
  };
}

/** A phone ping carrying `token` as its bearer, or no authorization header at all for `null`. */
export function pingRequest(body: unknown, token: string | null) {
  return new Request("http://localhost/api/location/ping", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify(body)
  });
}

export async function savePlace(sql: postgres.Sql, userId: string, place: Place) {
  await sql`
    INSERT INTO condition_definitions (user_id, id, name, kind, latitude, longitude)
    VALUES (${userId}, ${place.id}, ${place.name}, 'location', ${place.latitude}, ${place.longitude})
  `;
}

export async function assertLocation(sql: postgres.Sql, userId: string, locationId: string, setAt = new Date()) {
  await sql`
    UPDATE user_preferences
    SET current_situation = ${sql.json({ locationId, locationSetAt: setAt.toISOString(), overrides: {}, carrying: {}, transportModes: ["car"], travel: {} } as never)}
    WHERE user_id = ${userId}
  `;
}

/**
 * Moves every stored reading's server receipt time back, as if it had arrived `minutes` ago. Sustained
 * presence is measured on receipt (`recordedAt`), so a test that needs "ten minutes of presence" has to
 * age what the server already holds rather than only date the next reading in the past.
 */
export async function ageStoredReadings(sql: postgres.Sql, userId: string, minutes: number) {
  const rows = await sql<{ device_location_state: { observations?: { recordedAt: string }[] } }[]>`
    SELECT device_location_state FROM user_preferences WHERE user_id = ${userId}
  `;
  const state = rows[0]!.device_location_state;
  const observations = (state.observations ?? []).map((entry) => ({
    ...entry,
    recordedAt: new Date(Date.parse(entry.recordedAt) - minutes * 60_000).toISOString()
  }));
  await sql`UPDATE user_preferences SET device_location_state = ${sql.json({ ...state, observations } as never)} WHERE user_id = ${userId}`;
}
