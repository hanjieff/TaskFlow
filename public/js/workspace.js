async function startWorkspace() {
  let user;
  let data;
  const surface = document.querySelector('.workspace');
  const loading = document.getElementById('toast');
  surface.inert = true;
  surface.setAttribute('aria-busy', 'true');
  loading.textContent = 'Connecting to your database workspace...';
  loading.hidden = false;

  try {
    user = await getCurrentUser();
    if (!user) {
      location.replace('login.html');
      return;
    }
    data = await loadWorkspace();
  } catch (error) {
    if (error.status === 401) {
      location.replace('login.html');
      return;
    }
    loading.textContent = error.message + ' Reload this page after fixing the connection.';
    loading.setAttribute('role', 'alert');
    return;
  }
  loading.hidden = true;
  surface.inert = false;
  surface.setAttribute('aria-busy', 'false');

  const page = document.body.dataset.page;
  const searchInput = document.getElementById('workspace-search');
  const projectFilter = document.getElementById('project-filter');
  const priorityFilter = document.getElementById('priority-filter');
  const projectDialog = document.getElementById('project-dialog');
  const taskDialog = document.getElementById('task-dialog');
  const projectForm = document.getElementById('project-form');
  const taskForm = document.getElementById('task-form');
  const statusLabels = { todo: 'To Do', progress: 'In Progress', done: 'Done' };
  let selectedProject = new URLSearchParams(location.search).get('project') || 'all';
  let selectedPriority = 'all';
  let editingProjectId = null;
  let editingTaskId = null;
  let toastTimer;
  let saving = false;

  document.getElementById('profile-name').textContent = user.name;
  document.getElementById('profile-avatar').textContent = user.name.charAt(0).toUpperCase();

  function showToast(message) {
    const toast = document.getElementById('toast');
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(function () {
      toast.hidden = true;
    }, 4500);
  }

  async function commit(nextData, message) {
    if (saving) {
      return false;
    }
    saving = true;
    const controls = Array.from(document.querySelectorAll('button, input, select, textarea'));
    const disabledStates = controls.map(function (control) { return control.disabled; });
    controls.forEach(function (control) { control.disabled = true; });
    surface.setAttribute('aria-busy', 'true');
    let succeeded = false;
    try {
      data = await saveWorkspace(nextData, message);
      succeeded = true;
    } catch (cause) {
      if (cause.status === 401) {
        location.replace('login.html');
      }
      showToast(cause.message);
      const error = projectDialog.open ? document.getElementById('project-error')
        : taskDialog.open ? document.getElementById('task-error') : null;
      if (error) {
        error.textContent = cause.message;
        error.hidden = false;
      }
    } finally {
      controls.forEach(function (control, index) { control.disabled = disabledStates[index]; });
      surface.setAttribute('aria-busy', 'false');
      saving = false;
    }
    if (succeeded) {
      render();
      showToast(message);
    }
    return succeeded;
  }

  function matchingProjects() {
    const query = searchInput.value.trim().toLowerCase();
    return data.projects.filter(function (project) {
      return (project.name + ' ' + project.description).toLowerCase().includes(query);
    });
  }

  function matchingTasks() {
    const query = searchInput.value.trim().toLowerCase();
    return data.tasks.filter(function (task) {
      const project = data.projects.find(function (item) {
        return item.id === task.projectId;
      });
      const text = [task.title, task.description, task.assignee, project ? project.name : ''].join(' ');
      return text.toLowerCase().includes(query)
        && (selectedProject === 'all' || task.projectId === selectedProject)
        && (selectedPriority === 'all' || task.priority === selectedPriority);
    });
  }

  function projectOptions(select, includeAll) {
    select.replaceChildren();
    if (includeAll) {
      select.add(new Option('All projects', 'all'));
    }
    data.projects.forEach(function (project) {
      select.add(new Option(project.name, project.id));
    });
  }

  function createProjectCard(project) {
    const card = document.getElementById('project-template').content.firstElementChild.cloneNode(true);
    const tasks = data.tasks.filter(function (task) {
      return task.projectId === project.id;
    });
    const completed = tasks.filter(function (task) {
      return task.status === 'done';
    }).length;
    card.querySelector('[data-field="emblem"]').textContent = project.name.charAt(0).toUpperCase();
    card.querySelector('[data-field="name"]').textContent = project.name;
    card.querySelector('[data-field="description"]').textContent = project.description || 'A fresh space for your ideas.';
    card.querySelector('[data-field="tasks"]').textContent = tasks.length + (tasks.length === 1 ? ' task' : ' tasks');
    card.querySelector('[data-field="completed"]').textContent = completed + ' completed';
    const progress = card.querySelector('[data-field="progress"]');
    progress.max = tasks.length || 1;
    progress.value = completed;
    progress.setAttribute('aria-label', 'Completion for ' + project.name);
    card.querySelector('[data-action="open-board"]').addEventListener('click', function () {
      location.assign('tasks.html?project=' + encodeURIComponent(project.id));
    });
    const editButton = card.querySelector('[data-action="edit-project"]');
    editButton.setAttribute('aria-label', 'Edit project ' + project.name);
    editButton.addEventListener('click', function () {
      openProjectEditor(project);
    });
    const deleteButton = card.querySelector('[data-action="delete-project"]');
    deleteButton.setAttribute('aria-label', 'Delete project ' + project.name);
    deleteButton.addEventListener('click', function () {
      deleteProject(project);
    });
    return card;
  }

  function createTaskCard(task) {
    const card = document.getElementById('task-template').content.firstElementChild.cloneNode(true);
    const project = data.projects.find(function (item) {
      return item.id === task.projectId;
    });
    const priority = card.querySelector('[data-field="priority"]');
    priority.className = 'priority ' + task.priority;
    priority.textContent = task.priority;
    card.querySelector('[data-field="project"]').textContent = project ? project.name : '';
    card.querySelector('[data-field="title"]').textContent = task.title;
    const description = card.querySelector('[data-field="description"]');
    description.textContent = task.description;
    description.hidden = !task.description;
    card.querySelector('[data-field="assignee"]').textContent = task.assignee || 'Unassigned';
    const dueDate = card.querySelector('[data-field="due-date"]');
    const overdue = task.dueDate && task.dueDate < localToday() && task.status !== 'done';
    const dateLabel = task.dueDate
      ? new Date(task.dueDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : 'No due date';
    dueDate.textContent = (overdue ? 'Overdue · ' : '') + dateLabel;
    dueDate.classList.toggle('overdue', Boolean(overdue));
    const status = card.querySelector('[data-field="status"]');
    status.value = task.status;
    status.setAttribute('aria-label', 'Status for ' + task.title);
    status.addEventListener('change', function () {
      changeStatus(task, status.value);
    });
    const editButton = card.querySelector('[data-action="edit-task"]');
    editButton.setAttribute('aria-label', 'Edit task ' + task.title);
    editButton.addEventListener('click', function () {
      openTaskEditor(task);
    });
    const deleteButton = card.querySelector('[data-action="delete-task"]');
    deleteButton.setAttribute('aria-label', 'Delete task ' + task.title);
    deleteButton.addEventListener('click', function () {
      deleteTask(task);
    });
    card.addEventListener('dragstart', function (event) {
      event.dataTransfer.setData('text/plain', task.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    return card;
  }

  function renderProjects() {
    const list = document.getElementById('projects-list');
    const projects = matchingProjects();
    const visible = page === 'overview' ? projects.slice(0, 3) : projects;
    list.replaceChildren();
    visible.forEach(function (project) {
      list.append(createProjectCard(project));
    });
    document.getElementById('projects-empty').hidden = projects.length > 0;
  }

  function renderTasks() {
    projectOptions(projectFilter, true);
    if (!data.projects.some(function (project) { return project.id === selectedProject; })) {
      selectedProject = 'all';
    }
    projectFilter.value = selectedProject;
    priorityFilter.value = selectedPriority;
    const tasks = matchingTasks();
    document.getElementById('task-count').textContent = 'Showing ' + tasks.length + ' of ' + data.tasks.length + ' tasks';
    document.querySelectorAll('.board-column').forEach(function (column) {
      const columnTasks = tasks.filter(function (task) {
        return task.status === column.dataset.status;
      });
      column.querySelector('[data-field="count"]').textContent = columnTasks.length;
      column.querySelector('[data-field="empty"]').hidden = columnTasks.length > 0;
      const cards = column.querySelector('[data-field="cards"]');
      cards.replaceChildren();
      columnTasks.forEach(function (task) {
        cards.append(createTaskCard(task));
      });
    });
    const empty = document.getElementById('tasks-empty');
    empty.hidden = tasks.length > 0;
    empty.textContent = data.tasks.length ? 'No tasks match these filters.' : 'No tasks yet. Add your first next step.';
  }

  function renderDashboard() {
    const completed = data.tasks.filter(function (task) {
      return task.status === 'done';
    }).length;
    const progress = data.tasks.length ? Math.round(completed / data.tasks.length * 100) : 0;
    document.getElementById('welcome-name').textContent = 'WELCOME BACK, ' + user.name.split(' ')[0].toUpperCase();
    document.getElementById('stat-projects').textContent = data.projects.length;
    document.getElementById('stat-tasks').textContent = data.tasks.length;
    document.getElementById('stat-completed').textContent = completed;
    document.getElementById('stat-pending').textContent = data.tasks.length - completed;
    document.getElementById('progress-value').textContent = progress + '%';
    const ring = document.getElementById('progress-ring');
    ring.style.background = 'conic-gradient(var(--primary) ' + progress + '%, var(--surface-2) 0)';
    ring.setAttribute('aria-label', progress + '% of tasks completed');
    document.getElementById('activity-section').hidden = data.activity.length === 0;
    const activityList = document.getElementById('activity-list');
    activityList.replaceChildren();
    data.activity.slice(0, 4).forEach(function (item) {
      const row = document.getElementById('activity-template').content.firstElementChild.cloneNode(true);
      row.querySelector('[data-field="text"]').textContent = item.text;
      const date = row.querySelector('[data-field="date"]');
      date.dateTime = item.date;
      date.textContent = new Date(item.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      activityList.append(row);
    });
  }

  function render() {
    const hasProjects = data.projects.length > 0;
    document.getElementById('workspace-empty').hidden = hasProjects;
    document.getElementById('work-sections').hidden = !hasProjects;
    document.querySelectorAll('[data-action="new-task"]').forEach(function (button) {
      button.disabled = !hasProjects;
    });
    if (page === 'overview') {
      renderDashboard();
    }
    if (page !== 'tasks') {
      renderProjects();
    }
    if (page !== 'projects') {
      renderTasks();
    }
  }

  function openProjectEditor(project) {
    editingProjectId = project ? project.id : null;
    projectForm.reset();
    projectForm.elements.namedItem('name').setCustomValidity('');
    document.getElementById('project-error').hidden = true;
    document.getElementById('project-dialog-title').textContent = project ? 'Edit project' : 'New project';
    projectForm.elements.namedItem('name').value = project ? project.name : '';
    projectForm.elements.namedItem('description').value = project ? project.description : '';
    projectDialog.showModal();
  }

  function openTaskEditor(task) {
    if (!data.projects.length) {
      showToast('Create a project before adding a task.');
      return;
    }
    editingTaskId = task ? task.id : null;
    taskForm.reset();
    taskForm.elements.namedItem('title').setCustomValidity('');
    document.getElementById('task-error').hidden = true;
    document.getElementById('task-dialog-title').textContent = task ? 'Edit task' : 'New task';
    projectOptions(taskForm.elements.namedItem('projectId'), false);
    taskForm.elements.namedItem('title').value = task ? task.title : '';
    taskForm.elements.namedItem('description').value = task ? task.description : '';
    taskForm.elements.namedItem('projectId').value = task ? task.projectId
      : selectedProject !== 'all' ? selectedProject : data.projects[0].id;
    taskForm.elements.namedItem('status').value = task ? task.status : 'todo';
    taskForm.elements.namedItem('priority').value = task ? task.priority : 'medium';
    taskForm.elements.namedItem('dueDate').value = task ? task.dueDate : '';
    taskForm.elements.namedItem('assignee').value = task ? task.assignee : user.name;
    taskDialog.showModal();
  }

  async function changeStatus(task, status) {
    if (task.status === status) {
      return;
    }
    const tasks = data.tasks.map(function (item) {
      return item.id === task.id ? { ...item, status: status } : item;
    });
    if (!await commit({ ...data, tasks: tasks }, 'Moved “' + task.title + '” to ' + statusLabels[status] + '.')) {
      render();
    }
  }

  async function deleteProject(project) {
    if (!confirm('Delete “' + project.name + '” and all its tasks? This cannot be undone.')) {
      return;
    }
    const projects = data.projects.filter(function (item) {
      return item.id !== project.id;
    });
    const tasks = data.tasks.filter(function (task) {
      return task.projectId !== project.id;
    });
    await commit({ ...data, projects: projects, tasks: tasks }, 'Deleted project “' + project.name + '”.');
  }

  async function deleteTask(task) {
    if (!confirm('Delete “' + task.title + '”?')) {
      return;
    }
    const tasks = data.tasks.filter(function (item) {
      return item.id !== task.id;
    });
    await commit({ ...data, tasks: tasks }, 'Deleted task “' + task.title + '”.');
  }

  async function loadExample() {
    if (data.projects.length) {
      return;
    }
    const projectId = crypto.randomUUID();
    const project = { id: projectId, name: 'Website launch', description: 'A small beginning for your next big thing.' };
    const tasks = [
      { id: crypto.randomUUID(), projectId: projectId, title: 'Sketch the landing page', description: 'Give the first impression a little personality.', status: 'todo', priority: 'high', dueDate: localToday(), assignee: user.name },
      { id: crypto.randomUUID(), projectId: projectId, title: 'Build the first prototype', description: 'Turn the best ideas into something you can click.', status: 'progress', priority: 'medium', dueDate: '', assignee: user.name },
      { id: crypto.randomUUID(), projectId: projectId, title: 'Collect visual inspiration', description: 'Find a direction that feels clear and confident.', status: 'done', priority: 'low', dueDate: '', assignee: '' }
    ];
    await commit({ ...data, projects: [project], tasks: tasks }, 'Loaded the editable example workspace.');
  }

  projectForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    const nameInput = projectForm.elements.namedItem('name');
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.setCustomValidity('Please enter a project name.');
      nameInput.reportValidity();
      return;
    }
    const project = {
      id: editingProjectId || crypto.randomUUID(),
      name: name,
      description: projectForm.elements.namedItem('description').value.trim()
    };
    const projects = editingProjectId ? data.projects.map(function (item) {
      return item.id === project.id ? project : item;
    }) : [...data.projects, project];
    const message = (editingProjectId ? 'Updated' : 'Created') + ' project “' + project.name + '”.';
    if (await commit({ ...data, projects: projects }, message)) {
      projectDialog.close();
    }
  });

  taskForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    const titleInput = taskForm.elements.namedItem('title');
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.setCustomValidity('Please enter a task title.');
      titleInput.reportValidity();
      return;
    }
    const projectId = taskForm.elements.namedItem('projectId').value;
    if (!data.projects.some(function (project) { return project.id === projectId; })) {
      showToast('Choose an existing project.');
      return;
    }
    const task = {
      id: editingTaskId || crypto.randomUUID(),
      projectId: projectId,
      title: title,
      description: taskForm.elements.namedItem('description').value.trim(),
      status: taskForm.elements.namedItem('status').value,
      priority: taskForm.elements.namedItem('priority').value,
      dueDate: taskForm.elements.namedItem('dueDate').value,
      assignee: taskForm.elements.namedItem('assignee').value.trim()
    };
    const tasks = editingTaskId ? data.tasks.map(function (item) {
      return item.id === task.id ? task : item;
    }) : [...data.tasks, task];
    const message = (editingTaskId ? 'Updated' : 'Created') + ' task “' + task.title + '”.';
    if (await commit({ ...data, tasks: tasks }, message)) {
      taskDialog.close();
    }
  });

  projectForm.elements.namedItem('name').addEventListener('input', function (event) {
    event.target.setCustomValidity('');
  });
  taskForm.elements.namedItem('title').addEventListener('input', function (event) {
    event.target.setCustomValidity('');
  });
  document.querySelectorAll('[data-action="new-project"]').forEach(function (button) {
    button.addEventListener('click', function () { openProjectEditor(null); });
  });
  document.querySelectorAll('[data-action="new-task"]').forEach(function (button) {
    button.addEventListener('click', function () { openTaskEditor(null); });
  });
  document.querySelectorAll('[data-action="close-dialog"]').forEach(function (button) {
    button.addEventListener('click', function () { button.closest('dialog').close(); });
  });
  [projectDialog, taskDialog].forEach(function (dialog) {
    dialog.addEventListener('cancel', function (event) {
      if (saving) {
        event.preventDefault();
      }
    });
  });
  document.querySelector('[data-action="load-example"]').addEventListener('click', loadExample);
  document.querySelector('[data-action="sign-out"]').addEventListener('click', async function () {
    try {
      await logoutUser();
      location.replace('login.html');
    } catch (cause) {
      showToast(cause.message);
    }
  });
  document.querySelector('.skip-link').addEventListener('click', function (event) {
    event.preventDefault();
    document.getElementById('main-content').focus();
  });
  searchInput.addEventListener('input', render);
  if (projectFilter) {
    projectFilter.addEventListener('change', function () {
      selectedProject = projectFilter.value;
      renderTasks();
    });
    priorityFilter.addEventListener('change', function () {
      selectedPriority = priorityFilter.value;
      renderTasks();
    });
    document.querySelector('[data-action="clear-filters"]').addEventListener('click', function () {
      searchInput.value = '';
      selectedProject = 'all';
      selectedPriority = 'all';
      render();
    });
  }
  document.querySelectorAll('.board-column').forEach(function (column) {
    column.addEventListener('dragover', function (event) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    column.addEventListener('drop', function (event) {
      event.preventDefault();
      const id = event.dataTransfer.getData('text/plain');
      const task = data.tasks.find(function (item) {
        return item.id === id;
      });
      if (task) {
        changeStatus(task, column.dataset.status);
      }
    });
  });
  render();
}

startWorkspace();
