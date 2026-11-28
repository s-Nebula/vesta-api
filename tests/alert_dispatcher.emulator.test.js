const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089') {
  throw new Error('Bloqueado: requiere Firestore Emulator en 127.0.0.1:8089.');
}
if ((process.env.GCLOUD_PROJECT || '') !== 'demo-vesta') {
  throw new Error('Bloqueado: el proyecto debe ser demo-vesta.');
}

const { db, admin } = require('../src/config/firebase');
const { createAlertDispatcher, formatDuration } =
  require('../src/services/alert_dispatcher');

const FieldValue = admin.firestore.FieldValue;
const purposes = {
  location: true,
  device_status: true,
  usage_stats: true,
  app_filtering: true,
  domain_filtering: true,
  alerts: true,
};

function fakeMessaging() {
  const sent = [];
  return {
    sent,
    async sendEachForMulticast(message) {
      sent.push(message);
      return {
        successCount: message.tokens.length - 1,
        responses: message.tokens.map((token) => (
          token === 'token-invalido'
            ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
            : { success: true }
        )),
      };
    },
  };
}

const silent = { info() {}, error() {} };

async function seedChild({ alerts = true } = {}) {
  const suffix = crypto.randomUUID();
  const parent = `disp-parent-${suffix}`;
  const childId = `disp-child-${suffix}`;

  await db.collection('children').doc(childId).set({
    nombre: 'Lucía',
    status: 'vinculado',
    deviceUid: `disp-device-${suffix}`,
    parentIds: [parent],
    privacyAuthorization: {
      status: 'authorized',
      purposes: { ...purposes, alerts },
    },
  });
  await db.collection('users').doc(parent).collection('fcmTokens')
    .doc('t1').set({ token: 'token-valido' });
  await db.collection('users').doc(parent).collection('fcmTokens')
    .doc('t2').set({ token: 'token-invalido' });

  return { parent, childId };
}

async function cleanup({ parent, childId }) {
  const childRef = db.collection('children').doc(childId);
  const alerts = await childRef.collection('alerts').get();
  const statuses = await childRef.collection('device_status').get();
  const tokens = await db.collection('users').doc(parent).collection('fcmTokens').get();
  const batch = db.batch();
  [...alerts.docs, ...statuses.docs, ...tokens.docs].forEach((d) => batch.delete(d.ref));
  batch.delete(childRef);
  batch.delete(db.collection('server_state').doc(childId));
  await batch.commit();
}

test('envía una sola push por alerta y limpia tokens inválidos', async () => {
  const seeded = await seedChild();
  const messaging = fakeMessaging();
  const dispatcher = createAlertDispatcher({
    db, messaging, FieldValue, logger: silent,
  });

  try {
    const alertRef = await db.collection('children').doc(seeded.childId)
      .collection('alerts').add({
        title: 'Aplicación bloqueada',
        subtitle: 'Intentó abrir: Juego',
        type: 'critical',
        eventKey: 'blocked_app',
        timestamp: FieldValue.serverTimestamp(),
      });

    // Two simultaneous attempts: only one must send.
    await Promise.all([
      dispatcher.sendAlert(seeded.childId, alertRef.id, alertRef),
      dispatcher.sendAlert(seeded.childId, alertRef.id, alertRef),
    ]);
    await dispatcher.sendAlert(seeded.childId, alertRef.id, alertRef);

    assert.equal(messaging.sent.length, 1);
    assert.equal(messaging.sent[0].notification.title, '🚨 Lucía: Aplicación bloqueada');
    assert.equal(messaging.sent[0].data.childId, seeded.childId);
    assert.equal(messaging.sent[0].android.notification.channelId, 'vesta_alerts');
    assert.equal(
      messaging.sent[0].webpush.fcmOptions.link,
      `https://app.vestasecurity.date/#/home/${seeded.childId}?tab=alerts`
    );

    const alert = await alertRef.get();
    assert.ok(alert.data().pushSentAt);

    const tokens = await db.collection('users').doc(seeded.parent)
      .collection('fcmTokens').get();
    assert.deepEqual(tokens.docs.map((d) => d.data().token), ['token-valido']);
  } finally {
    dispatcher.stop();
    await cleanup(seeded);
  }
});

test('no envía push si los tutores no autorizaron alertas', async () => {
  const seeded = await seedChild({ alerts: false });
  const messaging = fakeMessaging();
  const dispatcher = createAlertDispatcher({
    db, messaging, FieldValue, logger: silent,
  });

  try {
    const alertRef = await db.collection('children').doc(seeded.childId)
      .collection('alerts').add({
        title: 'X',
        type: 'warning',
        timestamp: FieldValue.serverTimestamp(),
      });
    await dispatcher.sendAlert(seeded.childId, alertRef.id, alertRef);
    assert.equal(messaging.sent.length, 0);
  } finally {
    dispatcher.stop();
    await cleanup(seeded);
  }
});

test('crea una única alerta de desconexión y la rearma al reconectar', async () => {
  const seeded = await seedChild();
  let clock = Date.now();
  const dispatcher = createAlertDispatcher({
    db,
    messaging: fakeMessaging(),
    FieldValue,
    logger: silent,
    now: () => clock,
    options: { offlineAfterMs: 20 * 60 * 1000 },
  });
  const childRef = db.collection('children').doc(seeded.childId);
  const offlineAlerts = async () => (await childRef.collection('alerts')
    .where('eventKey', '==', 'device_offline').get()).size;

  try {
    const lastSeen = new Date(clock - 25 * 60 * 1000);
    await childRef.collection('device_status').doc('current')
      .set({ updatedAt: lastSeen });

    await dispatcher.checkOfflineDevices();
    await dispatcher.checkOfflineDevices();
    assert.equal(await offlineAlerts(), 1);

    // It reports again: no new alert, and it is re-armed.
    await childRef.collection('device_status').doc('current')
      .set({ updatedAt: new Date(clock) });
    await dispatcher.checkOfflineDevices();
    assert.equal(await offlineAlerts(), 1);

    // A new disconnection later: second alert.
    clock += 60 * 60 * 1000;
    await dispatcher.checkOfflineDevices();
    assert.equal(await offlineAlerts(), 2);
  } finally {
    dispatcher.stop();
    await cleanup(seeded);
  }
});

test('formatDuration', () => {
  assert.equal(formatDuration(25 * 60000), '25 minutos');
  assert.equal(formatDuration(3 * 3600000), '3 horas');
  assert.equal(formatDuration(2.5 * 3600000), '2.5 horas');
});

test('sends each guardian the push in the language of their app', async () => {
  const seeded = await seedChild();
  await db.collection('users').doc(seeded.parent).collection('fcmTokens')
    .doc('t3').set({ token: 'token-ingles', lang: 'en' });
  const messaging = fakeMessaging();
  const dispatcher = createAlertDispatcher({
    db, messaging, FieldValue, logger: silent,
  });

  try {
    // Written by a minor's phone in Spanish.
    const alertRef = await db.collection('children').doc(seeded.childId)
      .collection('alerts').add({
        title: 'Llegó a Colegio',
        subtitle: 'El dispositivo entró en la zona segura "Colegio".',
        type: 'info',
        eventKey: 'zone_enter',
        zoneName: 'Colegio',
        timestamp: FieldValue.serverTimestamp(),
      });

    await dispatcher.sendAlert(seeded.childId, alertRef.id, alertRef);

    const byToken = Object.fromEntries(
      messaging.sent.map((m) => [m.tokens.join(','), m.notification])
    );
    assert.equal(messaging.sent.length, 2);
    assert.equal(byToken['token-valido,token-invalido'].title, 'ℹ️ Lucía: Llegó a Colegio');
    assert.equal(byToken['token-ingles'].title, 'ℹ️ Lucía: Arrived at Colegio');
    assert.equal(byToken['token-ingles'].body, 'The device entered the safe zone "Colegio".');
  } finally {
    dispatcher.stop();
    await cleanup(seeded);
  }
});
