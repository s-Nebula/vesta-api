const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089') {
  throw new Error('Bloqueado: requiere Firestore Emulator en 127.0.0.1:8089.');
}
if ((process.env.GCLOUD_PROJECT || '') !== 'demo-vesta') {
  throw new Error('Bloqueado: el proyecto debe ser demo-vesta.');
}

const { db } = require('../src/config/firebase');
const {
  TERMS_VERSION,
  PRIVACY_VERSION,
  PURPOSES,
  acceptConsent,
  revokeConsent,
  getDevicePrivacyStatus,
  recalculateChildPrivacyAuthorization,
} = require('../src/services/privacy_service');

test('autorización unánime de tutores por finalidad', async () => {
  const suffix = crypto.randomUUID();
  const parent1 = `privacy-parent-a-${suffix}`;
  const parent2 = `privacy-parent-b-${suffix}`;
  const deviceUid = `privacy-device-${suffix}`;
  const childId = `privacy-child-${suffix}`;

  const childRef = db.collection('children').doc(childId);
  const deviceRef = db.collection('devices').doc(deviceUid);

  const parentRefs = [parent1, parent2].map((uid) =>
    db.collection('users').doc(uid)
  );

  const consentInput = {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    acceptTerms: true,
    acknowledgePrivacy: true,
    guardianDeclaration: true,
    minorParticipation: 'informed',
    purposes: Object.fromEntries(PURPOSES.map((p) => [p, true])),
  };

  async function cleanParent(uid) {
    const ref = db.collection('users').doc(uid);
    const [consents, events] = await Promise.all([
      ref.collection('privacy_consents').get(),
      ref.collection('privacy_events').get(),
    ]);
    const batch = db.batch();
    for (const doc of consents.docs) batch.delete(doc.ref);
    for (const doc of events.docs) batch.delete(doc.ref);
    batch.delete(ref);
    await batch.commit();
  }

  try {
    await childRef.set({
      status: 'vinculado',
      deviceUid,
      parentIds: [parent1, parent2],
    });

    await deviceRef.set({
      status: 'vinculado',
      deviceUid,
      childId,
    });

    // 1. If both guardians' consent is missing, everything is denied.
    await acceptConsent(parent1, consentInput);
    let result = await getDevicePrivacyStatus(deviceUid);

    assert.equal(result.status, 'blocked');
    for (const purpose of PURPOSES) {
      assert.equal(result.purposes[purpose], false);
    }

    // 2. When both accept, every purpose is enabled.
    await acceptConsent(parent2, consentInput);
    result = await getDevicePrivacyStatus(deviceUid);

    assert.equal(result.status, 'authorized');
    for (const purpose of PURPOSES) {
      assert.equal(result.purposes[purpose], true);
    }

    // Check the temporary block during a revocation.
    const consentRef = db.collection('users').doc(parent2)
      .collection('privacy_consents').doc('current');
    await consentRef.update({ revocationPending: true, revocationId: 'test-pending' });
    result = await getDevicePrivacyStatus(deviceUid);
    assert.equal(result.status, 'blocked');
    for (const purpose of PURPOSES) assert.equal(result.purposes[purpose], false);
    await recalculateChildPrivacyAuthorization(childId);
    let child = await childRef.get();
    for (const purpose of PURPOSES) {
      assert.equal(child.data().privacyAuthorization.purposes[purpose], false);
    }
    await consentRef.update({ revocationPending: false, revocationId: null });
    await recalculateChildPrivacyAuthorization(childId);

    // 3. If a guardian revokes location, only that purpose is turned off.
    await revokeConsent(parent2, 'location');
    result = await getDevicePrivacyStatus(deviceUid);

    assert.equal(result.purposes.location, false);
    for (const purpose of PURPOSES.filter((p) => p !== 'location')) {
      assert.equal(result.purposes[purpose], true);
    }

    console.log('Autorización unánime verificada en Firestore Emulator.');
  } finally {
    await Promise.all([
      cleanParent(parent1),
      cleanParent(parent2),
    ]);
    const batch = db.batch();
    batch.delete(childRef);
    batch.delete(deviceRef);
    await batch.commit();
  }
});
