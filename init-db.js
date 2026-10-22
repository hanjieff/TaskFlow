"use strict";

const { openDatabase, getDatabasePath } = require("./database");

let database;
try {
  database = openDatabase();
  const tables = database
    .prepare(
      `
        SELECT name FROM sqlite_schema
        WHERE type = ? AND name NOT LIKE ?
        ORDER BY name
    `,
    )
    .all("table", "sqlite_%");
  const version = database.prepare("PRAGMA user_version").get().user_version;
  console.log(`Database: ${getDatabasePath()}`);
  console.log(`Schema version: ${version}`);
  console.log(`Tables: ${tables.map((table) => table.name).join(", ")}`);
} catch (error) {
  console.error("Database initialization failed:", error.message);
  process.exitCode = 1;
} finally {
  if (database) {
    database.close();
  }
}
