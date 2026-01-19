import { config } from "./config.js";
import { migrate, openDb } from "./db.js";
import { createApp } from "./app.js";
import { createStore } from "./store.js";

const db = openDb(config.dbPath);
migrate(db);

const store = createStore(db);
const app = createApp(store);

const server = app.listen(config.port, () => {
  console.log(`server listening on http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

