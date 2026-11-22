const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089') {
  throw new Error(
    'Bloqueado: esta prueba requiere Firestore Emulator en 127.0.0.1:8089.'
  );
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
  getConsent,
  revokeConsent,
} = require('../src/services/privacy_service');

test('aceptar, consultar y revocar consentimiento en Firestore Emulator', async () => {
  const uid = `privacy-test-${crypto.randomUUID()}`;
  const userRef = db.collection('users').doc(uid);
  const currentRef = userRef.collection('privacy_consents').doc('current');
  const eventsRef = userRef.collection('privacy_events');

  const input = {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    acceptTerms: true,
    acknowledgePrivacy: true,
    guardianDeclaration: true,
    minorParticipation: 'informed',
    purposes: Object.fromEntries(
      PURPOSES.map((purpose) => [purpose, true])
    ),
  };

  try {
    // 1. Aceptar consentimiento.
    const accepted = await acceptConsent(uid, input);
    assert.equal(accepted.success, true);
    assert.equal(accepted.status, 'active');

    // 2. Consultar consentimiento.
    let result = await getConsent(uid);
    assert.equal(result.exists, true);
    assert.equal(result.valid, true);
    assert.equal(result.consent.purposes.location, true);

    // 3. Revoke location only.
    const partial = await revokeConsent(uid, 'location');
    assert.equal(partial.success, true);

    result = await getConsent(uid);
    assert.equal(result.consent.status, 'partially_revoked');
    assert.equal(result.consent.purposes.location, false);
    assert.equal(result.consent.purposes.usage_stats, true);

    // 4. Revoke every remaining purpose.
    const full = await revokeConsent(uid, 'all');
    assert.equal(full.success, true);

    result = await getConsent(uid);
    assert.equal(result.valid, false);
    assert.equal(result.consent.status, 'revoked');

    for (const purpose of PURPOSES) {
      assert.equal(result.consent.purposes[purpose], false);
    }

    // 5. Comprobar historial.
    const events = await eventsRef.get();
    assert.equal(events.size, 3);

    const eventTypes = events.docs.map((doc) => doc.data().eventType);
    assert.ok(eventTypes.includes('consent_accepted'));
    assert.ok(eventTypes.includes('consent_purpose_revoked'));
    assert.ok(eventTypes.includes('consent_fully_revoked'));

    console.log('Integración de privacidad completada en Firestore Emulator.');
  } finally {
    // Only clean up this test UID's documents.
    const events = await eventsRef.get();
    const batch = db.batch();

    for (const doc of events.docs) {
      batch.delete(doc.ref);
    }

    batch.delete(currentRef);
    await batch.commit();
  }
});
