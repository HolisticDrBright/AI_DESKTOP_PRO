// Bind the standalone Next server on all container interfaces so the load
// balancer can reach the task. This entry point contains no provider logic,
// credentials, health data, or environment fallback.
process.env.HOSTNAME = "0.0.0.0";
await import("./server.js");
