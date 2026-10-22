function applyTheme(theme) {
  const dark = theme === 'dark';

  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';

  document.querySelectorAll('[data-action="toggle-theme"]').forEach(function (button) {
    button.textContent = dark ? 'Light mode' : 'Dark mode';
  });
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';

  applyTheme(theme);

  try {
    localStorage.setItem('taskflow.database.theme', theme);
  } catch {
    return;
  }
}

function initializeThemeButtons() {
  document.querySelectorAll('[data-action="toggle-theme"]').forEach(function (button) {
    button.onclick = toggleTheme;
  });

  applyTheme(document.documentElement.dataset.theme);
}

function initializeTheme() {
  let saved = null;

  try {
    saved = localStorage.getItem('taskflow.database.theme');
  } catch {
    saved = null;
  }

  const theme = saved === 'light' ? 'light' : 'dark';

  applyTheme(theme);
}

initializeTheme();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeThemeButtons);
} else {
  initializeThemeButtons();
}
