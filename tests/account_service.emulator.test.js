const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Bloqueado: estas pruebas solo se ejecutan contra Firestore Emulator.');
}

const { db } = require('../src/config/firebase');
const { createChild, linkDevice } = require('../src/services/child_service');
const { deleteAccount } = require('../src/services/account_service');

const freshToken = () => ({ auth_time: Math.floor(Date.now() / 1000) });

test('eliminar la cuenta borra los perfiles propios y conserva los compartidos', async () => {
  const uid = `del-parent-${crypto.randomUUID()}`;
  const otherUid = `del-other-${crypto.randomUUID()}`;
  const deviceUid = `del-device-${crypto.randomUUID()}`;
  const deletedUsers = [];
  const authClient = { deleteUser: async (id) => { deletedUsers.push(id); } };

  await db.collection('users').doc(uid).set({ uid, email: 'tutor@example.com' });
  await db.collection('users').doc(uid).collection('fcmTokens').doc('t1').set({ token: 'x' });
  await db.collection('users').doc(uid).collection('privacy_consents').doc('current').set({ status: 'active' });

  // Profile only this guardian has, linked to a device, with data.
  const own = await createChild(uid, { nombre: 'Propio', edad: 10, color: 1 });
  await linkDevice(deviceUid, own.pairingCode);
  const ownRef = db.collection('children').doc(own.childId);
  await ownRef.collection('alerts').doc('a1').set({ type: 'sos' });
  await db.collection('telemetria').doc(own.childId).collection('historial').doc('h1').set({ lat: 1 });

  // Profile shared with another guardian.
  const shared = await createChild(uid, { nombre: 'Compartido', edad: 12, color: 2 });
  const sharedRef = db.collection('children').doc(shared.childId);
  await sharedRef.update({ parentIds: [uid, otherUid] });

  const result = await deleteAccount(uid, freshToken(), { authClient });

  assert.deepEqual(result, { success: true, profilesDeleted: 1, profilesKept: 1 });
  assert.deepEqual(deletedUsers, [uid]);

  assert.equal((await ownRef.get()).exists, false);
  assert.equal((await ownRef.collection('alerts').get()).size, 0);
  assert.equal((await db.collection('telemetria').doc(own.childId).collection('historial').get()).size, 0);
  assert.equal((await db.collection('pairing_codes').where('childId', '==', own.childId).get()).size, 0);

  const device = (await db.collection('devices').doc(deviceUid).get()).data();
  assert.equal(device.status, 'desvinculado');
  assert.equal(device.childId, null);

  const sharedAfter = (await sharedRef.get()).data();
  assert.deepEqual(sharedAfter.parentIds, [otherUid]);

  assert.equal((await db.collection('users').doc(uid).get()).exists, false);
  assert.equal((await db.collection('users').doc(uid).collection('fcmTokens').get()).size, 0);
  assert.equal((await db.collection('users').doc(uid).collection('privacy_consents').get()).size, 0);

  const hash = crypto.createHash('sha256').update(uid).digest('hex');
  const record = await db.collection('account_deletions').where('subjectHash', '==', hash).get();
  assert.equal(record.size, 1);
  assert.equal(JSON.stringify(record.docs[0].data()).includes(uid), false);

  await db.recursiveDelete(sharedRef);
});

test('eliminar la cuenta con un inicio de sesión antiguo no borra nada', async () => {
  const uid = `del-stale-${crypto.randomUUID()}`;
  await db.collection('users').doc(uid).set({ uid });
  const authClient = { deleteUser: async () => assert.fail('no debe borrar el usuario') };

  await assert.rejects(
    deleteAccount(uid, { auth_time: Math.floor(Date.now() / 1000) - 3600 }, { authClient }),
    { code: 'requires-recent-login' }
  );
  assert.equal((await db.collection('users').doc(uid).get()).exists, true);
  await db.collection('users').doc(uid).delete();
});
