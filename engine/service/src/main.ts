import { createServer } from "node:http";
import { handleRequest } from "./server.js";
import { startupRefusal } from "./startup.js";

const host = process.env.PLAN_FORECAST_HOST ?? "0.0.0.0";
const port = integer(process.env.PLAN_FORECAST_PORT, 4100);
const maxPayloadBytes = integer(process.env.PLAN_FORECAST_MAX_PAYLOAD_BYTES, 5 * 1024 * 1024);
const refusal = startupRefusal(process.env);
if (refusal) throw new Error(refusal);
const token = process.env.PLAN_FORECAST_SERVICE_TOKEN ?? "";

const server = createServer((request, response) => void handleRequest(request, response, { token, maxPayloadBytes }));
server.requestTimeout = integer(process.env.PLAN_FORECAST_REQUEST_TIMEOUT_MS, 10_000);
server.listen(port, host, () =>
  process.stdout.write(`${JSON.stringify({ level: "info", message: "Plan and Forecast Engine ready", host, port })}\n`)
);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    process.stdout.write(
      `${JSON.stringify({ level: "info", message: "Plan and Forecast Engine stopping", signal })}\n`
    );
    server.close((error) => process.exit(error ? 1 : 0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });

function integer(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
