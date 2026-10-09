/** Synthetic contract-fixture transport only; never used by the clinical API. */
export function fixtureJsonResponse(res, status, value) {
  // Do not pool a mutation socket across browser navigations. An idle server
  // close can race a paused client reusing it, leaving the write outcome unknown.
  // Close explicitly instead of retrying a POST or extending test timeouts.
  res.writeHead(status, {
    "content-type": "application/json",
    connection: "close",
  });
  res.end(JSON.stringify(value));
}
