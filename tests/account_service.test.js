const test = require('node:test');
const assert = require('node:assert/strict');

const { assertRecentLogin, RECENT_LOGIN_MS } = require('../src/services/account_service');

test('eliminar cuenta exige un inicio de sesión reciente', () => {
  const now = Date.now();
  const at = (ms) => ({ auth_time: Math.floor(ms / 1000) });

  assert.doesNotThrow(() => assertRecentLogin(at(now - 60_000), now));
  assert.throws(
    () => assertRecentLogin(at(now - RECENT_LOGIN_MS - 5_000), now),
    (error) => error.code === 'requires-recent-login' && error.status === 401
  );
  assert.throws(() => assertRecentLogin({}, now), { code: 'requires-recent-login' });
  assert.throws(() => assertRecentLogin(undefined, now), { code: 'requires-recent-login' });
});
