CREATE TABLE accounts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
) STRICT;

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE projects (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE tasks (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('todo', 'progress', 'done')),
    priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
    due_date TEXT NOT NULL,
    assignee TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE activity (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    date TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX projects_position ON projects(user_id, position);
CREATE INDEX tasks_position ON tasks(user_id, position);
CREATE INDEX tasks_project ON tasks(user_id, project_id);
CREATE INDEX activity_user ON activity(user_id);

PRAGMA user_version = 1;