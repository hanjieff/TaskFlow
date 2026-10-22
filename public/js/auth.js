function showAuthError(cause) {
  const error = document.getElementById('auth-error');

  error.textContent = cause instanceof Error ? cause.message : 'Unable to reach the TaskFlow server.';
  error.hidden = false;
}

async function submitAuthForm(event) {
  event.preventDefault();

  const submit = document.getElementById('auth-submit');
  const error = document.getElementById('auth-error');
  const signup = document.body.dataset.page === 'signup';

  if (submit.disabled) {
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Please wait...';
  error.textContent = '';
  error.hidden = true;

  try {
    const fields = new FormData(event.currentTarget);
    const email = String(fields.get('email'));
    const password = String(fields.get('password'));

    if (signup) {
      await registerUser(String(fields.get('name')), email, password);
    } else {
      await loginUser(email, password);
    }

    window.location.assign('index.html');
  } catch (cause) {
    showAuthError(cause);
  } finally {
    submit.disabled = false;
    submit.textContent = signup ? 'Create account' : 'Sign in';
  }
}

async function initializeAuthPage() {
  const form = document.getElementById('auth-form');

  if (!form) {
    return;
  }

  form.addEventListener('submit', submitAuthForm);

  const password = form.elements.namedItem('password');
  const toggle = form.querySelector('[data-action="toggle-password"]');

  toggle.addEventListener('click', function () {
    const show = password.type === 'password';

    password.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(show));
  });

  let user;

  try {
    user = await getCurrentUser();
  } catch (cause) {
    showAuthError(cause);
    return;
  }

  if (user) {
    window.location.replace('index.html');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeAuthPage);
} else {
  initializeAuthPage();
}
