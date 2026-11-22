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
  updateDoc,
  serverTimestamp,
  Timestamp,
} = require('firebase/firestore');

const { db, admin } = require('../src/config/firebase');
const { createChild, linkDevice } = require('../src/services/child_service');
const { createAlertDispatcher } = require('../src/services/alert_dispatcher');

const FieldValue = admin.firestore.FieldValue;
const versions = { termsVersion: '1.0.0', privacyVersion: '1.0.0' };
const allPurposes = {
  location: true,
  device_status: true,
  usage_stats: true,
  app_filtering: true,
  domain_filtering: true,
  alerts: true,
};
const silent = { info() {}, error() {} };

test('los códigos de vinculación caducan a las 24 h', async () => {
  const parent = `ttl-parent-${crypto.randomUUID()}`;
  const device = `ttl-device-${crypto.randomUUID()}`;
  const { childId, pairingCode } = await createChild(parent, {
    nombre: 'TTL', edad: 8, color: 1,
  });

  try {
    const child = (await db.collection('children').doc(childId).get()).data();
    const ttl = child.pairingCodeExpiresAt.toMillis() - Date.now();
    assert.ok(ttl > 23 * 3600 * 1000 && ttl <= 24 * 3600 * 1000);

    await db.collection('pairing_codes').doc(pairingCode).update({
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000),
    });

    await assert.rejects(
      linkDevice(device, pairingCode),
      (error) => error.status === 410
    );

    // Old codes without expiresAt: createdAt + 24 h is used.
    await db.collection('pairing_codes').doc(pairingCode).update({
      expiresAt: FieldValue.delete(),
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600 * 1000),
    });
    await assert.rejects(
      linkDevice(device, pairingCode),
      (error) => error.status === 410
    );
  } finally {
    await db.collection('children').doc(childId).delete();
    await db.collection('pairing_codes').doc(pairingCode).delete();
  }
});

test('reglas de zonas, peticiones, límites y protección web', async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-vesta',
    firestore: { rules: fs.readFileSync('firestore.test.rules', 'utf8') },
  });

  const suffix = crypto.randomUUID();
  const parent = `fam-parent-${suffix}`;
  const deviceUid = `fam-device-${suffix}`;
  const stranger = `fam-stranger-${suffix}`;
  const childId = `fam-child-${suffix}`;

  const parentDb = env.authenticatedContext(parent).firestore();
  const deviceDb = env.authenticatedContext(deviceUid).firestore();
  const strangerDb = env.authenticatedContext(stranger).firestore();

  const stamp = (uid) => ({ updatedAt: serverTimestamp(), updatedBy: uid });

  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'children', childId), {
        status: 'vinculado',
        deviceUid,
        parentIds: [parent],
        privacyAuthorization: { ...versions, status: 'authorized', purposes: allPurposes },
      });
      await setDoc(doc(adminDb, 'users', parent, 'privacy_consents', 'current'), {
        ...versions,
        status: 'active',
        acceptTerms: true,
        acknowledgePrivacy: true,
        guardianDeclaration: true,
        revocationPending: false,
        purposes: allPurposes,
      });
      await setDoc(doc(adminDb, 'children', childId, 'weekly_summaries', 'w1'), {
        weekId: 'w1',
      });
    });

    // Zonas.
    const zone = (uid) => ({
      name: 'Casa', lat: 11.24, lng: -74.2, radius: 150,
      notifyEnter: true, notifyExit: true, ...stamp(uid),
    });
    const zoneRef = (fs_) => doc(fs_, 'children', childId, 'zones', 'z1');
    await assertSucceeds(setDoc(zoneRef(parentDb), zone(parent)));
    await assertSucceeds(getDoc(zoneRef(deviceDb)));
    await assertFails(getDoc(zoneRef(strangerDb)));
    await assertFails(setDoc(zoneRef(deviceDb), zone(deviceUid)));
    await assertFails(setDoc(zoneRef(parentDb), { ...zone(parent), radius: 10 }));
    await assertFails(setDoc(zoneRef(parentDb), { ...zone(parent), name: '' }));

    // Daily limits and web protection.
    const limitsRef = (fs_) => doc(fs_, 'children', childId, 'controls', 'app_limits');
    await assertSucceeds(setDoc(limitsRef(parentDb), {
      limits: { 'com.game': 60 }, ...stamp(parent),
    }));
    await assertSucceeds(getDoc(limitsRef(deviceDb)));
    await assertFails(setDoc(limitsRef(parentDb), {
      limits: 'no', ...stamp(parent),
    }));

    const webRef = (fs_) => doc(fs_, 'children', childId, 'controls', 'web_protection');
    await assertSucceeds(setDoc(webRef(parentDb), {
      safeSearch: true, blockDoh: true, ...stamp(parent),
    }));
    await assertSucceeds(getDoc(webRef(deviceDb)));
    await assertFails(setDoc(webRef(deviceDb), {
      safeSearch: false, blockDoh: false, ...stamp(deviceUid),
    }));

    // Requests: the device creates them, the guardian resolves them once.
    const reqRef = (fs_) => doc(fs_, 'children', childId, 'requests', 'r1');
    const newRequest = {
      type: 'extra_time',
      packageName: 'com.game',
      appName: 'Juego',
      minutes: 30,
      message: 'Termino la partida',
      status: 'pending',
      createdAt: serverTimestamp(),
    };
    await assertFails(setDoc(reqRef(deviceDb), { ...newRequest, status: 'approved' }));
    await assertFails(setDoc(reqRef(deviceDb), { ...newRequest, minutes: 1000 }));
    await assertFails(setDoc(reqRef(strangerDb), newRequest));
    await assertSucceeds(setDoc(reqRef(deviceDb), newRequest));
    await assertFails(updateDoc(reqRef(deviceDb), { status: 'approved' }));

    const approval = {
      status: 'approved',
      grantedMinutes: 30,
      approvedUntil: Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
      resolvedAt: serverTimestamp(),
      resolvedBy: parent,
    };
    await assertFails(updateDoc(reqRef(parentDb), { ...approval, minutes: 240 }));
    await assertFails(updateDoc(reqRef(parentDb), {
      ...approval,
      approvedUntil: Timestamp.fromMillis(Date.now() + 10 * 3600 * 1000),
    }));
    await assertSucceeds(updateDoc(reqRef(parentDb), approval));
    // Already resolved: it cannot be changed again.
    await assertFails(updateDoc(reqRef(parentDb), {
      status: 'denied', resolvedAt: serverTimestamp(), resolvedBy: parent,
    }));
    await assertSucceeds(getDoc(reqRef(deviceDb)));

    // Summaries: the guardian reads, nobody writes.
    const summaryRef = (fs_) => doc(fs_, 'children', childId, 'weekly_summaries', 'w1');
    await assertSucceeds(getDoc(summaryRef(parentDb)));
    await assertFails(getDoc(summaryRef(deviceDb)));
    await assertFails(setDoc(summaryRef(parentDb), { weekId: 'x' }));
  } finally {
    await env.cleanup();
  }
});

function fakeMessaging() {
  const sent = [];
  return {
    sent,
    async sendEachForMulticast(message) {
      sent.push(message);
      return {
        successCount: message.tokens.length,
        responses: message.tokens.map(() => ({ success: true })),
      };
    },
  };
}

async function seedFamily() {
  const suffix = crypto.randomUUID();
  const parentA = `fd-a-${suffix}`;
  const parentB = `fd-b-${suffix}`;
  const childId = `fd-child-${suffix}`;

  await db.collection('children').doc(childId).set({
    nombre: 'Mateo',
    status: 'vinculado',
    parentIds: [parentA, parentB],
    privacyAuthorization: { status: 'authorized', purposes: allPurposes },
  });
  await db.collection('users').doc(parentA).set({
    notificationPrefs: { instant: 'all', weeklySummary: true },
  });
  await db.collection('users').doc(parentB).set({
    notificationPrefs: { instant: 'critical', weeklySummary: false },
  });
  await db.collection('users').doc(parentA).collection('fcmTokens').doc('a')
    .set({ token: 'token-a' });
  await db.collection('users').doc(parentB).collection('fcmTokens').doc('b')
    .set({ token: 'token-b' });

  return { parentA, parentB, childId };
}

async function deleteFamily({ parentA, parentB, childId }) {
  const childRef = db.collection('children').doc(childId);
  const subs = ['alerts', 'requests', 'weekly_summaries', 'usage_reports'];
  for (const sub of subs) {
    const snap = await childRef.collection(sub).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  for (const uid of [parentA, parentB]) {
    const tokens = await db.collection('users').doc(uid).collection('fcmTokens').get();
    await Promise.all(tokens.docs.map((d) => d.ref.delete()));
    await db.collection('users').doc(uid).delete();
  }
  await childRef.delete();
}

test('preferencias "solo críticas" y push de peticiones', async () => {
  const family = await seedFamily();
  const messaging = fakeMessaging();
  const dispatcher = createAlertDispatcher({ db, messaging, FieldValue, logger: silent });
  const childRef = db.collection('children').doc(family.childId);

  try {
    const warning = await childRef.collection('alerts').add({
      title: 'Batería baja', type: 'warning', timestamp: FieldValue.serverTimestamp(),
    });
    await dispatcher.sendAlert(family.childId, warning.id, warning);
    assert.deepEqual(messaging.sent.at(-1).tokens, ['token-a']);

    const sos = await childRef.collection('alerts').add({
      title: 'SOS', type: 'critical', eventKey: 'sos',
      timestamp: FieldValue.serverTimestamp(),
    });
    await dispatcher.sendAlert(family.childId, sos.id, sos);
    assert.deepEqual(messaging.sent.at(-1).tokens.sort(), ['token-a', 'token-b']);
    assert.match(messaging.sent.at(-1).notification.title, /^🆘 Mateo: SOS/);

    const request = await childRef.collection('requests').add({
      type: 'unlock_app', packageName: 'com.game', appName: 'Juego',
      minutes: 15, status: 'pending', createdAt: FieldValue.serverTimestamp(),
    });
    await dispatcher.sendRequest(family.childId, request.id, request);
    await dispatcher.sendRequest(family.childId, request.id, request);
    const requestPushes = messaging.sent.filter((m) => m.data.kind === 'request');
    assert.equal(requestPushes.length, 1);
    assert.equal(requestPushes[0].data.requestId, request.id);
  } finally {
    dispatcher.stop();
    await deleteFamily(family);
  }
});

test('resumen semanal: una vez por semana y solo el domingo por la tarde', async () => {
  const family = await seedFamily();
  const messaging = fakeMessaging();
  // Sunday 22-11-2026 at 20:00 (local time).
  const sunday = new Date(2026, 10, 22, 20, 0);
  const dispatcher = createAlertDispatcher({
    db, messaging, FieldValue, logger: silent, now: () => sunday.getTime(),
  });
  const childRef = db.collection('children').doc(family.childId);

  try {
    await childRef.collection('alerts').add({
      title: 'X', type: 'critical', timestamp: new Date(sunday.getTime() - 3600 * 1000),
    });
    await childRef.collection('usage_reports').doc('2026-11-22').set({
      totalScreenTimeMs: 2 * 3600 * 1000,
      apps: [{ packageName: 'com.game', appName: 'Juego', foregroundTimeMs: 3600 * 1000 }],
    });

    // Other tests may have profiles in the emulator: only what concerns
    // this minor is checked.
    const mine = () => messaging.sent.filter(
      (m) => m.data.kind === 'weekly_summary' && m.data.childId === family.childId
    );

    // Nothing is sent on Monday.
    await dispatcher.sendWeeklySummaries(new Date(2026, 10, 23, 20));
    assert.equal(mine().length, 0);

    await dispatcher.sendWeeklySummaries(sunday);
    await dispatcher.sendWeeklySummaries(sunday);
    assert.equal(mine().length, 1);

    const summaries = await childRef.collection('weekly_summaries').get();
    assert.equal(summaries.size, 1);
    const summary = summaries.docs[0].data();
    assert.equal(summary.weekId, '2026-11-16');
    assert.equal(summary.alerts.total, 1);
    assert.equal(summary.usage.topApps[0].appName, 'Juego');

    // Guardian B turned off the weekly summary.
    const pushes = mine();
    assert.deepEqual(pushes[0].tokens, ['token-a']);
    assert.match(pushes[0].notification.body, /2 h\/día de pantalla/);
  } finally {
    dispatcher.stop();
    await deleteFamily(family);
  }
});
