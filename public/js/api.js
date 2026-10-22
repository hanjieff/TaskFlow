async function apiRequest(path, method = 'GET', body) {
  const options = { method: method, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('Cannot reach the TaskFlow server. Start it with node server.js and try again.');
  }

  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'The server could not complete this request.');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function getCurrentUser() {
  const result = await apiRequest('/api/me');
  return result.user;
}

async function registerUser(name, email, password) {
  const result = await apiRequest('/api/signup', 'POST', {
    name: name,
    email: email,
    password: password
  });
  return result.user;
}

async function loginUser(email, password) {
  const result = await apiRequest('/api/login', 'POST', {
    email: email,
    password: password
  });
  return result.user;
}

async function logoutUser() {
  await apiRequest('/api/logout', 'POST', {});
}

async function loadWorkspace() {
  return apiRequest('/api/workspace');
}

async function saveWorkspace(data, message) {
  return apiRequest('/api/workspace', 'PUT', {
    version: data.version,
    projects: data.projects,
    tasks: data.tasks,
    message: message
  });
}

function localToday() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
