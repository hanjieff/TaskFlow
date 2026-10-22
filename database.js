"use strict";

const { DatabaseSync } = require("node:sqlite");
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SCHEMA_VERSION = 1;

class WorkspaceConflictError extends Error {
  constructor() {
    super("Your workspace changed. Refresh the page before retrying.");
    this.name = "WorkspaceConflictError";
  }
}

function getDatabasePath() {
  const configuredPath = process.env.TASKFLOW_DATABASE;
  return path.resolve(__dirname, configuredPath || "data/taskflow.sqlite");
}

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Database rollback failed:",
        rollbackError.code || rollbackError.name,
      );
    }
    throw error;
  }
}

function initializeDatabase(database) {
  const version = database.prepare("PRAGMA user_version").get().user_version;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Unsupported database schema version ${version}; this code supports ${SCHEMA_VERSION}.`,
    );
  }
  if (version === SCHEMA_VERSION) {
    return;
  }

  transaction(database, () => {
    // Recheck after acquiring the write lock, in case another process initialized first.
    const lockedVersion = database
      .prepare("PRAGMA user_version")
      .get().user_version;
    if (lockedVersion > SCHEMA_VERSION) {
      throw new Error(`Unsupported database schema version ${lockedVersion}.`);
    }
    if (lockedVersion === 0) {
      const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
      database.exec(schema);
    }
  });
}

function openDatabase({ readOnly = false } = {}) {
  const filename = getDatabasePath();
  if (readOnly && !existsSync(filename)) {
    throw new Error(`Database does not exist: ${filename}. Run init-db first.`);
  }
  if (!readOnly) {
    mkdirSync(path.dirname(filename), { recursive: true });
  }

  const database = new DatabaseSync(filename, { readOnly });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    if (readOnly) {
      const version = database
        .prepare("PRAGMA user_version")
        .get().user_version;
      if (version !== SCHEMA_VERSION) {
        throw new Error(
          `Unsupported database schema version ${version}; expected ${SCHEMA_VERSION}.`,
        );
      }
    } else {
      initializeDatabase(database);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function findAccountByEmail(database, email) {
  return database
    .prepare(
      `
    SELECT id, name, email, salt, password_hash AS passwordHash
    FROM accounts
    WHERE email = ?
  `,
    )
    .get(email);
}

function findSessionUser(database, tokenHash, now = Date.now()) {
  if (!tokenHash) {
    return null;
  }
  const user = database
    .prepare(
      `
    SELECT accounts.id, accounts.name, accounts.email
    FROM sessions
    JOIN accounts ON accounts.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `,
    )
    .get(tokenHash, now);
  return user || null;
}

function replaceSession(database, session, previousTokenHash) {
  database
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(Date.now());
  if (previousTokenHash) {
    database
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(previousTokenHash);
  }
  database
    .prepare(
      `
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `,
    )
    .run(session.tokenHash, session.userId, session.expiresAt);
}

function createAccount(database, account, session, previousTokenHash) {
  transaction(database, () => {
    database
      .prepare(
        `
      INSERT INTO accounts (id, name, email, salt, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(
        account.id,
        account.name,
        account.email,
        account.salt,
        account.passwordHash,
      );
    replaceSession(database, session, previousTokenHash);
  });
}

function createSession(database, session, previousTokenHash) {
  transaction(database, () => {
    replaceSession(database, session, previousTokenHash);
  });
}

function deleteSession(database, tokenHash) {
  if (tokenHash) {
    database
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(tokenHash);
  }
}

function readWorkspaceRows(database, userId) {
  const account = database
    .prepare("SELECT version FROM accounts WHERE id = ?")
    .get(userId);
  if (!account) {
    return null;
  }
  const projects = database
    .prepare(
      `
    SELECT id, name, description
    FROM projects
    WHERE user_id = ?
    ORDER BY position
  `,
    )
    .all(userId);
  const tasks = database
    .prepare(
      `
    SELECT id, project_id AS projectId, title, description, status, priority,
           due_date AS dueDate, assignee
    FROM tasks
    WHERE user_id = ?
    ORDER BY position
  `,
    )
    .all(userId);
  const activity = database
    .prepare(
      `
    SELECT id, text, date
    FROM activity
    WHERE user_id = ?
    ORDER BY rowid DESC
    LIMIT 8
  `,
    )
    .all(userId);
  return { version: account.version, projects, tasks, activity };
}

function readWorkspace(database, userId) {
  // A read transaction keeps all four SELECTs on the same snapshot.
  database.exec("BEGIN");
  try {
    const workspace = readWorkspaceRows(database, userId);
    database.exec("COMMIT");
    return workspace;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function saveWorkspace(database, userId, snapshot) {
  return transaction(database, () => {
    const updated = database
      .prepare(
        `
      UPDATE accounts SET version = version + 1
      WHERE id = ? AND version = ?
    `,
      )
      .run(userId, snapshot.version);
    if (updated.changes !== 1) {
      throw new WorkspaceConflictError();
    }

    database.prepare("DELETE FROM tasks WHERE user_id = ?").run(userId);
    database.prepare("DELETE FROM projects WHERE user_id = ?").run(userId);

    const insertProject = database.prepare(`
      INSERT INTO projects (user_id, id, name, description, position)
      VALUES (?, ?, ?, ?, ?)
    `);
    snapshot.projects.forEach((project, position) => {
      insertProject.run(
        userId,
        project.id,
        project.name,
        project.description,
        position,
      );
    });

    const insertTask = database.prepare(`
      INSERT INTO tasks (
        user_id, id, project_id, title, description, status, priority,
        due_date, assignee, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    snapshot.tasks.forEach((task, position) => {
      insertTask.run(
        userId,
        task.id,
        task.projectId,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.dueDate,
        task.assignee,
        position,
      );
    });

    database
      .prepare(
        `
      INSERT INTO activity (id, user_id, text, date)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(randomUUID(), userId, snapshot.message, new Date().toISOString());
    database
      .prepare(
        `
      DELETE FROM activity
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM activity WHERE user_id = ? ORDER BY rowid DESC LIMIT 8
      )
    `,
      )
      .run(userId, userId);

    return readWorkspaceRows(database, userId);
  });
}

module.exports = {
  getDatabasePath,
  openDatabase,
  initializeDatabase,
  findAccountByEmail,
  findSessionUser,
  createAccount,
  createSession,
  deleteSession,
  readWorkspace,
  saveWorkspace,
  WorkspaceConflictError,
};
