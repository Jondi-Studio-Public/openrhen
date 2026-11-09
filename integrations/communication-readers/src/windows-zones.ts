import { validZone } from "./resolve-when.js";

/**
 * The common Windows / Exchange / Outlook time zone names (the `TZID` of mail from those clients) and the IANA zone
 * CLDR `windowsZones` gives each for its primary territory. Only names a calendar really writes; anything else is not
 * guessed. Keys are lower case.
 */
const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  "dateline standard time": "Etc/GMT+12",
  "utc-11": "Etc/GMT+11",
  "hawaiian standard time": "Pacific/Honolulu",
  "alaskan standard time": "America/Anchorage",
  "pacific standard time": "America/Los_Angeles",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago",
  "canada central standard time": "America/Regina",
  "central america standard time": "America/Guatemala",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indiana/Indianapolis",
  "atlantic standard time": "America/Halifax",
  "newfoundland standard time": "America/St_Johns",
  "e. south america standard time": "America/Sao_Paulo",
  "argentina standard time": "America/Argentina/Buenos_Aires",
  "sa pacific standard time": "America/Bogota",
  "mexico standard time": "America/Mexico_City",
  "greenwich standard time": "Atlantic/Reykjavik",
  "gmt standard time": "Europe/London",
  utc: "UTC",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "romance standard time": "Europe/Paris",
  "central european standard time": "Europe/Warsaw",
  "gtb standard time": "Europe/Bucharest",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Kiev",
  "turkey standard time": "Europe/Istanbul",
  "israel standard time": "Asia/Jerusalem",
  "egypt standard time": "Africa/Cairo",
  "south africa standard time": "Africa/Johannesburg",
  "w. central africa standard time": "Africa/Lagos",
  "e. africa standard time": "Africa/Nairobi",
  "arab standard time": "Asia/Riyadh",
  "russian standard time": "Europe/Moscow",
  "arabian standard time": "Asia/Dubai",
  "iran standard time": "Asia/Tehran",
  "pakistan standard time": "Asia/Karachi",
  "india standard time": "Asia/Kolkata",
  "sri lanka standard time": "Asia/Colombo",
  "nepal standard time": "Asia/Kathmandu",
  "bangladesh standard time": "Asia/Dhaka",
  "se asia standard time": "Asia/Bangkok",
  "china standard time": "Asia/Shanghai",
  "singapore standard time": "Asia/Singapore",
  "w. australia standard time": "Australia/Perth",
  "taipei standard time": "Asia/Taipei",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "aus central standard time": "Australia/Darwin",
  "cen. australia standard time": "Australia/Adelaide",
  "e. australia standard time": "Australia/Brisbane",
  "aus eastern standard time": "Australia/Sydney",
  "tasmania standard time": "Australia/Hobart",
  "west pacific standard time": "Pacific/Port_Moresby",
  "new zealand standard time": "Pacific/Auckland",
  "fiji standard time": "Pacific/Fiji",
  "tonga standard time": "Pacific/Tongatapu",
  "samoa standard time": "Pacific/Apia"
};

/**
 * The IANA zone a `TZID` names: the name itself when it is an IANA zone this runtime knows, else its Windows name's
 * CLDR zone, else null. Never a guess from an abbreviation ("EST") or a display string ("(UTC+10:00) Sydney").
 */
export function zoneOfTzid(tzid: string): string | null {
  const key = tzid.trim().toLowerCase();
  if (validZone(tzid)) return tzid;
  const mapped = WINDOWS_ZONES[key];
  return mapped !== undefined && validZone(mapped) ? mapped : null;
}
