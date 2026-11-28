const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

test('API HTTP: salud, rutas y autenticación', async (t) => {
  const server = app.listen(0, '127.0.0.1');

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  // Servicio disponible.
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: 'ok',
    service: 'vesta-api',
  });

  // Ruta inexistente.
  const missing = await fetch(`${base}/ruta-inexistente`);
  assert.equal(missing.status, 404);

  // Delete the account without authentication.
  const deleteAccount = await fetch(`${base}/api/account`, { method: 'DELETE' });
  assert.equal(deleteAccount.status, 401);

  // CORS: the web panel's origin is allowed; any other is not.
  const preflight = await fetch(`${base}/api/children/abc`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.vestasecurity.date',
      'Access-Control-Request-Method': 'DELETE',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.vestasecurity.date');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);

  const foreign = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);

  // Delete a profile without authentication.
  const deleteChild = await fetch(`${base}/api/children/abc`, { method: 'DELETE' });
  assert.equal(deleteChild.status, 401);

  // Create a profile without authentication.
  const create = await fetch(`${base}/api/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre: 'Prueba',
      edad: 10,
      color: 1,
    }),
  });
  assert.equal(create.status, 401);

  // Link a device without authentication.
  const link = await fetch(`${base}/api/devices/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode: 'ABCDEF1234' }),
  });
  assert.equal(link.status, 401);

  // JSON malformado.
  const malformed = await fetch(`${base}/api/children`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-de-prueba',
    },
    body: '{json-invalido',
  });
  assert.equal(malformed.status, 400);

  console.log('Pruebas HTTP completadas sin escrituras en Firestore.');
});
