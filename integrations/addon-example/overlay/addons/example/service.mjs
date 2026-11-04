// The example add-on's extra service: logs a heartbeat. Fake data only.
const seconds = Number(process.env.EXAMPLE_ADDON_INTERVAL_SECONDS ?? 60);
setInterval(() => console.log(JSON.stringify({ service: "example-addon", heartbeat: true })), seconds * 1000);
