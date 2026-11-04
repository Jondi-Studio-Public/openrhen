/**
 * One-time sign-in for the read-only Google Calendar integration, run on the desktop:
 *   corepack pnpm --filter @openrhen/outbound-proxy google-calendar:auth
 * It needs GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET (a Desktop-type OAuth
 * client works), opens a loopback consent for the calendar.readonly scope, and saves the
 * refresh token to an owner-only temp file (never printed). Move it into your secrets manager
 * as GOOGLE_CALENDAR_REFRESH_TOKEN, then delete the file.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export async function runGoogleCalendarAuthFlow(
  clientId: string,
  clientSecret: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<string> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
  const state = crypto.randomBytes(16).toString("hex");

  // Fixed once the server is listening and reused verbatim in the token exchange.
  let redirectUri = "";
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error || !returnedCode || returnedState !== state) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Authorization failed. You can close this tab.");
        server.close();
        clearTimeout(timer);
        reject(new Error(`Authorization failed: ${error ?? "missing code or state mismatch"}`));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end("Google Calendar authorized. You can close this tab and return to the terminal.");
      server.close();
      clearTimeout(timer);
      resolve(returnedCode);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = `${AUTH_URL}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        state
      }).toString()}`;
      console.log("Open this URL in your browser to authorize read-only Google Calendar access:\n");
      console.log(`  ${authUrl}\n`);
      if (process.platform === "win32") {
        try {
          // Not `cmd /c start`: cmd splits the URL at its first &, so Google sees only client_id.
          spawn("rundll32", ["url.dll,FileProtocolHandler", authUrl], { detached: true, stdio: "ignore" }).unref();
        } catch {
          // The URL is printed above; opening it by hand works.
        }
      }
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for authorization (5 minutes)."));
    }, timeoutMs);
    timer.unref();
  });

  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    }).toString()
  });
  if (!response.ok) throw new Error(`Google token endpoint returned HTTP ${response.status}.`);
  const tokens = (await response.json()) as { refresh_token?: string };
  if (!tokens.refresh_token)
    throw new Error(
      "Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and rerun."
    );
  return tokens.refresh_token;
}

const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET, then run this again.");
  process.exit(1);
}
try {
  const token = await runGoogleCalendarAuthFlow(clientId, clientSecret);
  // Not printed: terminal scrollback and agent transcripts are not private.
  const dir = await mkdtemp(join(tmpdir(), "openrhen-oauth-"));
  const path = join(dir, "GOOGLE_CALENDAR_REFRESH_TOKEN");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  console.log("Authorization successful. The refresh token was not printed. It is in an owner-only file:\n");
  console.log(`  ${path}\n`);
  console.log("Store its contents as GOOGLE_CALENDAR_REFRESH_TOKEN in your secrets manager, then delete the file.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Authorization failed.");
  process.exit(1);
}
