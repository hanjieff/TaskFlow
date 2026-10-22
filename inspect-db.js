"use strict";

const { openDatabase, getDatabasePath } = require("./database");

let database;
try {
  database = openDatabase({ readOnly: true });
  const counts = database
    .prepare(
      `
        SELECT 'accounts' AS table_name, COUNT(*) AS row_count FROM accounts
        UNION ALL
        SELECT 'sessions', COUNT(*) FROM sessions
        UNION ALL 
        SELECT 'projects', COUNT(*) FROM projects
        UNION ALL
        SELECT 'tasks', COUNT(*) FROM tasks
        UNION ALL
        SELECT 'activity', COUNT(*) FROM activity
    `,
    )
    .all();
  const version = database.prepare("PRAGMA user_version").get().user_version;
  console.log(`Database: ${getDatabasePath()}`);
  console.log(`Schema version: ${version}`);
  console.table(counts);
} catch (error) {
  console.error("Database inspection failed:", error.message);
  process.exitCode = 1;
} finally {
  if (database) {
    database.close();
  }
}
