const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const {
  doc,
  collection,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
} = require('firebase/firestore');

test('Firestore aplica las reglas de privacidad y autorización', async () => {
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089') {
    throw new Error('Bloqueado: requiere Firestore Emulator en 127.0.0.1:8089.');
  }

  if (process.env.GCLOUD_PROJECT !== 'demo-vesta') {
    throw new Error('Bloqueado: el proyecto debe ser demo-vesta.');
  }

  const env = await initializeTestEnvironment({
    projectId: 'demo-vesta',
    firestore: {
      rules: fs.readFileSync('firestore.test.rules', 'utf8'),
    },
  });

  const suffix = crypto.randomUUID();
  const parent1 = `rules-parent-a-${suffix}`;
  const parent2 = `rules-parent-b-${suffix}`;
  const deviceUid = `rules-device-${suffix}`;
  const stranger = `rules-stranger-${suffix}`;
  const childId = `rules-child-${suffix}`;

  const versions = {
    termsVersion: '1.0.0-draft',
    privacyVersion: '1.0.0-draft',
  };

  const allPurposes = {
    location: true,
    device_status: true,
    usage_stats: true,
    app_filtering: true,
    domain_filtering: true,
    alerts: true,
  };

  const consent = {
    ...versions,
    status: 'active',
    acceptTerms: true,
    acknowledgePrivacy: true,
    guardianDeclaration: true,
    purposes: allPurposes,
    revocationPending: false,
  };

  const child = {
    status: 'vinculado',
    deviceUid,
    parentIds: [parent1, parent2],
    privacyAuthorization: {
      status: 'authorized',
      policy: 'all_guardians_must_authorize',
      ...versions,
      guardianCount: 2,
      purposes: allPurposes,
    },
  };

  const parentDb = env.authenticatedContext(parent1).firestore();
  const deviceDb = env.authenticatedContext(deviceUid).firestore();
  const strangerDb = env.authenticatedContext(stranger).firestore();

  const parent2Db = env.authenticatedContext(parent2).firestore();

  const childRef = (db) => doc(db, 'children', childId);
  const telemetryRef = (db) => doc(db, 'telemetria', childId);
  const alertRef = (db) => doc(db, 'children', childId, 'alerts', 'alert-1');
  const reportRef = (db) => doc(db, 'children', childId, 'usage_reports', 'report-1');
  const statusRef = (db) => doc(db, 'children', childId, 'device_status', 'current');
  const filterRef = (db) => doc(db, 'children', childId, 'filter_rules', 'rule-1');
  const urlFilterRef = (db) => doc(db, 'children', childId, 'filter_rules', 'rule-2');
  const consentRef = (db, uid) =>
    doc(db, 'users', uid, 'privacy_consents', 'current');

  try {
    // Prepare data only inside the test environment.
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      await setDoc(doc(db, 'children', childId), child);

      await setDoc(doc(db, 'users', parent1, 'privacy_consents', 'current'), consent);
      await setDoc(doc(db, 'users', parent2, 'privacy_consents', 'current'), consent);

      await setDoc(doc(db, 'telemetria', childId), {
        latitude: 40.0,
        longitude: -74.0,
      });

      await setDoc(doc(db, 'children', childId, 'alerts', 'alert-1'), {
        type: 'battery_low',
      });

      await setDoc(doc(db, 'children', childId, 'usage_reports', 'report-1'), {
        date: '2026-11-20',
      });

      await setDoc(doc(db, 'children', childId, 'device_status', 'current'), {
        battery: 80,
      });

      await setDoc(doc(db, 'children', childId, 'filter_rules', 'rule-1'), {
        category: 'app',
        type: 'block',
        value: 'example.app',
        isEnabled: true,
      });
      await setDoc(doc(db, 'children', childId, 'filter_rules', 'rule-2'), {
        category: 'url',
        type: 'block',
        value: 'example.com',
        isEnabled: true,
      });
    });

    // 1. Authorised guardians can read the matching data.
    await assertSucceeds(getDoc(childRef(parentDb)));
    await assertSucceeds(getDoc(telemetryRef(parentDb)));
    await assertSucceeds(getDoc(alertRef(parentDb)));
    await assertSucceeds(getDoc(reportRef(parentDb)));
    await assertSucceeds(getDoc(statusRef(parentDb)));
    await assertSucceeds(getDoc(filterRef(parentDb)));
    await assertSucceeds(getDoc(urlFilterRef(parentDb)));

    // 2. The linked device can access its authorised data.
    await assertSucceeds(getDoc(telemetryRef(deviceDb)));
    await assertSucceeds(getDoc(filterRef(deviceDb)));
    await assertSucceeds(getDoc(urlFilterRef(deviceDb)));

    await assertSucceeds(setDoc(
      doc(deviceDb, 'children', childId, 'alerts', 'device-alert'),
      { type: 'battery_low' },
    ));

    await assertSucceeds(setDoc(
      doc(deviceDb, 'children', childId, 'usage_reports', 'device-report'),
      { date: '2026-11-20' },
    ));

    await assertSucceeds(setDoc(
      doc(deviceDb, 'children', childId, 'device_status', 'device-status'),
      { battery: 75 },
    ));

    // 3. Un usuario ajeno no puede acceder.
    await assertFails(getDoc(childRef(strangerDb)));
    await assertFails(getDoc(telemetryRef(strangerDb)));
    await assertFails(getDoc(alertRef(strangerDb)));

    // 4. A user cannot modify the minor's profile.
    await assertFails(updateDoc(childRef(parentDb), {
      status: 'desvinculado',
    }));

    // 5. Clients cannot read or modify consents.
    await assertFails(getDoc(consentRef(parentDb, parent1)));
    await assertFails(updateDoc(consentRef(parentDb, parent1), {
      revocationPending: false,
    }));

    // 6. A pending revocation blocks access immediately.
    await env.withSecurityRulesDisabled(async (context) => {
      await updateDoc(
        doc(context.firestore(), 'users', parent2, 'privacy_consents', 'current'),
        { revocationPending: true },
      );
    });

    await assertFails(getDoc(telemetryRef(parentDb)));
    await assertFails(getDoc(telemetryRef(deviceDb)));
    await assertFails(getDoc(alertRef(parentDb)));

    // 7. Restore consent and withdraw the second guardian's location
    // authorisation.
    await env.withSecurityRulesDisabled(async (context) => {
      await updateDoc(
        doc(context.firestore(), 'users', parent2, 'privacy_consents', 'current'),
        {
          revocationPending: false,
          purposes: {
            ...allPurposes,
            location: false,
          },
        },
      );
    });

    await assertFails(getDoc(telemetryRef(parentDb)));
    await assertFails(getDoc(telemetryRef(deviceDb)));

    // Otras finalidades siguen autorizadas.
    await assertSucceeds(getDoc(alertRef(parentDb)));
    await assertSucceeds(getDoc(statusRef(parentDb)));

    // 8. Revocar app_filtering no bloquea domain_filtering.
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await updateDoc(
        doc(db, 'users', parent2, 'privacy_consents', 'current'),
        { 'purposes.app_filtering': false },
      );
      await updateDoc(doc(db, 'children', childId), {
        'privacyAuthorization.purposes.app_filtering': false,
      });
    });
    await assertFails(getDoc(filterRef(parentDb)));
    await assertFails(getDoc(filterRef(deviceDb)));
    await assertSucceeds(getDoc(urlFilterRef(parentDb)));
    await assertSucceeds(getDoc(urlFilterRef(deviceDb)));

    // 9. Revocar domain_filtering no bloquea app_filtering.
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await updateDoc(
        doc(db, 'users', parent2, 'privacy_consents', 'current'),
        {
          'purposes.app_filtering': true,
          'purposes.domain_filtering': false,
        },
      );
      await updateDoc(doc(db, 'children', childId), {
        'privacyAuthorization.purposes.app_filtering': true,
        'privacyAuthorization.purposes.domain_filtering': false,
      });
    });
    await assertSucceeds(getDoc(filterRef(parentDb)));
    await assertSucceeds(getDoc(filterRef(deviceDb)));
    await assertFails(getDoc(urlFilterRef(parentDb)));
    await assertFails(getDoc(urlFilterRef(deviceDb)));

    // 10. A different device cannot write telemetry.
    await assertFails(setDoc(
      doc(strangerDb, 'telemetria', childId),
      { latitude: 1, longitude: 1 },
    ));

    // 11. Clients cannot delete the profile.
    await assertFails(deleteDoc(childRef(parentDb)));

    // 12. An unlinked profile blocks the device.
    await env.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'children', childId), {
        status: 'esperando_vinculacion',
      });
    });

    await assertFails(getDoc(telemetryRef(deviceDb)));

    console.log('Reglas de Firestore verificadas correctamente.');
  } finally {
    await env.cleanup();
  }
});
