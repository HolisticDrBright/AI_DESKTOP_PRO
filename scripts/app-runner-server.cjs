"use strict";

// App Runner supplies its own HOSTNAME value. Next standalone otherwise binds
// only to that resolved instance address and the managed health check cannot
// reach port 3000. Force the container listener boundary before server.js is
// loaded; this file runs directly under distroless Node and needs no shell.
process.env.HOSTNAME = "0.0.0.0";
require("./server.js");
