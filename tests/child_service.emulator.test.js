const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089') {
  throw new Error('Bloqueado: Firestore Emulator no está activo en el puerto esperado.');
}

const {
  db,
} = require('../src/config/firebase');

const {
  createChild,
  linkDevice,
  unlinkDevice,
} = require('../src/services/child_service');

test('crear, vincular y desvincular un perfil en Firestore Emulator', async () => {
  const parentUid = `test-parent-${crypto.randomUUID()}`;
  const deviceUid = `test-device-${crypto.randomUUID()}`;

  let childId;
  let firstCode;
  let secondCode;

  try {
    // 1. Crear perfil.
    const created = await createChild(parentUid, {
      nombre: 'Perfil de integración',
      edad: 12,
      color: 4294967295,
    });

    childId = created.childId;
    firstCode = created.pairingCode;

    assert.match(firstCode, /^[A-F0-9]{10}$/);

    let child = await db.collection('children').doc(childId).get();

    assert.equal(child.exists, true);
    assert.equal(child.data().status, 'esperando_vinculacion');
    assert.equal(child.data().parentIds[0], parentUid);

    // 2. Vincular dispositivo.
    const linked = await linkDevice(deviceUid, firstCode);

    assert.equal(linked.childId, childId);
    assert.equal(linked.status, 'vinculado');

    child = await db.collection('children').doc(childId).get();
    assert.equal(child.data().status, 'vinculado');
    assert.equal(child.data().deviceUid, deviceUid);

    let telemetry = await db.collection('telemetria').doc(childId).get();
    assert.equal(telemetry.data().status, 'pendiente');

    const device = await db.collection('devices').doc(deviceUid).get();
    assert.equal(device.data().status, 'vinculado');
    assert.equal(device.data().childId, childId);

    const consumedCode = await db.collection('pairing_codes').doc(firstCode).get();
    assert.equal(consumedCode.data().status, 'consumed');

    // 3. Desvincular dispositivo.
    const unlinked = await unlinkDevice(parentUid, childId);

    assert.equal(unlinked.success, true);
    secondCode = unlinked.pairingCode;
    assert.match(secondCode, /^[A-F0-9]{10}$/);
    assert.notEqual(secondCode, firstCode);

    child = await db.collection('children').doc(childId).get();
    assert.equal(child.data().status, 'esperando_vinculacion');
    assert.equal(child.data().deviceUid, null);
    assert.equal(child.data().pairingCode, secondCode);

    const oldDevice = await db.collection('devices').doc(deviceUid).get();
    assert.equal(oldDevice.data().status, 'desvinculado');
    assert.equal(oldDevice.data().childId, null);

    telemetry = await db.collection('telemetria').doc(childId).get();
    assert.equal(telemetry.data().status, 'desvinculado');

    // 4. Revincular el mismo dispositivo.
    const relinked = await linkDevice(deviceUid, secondCode);
    assert.equal(relinked.childId, childId);
    assert.equal(relinked.status, 'vinculado');

    telemetry = await db.collection('telemetria').doc(childId).get();
    assert.equal(telemetry.data().status, 'pendiente');

    child = await db.collection('children').doc(childId).get();
    assert.equal(child.data().status, 'vinculado');
    assert.equal(child.data().deviceUid, deviceUid);

  } finally {
    // Limpiar únicamente los documentos creados por esta prueba.
    if (childId) {
      await db.collection('children').doc(childId).delete();
      await db.collection('telemetria').doc(childId).delete();
    }

    if (firstCode) {
      await db.collection('pairing_codes').doc(firstCode).delete();
    }

    if (secondCode) {
      await db.collection('pairing_codes').doc(secondCode).delete();
    }

    await db.collection('devices').doc(deviceUid).delete();
  }
});
