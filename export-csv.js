'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./database');

const EXPORT_DIRECTORY = path.join(__dirname, 'exports');
const BYTE_ORDER_MARK = '\ufeff';

function escapeCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCsv(rows, columns) {
  const lines = [columns.map((column) => escapeCell(column[1])).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(row[column[0]])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function writeCsv(filename, rows, columns) {
  const target = path.join(EXPORT_DIRECTORY, filename);
  writeFileSync(target, BYTE_ORDER_MARK + toCsv(rows, columns), 'utf8');
  return rows.length;
}

const ACCOUNT_COLUMNS = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['version', 'Workspace version'],
  ['projects', 'Projects'],
  ['tasks', 'Tasks']
];

const PROJECT_COLUMNS = [
  ['ownerName', 'Owner name'],
  ['ownerEmail', 'Owner email'],
  ['name', 'Project'],
  ['description', 'Description'],
  ['tasks', 'Tasks']
];

const TASK_COLUMNS = [
  ['ownerName', 'Owner name'],
  ['ownerEmail', 'Owner email'],
  ['projectName', 'Project'],
  ['title', 'Task'],
  ['description', 'Description'],
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['dueDate', 'Due date'],
  ['assignee', 'Assignee']
];

const ACTIVITY_COLUMNS = [
  ['ownerName', 'Owner name'],
  ['ownerEmail', 'Owner email'],
  ['date', 'Date'],
  ['text', 'Activity']
];

let database;
try {
  database = openDatabase({ readOnly: true });

  const accounts = database.prepare(`
    SELECT name, email, version,
      (SELECT COUNT(*) FROM projects WHERE user_id = accounts.id) AS projects,
      (SELECT COUNT(*) FROM tasks WHERE user_id = accounts.id) AS tasks
    FROM accounts
    ORDER BY name
  `).all();

  const projects = database.prepare(`
    SELECT a.name AS ownerName, a.email AS ownerEmail, p.name, p.description,
      (SELECT COUNT(*) FROM tasks t WHERE t.user_id = p.user_id AND t.project_id = p.id) AS tasks
    FROM projects p
    JOIN accounts a ON a.id = p.user_id
    ORDER BY a.name, p.position
  `).all();

  const tasks = database.prepare(`
    SELECT a.name AS ownerName, a.email AS ownerEmail, p.name AS projectName,
      t.title, t.description, t.status, t.priority, t.due_date AS dueDate, t.assignee
    FROM tasks t
    JOIN accounts a ON a.id = t.user_id
    JOIN projects p ON p.user_id = t.user_id AND p.id = t.project_id
    ORDER BY a.name, p.position, t.position
  `).all();

  const activity = database.prepare(`
    SELECT a.name AS ownerName, a.email AS ownerEmail, ac.date, ac.text
    FROM activity ac
    JOIN accounts a ON a.id = ac.user_id
    ORDER BY ac.rowid DESC
  `).all();

  mkdirSync(EXPORT_DIRECTORY, { recursive: true });
  const written = [
    ['accounts.csv', writeCsv('accounts.csv', accounts, ACCOUNT_COLUMNS)],
    ['projects.csv', writeCsv('projects.csv', projects, PROJECT_COLUMNS)],
    ['tasks.csv', writeCsv('tasks.csv', tasks, TASK_COLUMNS)],
    ['activity.csv', writeCsv('activity.csv', activity, ACTIVITY_COLUMNS)]
  ];

  console.log('Export folder:', EXPORT_DIRECTORY);
  for (const [filename, count] of written) {
    console.log('  ' + filename + ': ' + count + ' row' + (count === 1 ? '' : 's'));
  }
} catch (error) {
  console.error('Export failed:', error.message);
  process.exitCode = 1;
} finally {
  if (database) {
    database.close();
  }
}