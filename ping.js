// conu-community/ping.js
const express = require("express");
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, t: Date.now() });
});

app.listen(4000, "127.0.0.1", () => {
  console.log("PING on http://127.0.0.1:4000");
});
