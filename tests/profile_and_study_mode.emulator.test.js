const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089') {
  throw new Error('Bloqueado: requiere Firestore Emulator en 127.0.0.1:8089.');
}
if ((process.env.GCLOUD_PROJECT || '') !== 'demo-vesta') {
  throw new Error('Bloqueado: el proyecto debe ser demo-vesta.');
}

const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  Timestamp,
} = require('firebase/firestore');

const { db } = require('../src/config/firebase');
const {
  createChild,
  updateChild,
  regeneratePairingCode,
  linkDevice,
  unlinkDevice,
} = require('../src/services/child_service');
const { getDevicePrivacyStatus } = require('../src/services/privacy_service');

test('editar perfil, regenerar código y detectar desvinculación', async () => {
  const parentUid = `edit-parent-${crypto.randomUUID()}`;
  const strangerUid = `edit-stranger-${crypto.randomUUID()}`;
  const deviceUid = `edit-device-${crypto.randomUUID()}`;
  const touched = [];

  try {
    const { childId, pairingCode } = await createChild(parentUid, {
      nombre: 'Original',
      edad: 9,
      color: 1,
    });
    touched.push(['children', childId], ['telemetria', childId]);

    // Partial edit by the guardian.
    const updated = await updateChild(parentUid, childId, {
      nombre: '  Renombrado ',
      color: 42,
    });
    assert.equal(updated.nombre, 'Renombrado');

    let child = (await db.collection('children').doc(childId).get()).data();
    assert.equal(child.nombre, 'Renombrado');
    assert.equal(child.edad, 9);
    assert.equal(child.color, 42);
    assert.equal(child.status, 'esperando_vinculacion');

    // Un tercero no puede editar.
    await assert.rejects(
      updateChild(strangerUid, childId, { nombre: 'X' }),
      (error) => error.status === 403
    );

    // Protected fields cannot be touched.
    await assert.rejects(
      updateChild(parentUid, childId, { status: 'vinculado' }),
      (error) => error.status === 400
    );

    // New code: the previous one stops working.
    const regenerated = await regeneratePairingCode(parentUid, childId);
    assert.notEqual(regenerated.pairingCode, pairingCode);
    touched.push(
      ['pairing_codes', pairingCode],
      ['pairing_codes', regenerated.pairingCode]
    );

    const oldCode = await db.collection('pairing_codes').doc(pairingCode).get();
    assert.equal(oldCode.data().status, 'revoked');

    await assert.rejects(
      linkDevice(deviceUid, pairingCode),
      (error) => error.status === 404
    );

    // Un dispositivo nunca vinculado recibe "no vinculado" (no un error).
    let status = await getDevicePrivacyStatus(deviceUid);
    assert.equal(status.linked, false);
    assert.equal(status.reason, 'device_not_found');

    // Link with the new code.
    await linkDevice(deviceUid, regenerated.pairingCode);
    touched.push(['devices', deviceUid]);

    status = await getDevicePrivacyStatus(deviceUid);
    assert.equal(status.linked, true);
    assert.equal(status.childId, childId);

    // With a linked device the code cannot be regenerated.
    await assert.rejects(
      regeneratePairingCode(parentUid, childId),
      (error) => error.status === 409
    );

    // After unlinking, the Tracker receives an explicit state.
    const unlinked = await unlinkDevice(parentUid, childId);
    touched.push(['pairing_codes', unlinked.pairingCode]);

    status = await getDevicePrivacyStatus(deviceUid);
    assert.equal(status.linked, false);
    assert.equal(status.reason, 'unlinked_by_guardian');
    assert.ok(Object.values(status.purposes).every((value) => value === false));

    child = (await db.collection('children').doc(childId).get()).data();
    assert.equal(child.nombre, 'Renombrado');
  } finally {
    const batch = db.batch();
    for (const [collection, id] of touched) {
      batch.delete(db.collection(collection).doc(id));
    }
    await batch.commit();
  }
});

test('reglas del modo estudio', async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-vesta',
    firestore: {
      rules: fs.readFileSync('firestore.test.rules', 'utf8'),
    },
  });

  const suffix = crypto.randomUUID();
  const parent = `study-parent-${suffix}`;
  const deviceUid = `study-device-${suffix}`;
  const stranger = `study-stranger-${suffix}`;
  const childId = `study-child-${suffix}`;

  const versions = { termsVersion: '1.0.0', privacyVersion: '1.0.0' };
  const purposes = {
    location: true,
    device_status: true,
    usage_stats: true,
    app_filtering: true,
    domain_filtering: true,
    alerts: true,
  };

  const parentDb = env.authenticatedContext(parent).firestore();
  const deviceDb = env.authenticatedContext(deviceUid).firestore();
  const strangerDb = env.authenticatedContext(stranger).firestore();
  const studyRef = (firestore) =>
    doc(firestore, 'children', childId, 'controls', 'study_mode');

  const validConfig = (uid) => ({
    active: true,
    endsAt: Timestamp.fromMillis(Date.now() + 3600 * 1000),
    allowedApps: ['com.example.calculator'],
    schedules: [{ days: [1, 2, 3, 4, 5], start: '16:00', end: '18:00' }],
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });

  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const admin = context.firestore();
      await setDoc(doc(admin, 'children', childId), {
        status: 'vinculado',
        deviceUid,
        parentIds: [parent],
        privacyAuthorization: { ...versions, status: 'authorized', purposes },
      });
      await setDoc(doc(admin, 'users', parent, 'privacy_consents', 'current'), {
        ...versions,
        status: 'active',
        acceptTerms: true,
        acknowledgePrivacy: true,
        guardianDeclaration: true,
        revocationPending: false,
        purposes,
      });
    });

    // The guardian configures; the device reads; a third party can do nothing.
    await assertSucceeds(setDoc(studyRef(parentDb), validConfig(parent)));
    await assertSucceeds(getDoc(studyRef(deviceDb)));
    await assertFails(getDoc(studyRef(strangerDb)));
    await assertFails(setDoc(studyRef(deviceDb), validConfig(deviceUid)));

    // Field validation.
    await assertFails(setDoc(studyRef(parentDb), {
      ...validConfig(parent),
      extra: true,
    }));
    await assertFails(setDoc(studyRef(parentDb), {
      ...validConfig(parent),
      schedules: [{ days: [1], start: '25:00', end: '18:00' }],
    }));
    await assertFails(setDoc(studyRef(parentDb), {
      ...validConfig(parent),
      updatedBy: 'otro',
    }));

    // Other control documents are not allowed.
    await assertFails(setDoc(
      doc(parentDb, 'children', childId, 'controls', 'otro'),
      validConfig(parent)
    ));

    // Without app filtering consent, nobody gets access.
    await env.withSecurityRulesDisabled(async (context) => {
      const admin = context.firestore();
      await setDoc(doc(admin, 'users', parent, 'privacy_consents', 'current'), {
        ...versions,
        status: 'active',
        acceptTerms: true,
        acknowledgePrivacy: true,
        guardianDeclaration: true,
        revocationPending: false,
        purposes: { ...purposes, app_filtering: false },
      });
    });
    await assertFails(getDoc(studyRef(parentDb)));
    await assertFails(getDoc(studyRef(deviceDb)));
  } finally {
    await env.cleanup();
  }
});
