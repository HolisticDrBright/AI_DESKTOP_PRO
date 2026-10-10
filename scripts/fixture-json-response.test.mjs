import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

const moduleUrl = new URL("./fixture-json-response.mjs", import.meta.url).href;
// A separate server thread continues its idle clock while the client is paused.
// The shared signal proves the first socket really closed; no sleep-only proof.
const workerSource = `
import { parentPort, workerData } from "node:worker_threads";
import http from "node:http";
const { fixtureJsonResponse } = await import(workerData.moduleUrl);
const closed = new Int32Array(workerData.closed);
let requests = 0;
let sockets = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    requests++;
    const body = { requests, sockets };
    const status = workerData.status;
    if (workerData.persistent) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      fixtureJsonResponse(res, status, body);
    }
  });
});
server.keepAliveTimeout = 1000;
server.keepAliveTimeoutBuffer = 0;
server.on("connection", (socket) => {
  sockets++;
  if (sockets === 1) socket.on("close", () => {
    Atomics.store(closed, 0, 1);
    Atomics.notify(closed, 0);
  });
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
`;

async function fixture(persistent, status = 200) {
  const closed = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(workerSource, {
    eval: true,
    execArgv: ["--input-type=module"],
    workerData: { moduleUrl, closed: closed.buffer, persistent, status },
  });
  const [port] = await once(worker, "message");
  const agent = new http.Agent({
    keepAlive: true, maxSockets: 1, agentKeepAliveTimeoutBuffer: 0,
  });
  function post() {
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1", port, path: "/delivery", method: "POST", agent,
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({
          status: response.statusCode, connection: response.headers.connection,
          reused: request.reusedSocket, body: JSON.parse(body),
        }));
      });
      request.on("error", (error) => {
        error.reused = request.reusedSocket;
        reject(error);
      });
      request.setTimeout(5000, () => request.destroy(new Error("request deadline")));
      request.end("{}"); // Exactly one write attempt; no recovery replay.
    });
  }
  return {
    agent, closed, post,
    async stop() { agent.destroy(); await worker.terminate(); },
  };
}

test("negative control reproduces an unknown POST on an idle pooled socket", async () => {
  const server = await fixture(true);
  try {
    const first = await server.post();
    assert.equal(first.connection, "keep-alive");
    await new Promise(setImmediate);
    assert.equal(Object.values(server.agent.freeSockets).flat().length, 1);
    assert.notEqual(Atomics.wait(server.closed, 0, 0, 5000), "timed-out");
    await assert.rejects(server.post(), (error) =>
      error.code === "ECONNRESET" && error.reused === true);
  } finally { await server.stop(); }
});

test("fixture closes each response and the next callback is sent once on a new socket", async () => {
  const server = await fixture(false);
  try {
    const first = await server.post();
    assert.equal(first.connection, "close");
    await new Promise(setImmediate);
    assert.equal(Object.values(server.agent.freeSockets).flat().length, 0);
    assert.notEqual(Atomics.wait(server.closed, 0, 0, 5000), "timed-out");
    const second = await server.post();
    assert.equal(second.reused, false);
    assert.equal(second.connection, "close");
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { requests: 2, sockets: 2 });
  } finally { await server.stop(); }
});

test("fixture refusals preserve their status and are not retried", async () => {
  const server = await fixture(false, 503);
  try {
    const first = await server.post();
    const second = await server.post();
    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.deepEqual(second.body, { requests: 2, sockets: 2 });
  } finally { await server.stop(); }
});

test("the actual fixture wires the tested transport without changing browser retries", async () => {
  const fixtureSource = await readFile(new URL("./live-stub-server.mjs", import.meta.url), "utf8");
  assert.match(fixtureSource, /import \{ fixtureJsonResponse as json \} from "\.\/fixture-json-response\.mjs"/);
  assert.doesNotMatch(fixtureSource, /const json\s*=/);
  const config = await readFile(new URL("../playwright.config.ts", import.meta.url), "utf8");
  assert.match(config, /retries: 0/);
});
