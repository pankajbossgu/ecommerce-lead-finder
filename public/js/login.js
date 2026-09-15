const form = document.querySelector('#login-form');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
const toggle = document.querySelector('#password-toggle');
const submit = document.querySelector('#login-submit');
const error = document.querySelector('#login-error');

function showError(message) { error.textContent = message; error.hidden = false; }
function clearError() { error.textContent = ''; error.hidden = true; }

toggle.addEventListener('click', () => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  toggle.textContent = visible ? 'Show' : 'Hide';
  toggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
  password.focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  clearError();
  if (!username.value.trim() || !password.value) {
    showError('Enter your username and password.');
    (!username.value.trim() ? username : password).focus();
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username.value, password: password.value }) });
    if (response.ok) return window.location.assign('/');
    const data = await response.json().catch(() => ({}));
    showError(response.status === 429 ? 'Too many login attempts. Please try again later.' : data.error === 'Invalid username or password.' ? data.error : 'Unable to sign in. Please try again.');
  } catch {
    showError('Unable to sign in. Please try again.');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});
