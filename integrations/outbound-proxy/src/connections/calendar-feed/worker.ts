// Worker entry: parse one feed off the main thread. Bundled on its own as dist/calendar-feed-worker.js.
// It imports nothing from the rest of the proxy, so a hostile feed reaches only parser code.
import { parentPort, workerData } from "node:worker_threads";
import { parseFeed, type ParseRequest } from "./parse.js";

if (!parentPort) throw new Error("calendar-feed worker must run in a worker thread");
const request = workerData as ParseRequest;
parentPort.postMessage({ ok: true, result: parseFeed(request) });
