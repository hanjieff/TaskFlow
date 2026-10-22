"use strict";

const http = require("node:http");
const path = require("node:path");
const { readFile } = require("node:fs/promises");
const {
  randomBytes,
  randomUUID,
  pbkdf2,
  timingSafeEqual,
  createHash,
} = require("node:crypto");
const { promisify } = require("node:util");
const {
  openDatabase,
  findAccountByEmail,
  findSessionUser,
  createAccount,
  createSession,
  deleteSession,
  readWorkspace,
  saveWorkspace,
  WorkspaceConflictError,
} = require("./database");

const derivePassword = promisify(pbkdf2);
const PASSWORD_ITERATIONS = 210000;
const BODY_LIMIT = 1024 * 1024;
const BODY_TIMEOUT = 10000;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_NAME = "taskflow.db.session";
const AUTH_WINDOW = 15 * 60 * 1000;
const AUTH_LIMIT = 20;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_SALT = randomBytes(16).toString("hex");
const DUMMY_HASH = randomBytes(32);
const PUBLIC_DIRECTORY = path.join(__dirname, "public");
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/login.html", ["login.html", "text/html; charset=utf-8"]],
  ["/signup.html", ["signup.html", "text/html; charset=utf-8"]],
  ["/projects.html", ["projects.html", "text/html; charset=utf-8"]],
  ["/tasks.html", ["tasks.html", "text/html; charset=utf-8"]],
  ["/css/style.css", ["css/style.css", "text/css; charset=utf-8"]],
  ["/js/api.js", ["js/api.js", "text/javascript; charset=utf-8"]],
  ["/js/theme.js", ["js/theme.js", "text/javascript; charset=utf-8"]],
  ["/js/auth.js", ["js/auth.js", "text/javascript; charset=utf-8"]],
  ["/js/workspace.js", ["js/workspace.js", "text/javascript; charset=utf-8"]],
]);
const API_METHODS = new Map([
  ["/api/me", "GET"],
  ["/api/signup", "POST"],
  ["/api/login", "POST"],
  ["/api/logout", "POST"],
  ["/api/workspace", "GET, PUT"],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getPort() {
  const value = process.env.PORT === undefined ? "5185" : process.env.PORT;
  if (!/^\d+$/.test(value)) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, status, body) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function parseJsonObject(buffer) {
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must contain valid, nonempty JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value;
}

function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (
    contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json"
  ) {
    request.resume();
    throw new HttpError(400, "Content-Type must be application/json.");
  }
  if (Number(request.headers["content-length"]) > BODY_LIMIT) {
    request.resume();
    throw new HttpError(413, "Request body exceeds 1 MiB.");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new HttpError(400, "Request body timed out."));
    }, BODY_TIMEOUT);
    timer.unref();

    function cleanup() {
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
      request.removeListener("error", onError);
    }

    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    }

    function onData(chunk) {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new HttpError(413, "Request body exceeds 1 MiB."));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (settled) {
        return;
      }
      try {
        const body = parseJsonObject(Buffer.concat(chunks, size));
        settled = true;
        cleanup();
        resolve(body);
      } catch (error) {
        fail(error);
      }
    }

    function onAborted() {
      fail(new HttpError(400, "Request body was interrupted."));
    }

    function onError() {
      fail(new HttpError(400, "Could not read the request body."));
    }

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);
  });
}

function textField(value, label, maximum, required = false) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${label} must be a string.`);
  }
  const text = value.trim();
  if ((required && text.length === 0) || text.length > maximum) {
    throw new HttpError(
      400,
      `${label} must be ${required ? "1" : "0"} to ${maximum} characters.`,
    );
  }
  return text;
}

function descriptionField(value, label) {
  if (typeof value !== "string" || value.length > 2000) {
    throw new HttpError(
      400,
      `${label} must be a string of at most 2000 characters.`,
    );
  }
  return value;
}

function emailField(value) {
  const email = textField(value, "Email", 254, true).toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(
      400,
      "Enter a valid email address, up to 254 characters.",
    );
  }
  return email;
}

function passwordField(value, signingUp) {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    (signingUp && value.length < 8)
  ) {
    throw new HttpError(
      400,
      signingUp
        ? "Password must be 8 to 128 characters."
        : "Password must be a string of at most 128 characters.",
    );
  }
  return value;
}

function uuidField(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new HttpError(
      400,
      `${label} must be a UUID in canonical dashed format.`,
    );
  }
  return value.toLowerCase();
}

function objectField(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object.`);
  }
  return value;
}

function dueDateField(value) {
  if (value === "") {
    return value;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(
      400,
      "Due date must be empty or a real YYYY-MM-DD calendar date.",
    );
  }
  const [year, month, day] = value.split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1]
  ) {
    throw new HttpError(
      400,
      "Due date must be empty or a real YYYY-MM-DD calendar date.",
    );
  }
  return value;
}

function validateWorkspace(body) {
  if (!Number.isSafeInteger(body.version) || body.version < 0) {
    throw new HttpError(
      400,
      "Workspace version must be a nonnegative safe integer.",
    );
  }
  if (!Array.isArray(body.projects) || body.projects.length > 200) {
    throw new HttpError(400, "Projects must be an array of at most 200 items.");
  }
  if (!Array.isArray(body.tasks) || body.tasks.length > 2000) {
    throw new HttpError(400, "Tasks must be an array of at most 2000 items.");
  }
  const message = textField(body.message, "Activity message", 300, true);
  const projectIds = new Set();
  const projects = body.projects.map((value) => {
    const project = objectField(value, "Project");
    const id = uuidField(project.id, "Project ID");
    if (projectIds.has(id)) {
      throw new HttpError(400, "Duplicate project IDs are not allowed.");
    }
    projectIds.add(id);
    return {
      id,
      name: textField(project.name, "Project name", 80, true),
      description: descriptionField(project.description, "Project description"),
    };
  });

  const taskIds = new Set();
  const tasks = body.tasks.map((value) => {
    const task = objectField(value, "Task");
    const id = uuidField(task.id, "Task ID");
    const projectId = uuidField(task.projectId, "Task project ID");
    if (taskIds.has(id)) {
      throw new HttpError(400, "Duplicate task IDs are not allowed.");
    }
    if (!projectIds.has(projectId)) {
      throw new HttpError(
        400,
        "Every task must reference a project in your submitted workspace.",
      );
    }
    if (!["todo", "progress", "done"].includes(task.status)) {
      throw new HttpError(400, "Task status must be todo, progress, or done.");
    }
    if (!["low", "medium", "high"].includes(task.priority)) {
      throw new HttpError(400, "Task priority must be low, medium, or high.");
    }
    taskIds.add(id);
    return {
      id,
      projectId,
      title: textField(task.title, "Task title", 120, true),
      description: descriptionField(task.description, "Task description"),
      status: task.status,
      priority: task.priority,
      dueDate: dueDateField(task.dueDate),
      assignee: textField(task.assignee, "Task assignee", 80),
    };
  });
  return { version: body.version, projects, tasks, message };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function requestTokenHash(request) {
  const cookies = (request.headers.cookie || "").split(";");
  const matches = cookies
    .map((cookie) => cookie.trim())
    .filter((cookie) => {
      return cookie.startsWith(`${COOKIE_NAME}=`);
    });
  if (matches.length !== 1) {
    return null;
  }
  const token = matches[0].slice(COOKIE_NAME.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return null;
  }
  return hashToken(token);
}

function newSession(userId) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashToken(token),
    userId,
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  };
}

function setSessionCookie(response, token) {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
}

function publicUser(account) {
  return { id: account.id, name: account.name, email: account.email };
}

function createAuthLimiter() {
  const buckets = new Map();
  return function limitAuth(request, response) {
    const now = Date.now();
    for (const [ip, bucket] of buckets) {
      if (bucket.expiresAt <= now) {
        buckets.delete(ip);
      }
    }
    const ip = request.socket.remoteAddress || "unknown";
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { count: 0, expiresAt: now + AUTH_WINDOW };
      buckets.set(ip, bucket);
    }
    if (bucket.count >= AUTH_LIMIT) {
      response.setHeader(
        "Retry-After",
        String(Math.ceil((bucket.expiresAt - now) / 1000)),
      );
      throw new HttpError(
        429,
        "Too many authentication requests. Try again in 15 minutes.",
      );
    }
    bucket.count += 1;
  };
}

async function signUp(database, request, response, body) {
  const name = textField(body.name, "Name", 60, true);
  const email = emailField(body.email);
  const password = passwordField(body.password, true);
  if (findAccountByEmail(database, email)) {
    throw new HttpError(409, "An account with that email already exists.");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = await derivePassword(
    password,
    salt,
    PASSWORD_ITERATIONS,
    32,
    "sha256",
  );
  // Password derivation yields; uniqueness must be checked again and enforced by SQLite.
  if (findAccountByEmail(database, email)) {
    throw new HttpError(409, "An account with that email already exists.");
  }
  const account = {
    id: randomUUID(),
    name,
    email,
    salt,
    passwordHash: hash.toString("hex"),
  };
  const session = newSession(account.id);
  try {
    createAccount(database, account, session, requestTokenHash(request));
  } catch (error) {
    if (findAccountByEmail(database, email)) {
      throw new HttpError(409, "An account with that email already exists.");
    }
    throw error;
  }
  setSessionCookie(response, session.token);
  sendJson(response, 201, { user: publicUser(account) });
}

async function logIn(database, request, response, body) {
  const email = emailField(body.email);
  const password = passwordField(body.password, false);
  const account = findAccountByEmail(database, email);
  const salt = account ? account.salt : DUMMY_SALT;
  const expectedHash = account
    ? Buffer.from(account.passwordHash, "hex")
    : DUMMY_HASH;
  const actualHash = await derivePassword(
    password,
    salt,
    PASSWORD_ITERATIONS,
    32,
    "sha256",
  );
  const matches =
    expectedHash.length === actualHash.length &&
    timingSafeEqual(actualHash, expectedHash);
  if (!account || !matches) {
    throw new HttpError(401, "Email or password is incorrect.");
  }
  const session = newSession(account.id);
  createSession(database, session, requestTokenHash(request));
  setSessionCookie(response, session.token);
  sendJson(response, 200, { user: publicUser(account) });
}

async function serveAsset(request, response, pathname) {
  const asset = ASSETS.get(pathname);
  if (!asset) {
    throw new HttpError(404, "Not found.");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    throw new HttpError(405, "Method not allowed.");
  }
  let content;
  try {
    content = await readFile(path.join(PUBLIC_DIRECTORY, asset[0]));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new HttpError(404, "Public asset not found.");
    }
    throw error;
  }
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Content-Type", asset[1]);
  response.setHeader("Content-Length", content.length);
  response.statusCode = 200;
  response.end(request.method === "HEAD" ? undefined : content);
}

function createTaskFlowServer(database, port = getPort()) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Server port must be an integer between 1 and 65535.");
  }
  const expectedHost = `127.0.0.1:${port}`;
  const expectedOrigin = `http://${expectedHost}`;
  const limitAuth = createAuthLimiter();

  async function handleRequest(request, response) {
    if (request.headers.host !== expectedHost) {
      throw new HttpError(
        403,
        "Invalid Host. Use the loopback server address.",
      );
    }
    if (
      (request.method === "POST" || request.method === "PUT") &&
      request.headers.origin !== expectedOrigin
    ) {
      throw new HttpError(
        403,
        "A matching same-origin Origin header is required.",
      );
    }
    const pathname = new URL(request.url, expectedOrigin).pathname;
    if (!pathname.startsWith("/api/")) {
      await serveAsset(request, response, pathname);
      return;
    }
    const allowedMethods = API_METHODS.get(pathname);
    if (!allowedMethods) {
      throw new HttpError(404, "API endpoint not found.");
    }
    if (!allowedMethods.split(", ").includes(request.method)) {
      response.setHeader("Allow", allowedMethods);
      throw new HttpError(405, "Method not allowed.");
    }
    if (pathname === "/api/me") {
      const user = findSessionUser(database, requestTokenHash(request));
      sendJson(response, 200, { user });
      return;
    }
    if (
      pathname === "/api/signup" ||
      pathname === "/api/login" ||
      pathname === "/api/logout"
    ) {
      limitAuth(request, response);
      const body = await readJson(request);
      if (pathname === "/api/signup") {
        await signUp(database, request, response, body);
      } else if (pathname === "/api/login") {
        await logIn(database, request, response, body);
      } else {
        deleteSession(database, requestTokenHash(request));
        clearSessionCookie(response);
        sendJson(response, 200, { ok: true });
      }
      return;
    }

    const user = findSessionUser(database, requestTokenHash(request));
    if (!user) {
      throw new HttpError(401, "Please log in to access your workspace.");
    }
    if (request.method === "GET") {
      const workspace = readWorkspace(database, user.id);
      if (!workspace) {
        throw new HttpError(401, "Please log in to access your workspace.");
      }
      sendJson(response, 200, workspace);
      return;
    }
    const body = await readJson(request);
    // Revalidate after receiving a slow body: logout or expiry may have invalidated the session.
    const currentUser = findSessionUser(database, requestTokenHash(request));
    if (!currentUser) {
      throw new HttpError(401, "Your session expired. Please log in again.");
    }
    const snapshot = validateWorkspace(body);
    const workspace = saveWorkspace(database, currentUser.id, snapshot);
    sendJson(response, 200, workspace);
  }

  const server = http.createServer((request, response) => {
    setSecurityHeaders(response);
    // Keep an error listener after body-parser cleanup when a client aborts.
    request.on("error", () => {
      response.destroy();
    });
    handleRequest(request, response).catch((error) => {
      request.resume();
      if (!request.complete && !response.headersSent && !response.destroyed) {
        response.setHeader("Connection", "close");
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
      } else if (error instanceof WorkspaceConflictError) {
        sendJson(response, 409, { error: error.message });
      } else {
        console.error("Request failed:", error.code || error.name || "Error");
        sendJson(response, 500, {
          error: "An internal server error occurred.",
        });
      }
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(20000, (socket) => {
    socket.destroy();
  });
  return server;
}

function main() {
  let database;
  try {
    const port = getPort();
    database = openDatabase();
    const server = createTaskFlowServer(database, port);
    let stopping = false;

    function shutdown() {
      if (stopping) {
        return;
      }
      stopping = true;
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, 5000);
      timer.unref();
      server.close(() => {
        clearTimeout(timer);
        database.close();
        console.log("TaskFlow server stopped.");
      });
      server.closeIdleConnections();
    }

    server.once("error", (error) => {
      console.error("Server could not start:", error.code || error.name);
      database.close();
      process.exitCode = 1;
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    const host = process.env.HOST || "127.0.0.1";
    server.listen(port, host, () => {
      console.log(`Taskflow server :https://${host}:${host}`);
    })
  } catch (error) {
    if (database) {
      database.close();
    }
    console.error("Startup failed:", error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { createTaskFlowServer, getPort };
