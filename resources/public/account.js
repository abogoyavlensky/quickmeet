// Shared by the sign-up and sign-in pages: post the form as JSON, go to the
// landing page on success, show the server's message otherwise. `messages`
// turns the API's short error codes into sentences; any other error is
// already a sentence.
function accountForm(url, messages) {
  const $ = id => document.getElementById(id);
  $('form').addEventListener('submit', async event => {
    event.preventDefault();
    $('submit').disabled = true;
    $('error').hidden = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('email').value, password: $('password').value }),
      });
      if (res.ok) { location.href = '/'; return; }
      let message = 'Something went wrong (' + res.status + ').';
      try { const { error } = await res.json(); message = messages[error] || error || message; } catch (e) { /* not JSON */ }
      throw new Error(message);
    } catch (e) {
      $('error').textContent = String(e.message || e);
      $('error').hidden = false;
      $('submit').disabled = false;
    }
  });
}
