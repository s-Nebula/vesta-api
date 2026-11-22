const test = require('node:test');
const fs = require('node:fs');
const crypto = require('node:crypto');

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8089') {
  throw new Error('Bloqueado: requiere Firestore Emulator en 127.0.0.1:8089.');
}

const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const {
  collection, doc, getDocs, setDoc, query, where,
} = require('firebase/firestore');

// Real queries the apps make (not just single-document reads).
test('el tutor puede listar sus perfiles y nadie más', async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-vesta',
    firestore: { rules: fs.readFileSync('firestore.test.rules', 'utf8') },
  });
  const suffix = crypto.randomUUID();
  const parent = `q-parent-${suffix}`;
  const other = `q-other-${suffix}`;

  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'children', `q-a-${suffix}`), {
        status: 'esperando_vinculacion', parentIds: [parent],
      });
      await setDoc(doc(db, 'children', `q-b-${suffix}`), {
        status: 'esperando_vinculacion', parentIds: [other],
      });
    });

    const parentDb = env.authenticatedContext(parent).firestore();
    const anon = env.unauthenticatedContext().firestore();

    // Consulta de LinkAccessGate y DashboardScreen.
    await assertSucceeds(getDocs(query(
      collection(parentDb, 'children'),
      where('parentIds', 'array-contains', parent),
    )));
    // Without a filter (it would see other people's profiles): denied.
    await assertFails(getDocs(collection(parentDb, 'children')));
    // Filtering by another guardian: denied.
    await assertFails(getDocs(query(
      collection(parentDb, 'children'),
      where('parentIds', 'array-contains', other),
    )));
    await assertFails(getDocs(query(
      collection(anon, 'children'),
      where('parentIds', 'array-contains', parent),
    )));
  } finally {
    await env.cleanup();
  }
});

test('consultas de las apps sobre las subcolecciones del perfil', async () => {
  const { orderBy, limit } = require('firebase/firestore');
  const env = await initializeTestEnvironment({
    projectId: 'demo-vesta',
    firestore: { rules: fs.readFileSync('firestore.test.rules', 'utf8') },
  });
  const suffix = crypto.randomUUID();
  const parent = `qs-parent-${suffix}`;
  const device = `qs-device-${suffix}`;
  const childId = `qs-child-${suffix}`;
  const versions = { termsVersion: '1.0.0', privacyVersion: '1.0.0' };
  const purposes = {
    location: true, device_status: true, usage_stats: true,
    app_filtering: true, domain_filtering: true, alerts: true,
  };

  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'children', childId), {
        status: 'vinculado', deviceUid: device, parentIds: [parent],
        privacyAuthorization: { ...versions, status: 'authorized', purposes },
      });
      await setDoc(doc(db, 'users', parent, 'privacy_consents', 'current'), {
        ...versions, status: 'active', acceptTerms: true,
        acknowledgePrivacy: true, guardianDeclaration: true,
        revocationPending: false, purposes,
      });
      await setDoc(doc(db, 'children', childId, 'filter_rules', 'r1'), {
        category: 'app', type: 'block', value: 'x', isEnabled: true, createdAt: new Date(),
      });
    });

    const p = env.authenticatedContext(parent).firestore();
    const d = env.authenticatedContext(device).firestore();
    const sub = (db, name) => collection(db, 'children', childId, name);

    // Guardian app.
    await assertSucceeds(getDocs(query(sub(p, 'alerts'), orderBy('timestamp', 'desc'), limit(100))));
    await assertSucceeds(getDocs(query(sub(p, 'usage_reports'), orderBy('date', 'desc'), limit(30))));
    await assertSucceeds(getDocs(query(sub(p, 'installed_apps'), where('isInstalled', '==', true))));
    await assertSucceeds(getDocs(query(sub(p, 'filter_rules'), where('category', '==', 'app'))));
    await assertSucceeds(getDocs(query(sub(p, 'filter_rules'), where('category', '==', 'url'), where('type', '==', 'block'))));
    await assertSucceeds(getDocs(query(sub(p, 'requests'), orderBy('createdAt', 'desc'), limit(50))));
    await assertSucceeds(getDocs(query(sub(p, 'requests'), where('status', '==', 'pending'))));
    await assertSucceeds(getDocs(sub(p, 'zones')));
    await assertSucceeds(getDocs(query(sub(p, 'weekly_summaries'), orderBy('weekId', 'desc'), limit(1))));

    // Vesta Tracker.
    await assertSucceeds(getDocs(query(sub(d, 'filter_rules'), where('category', '==', 'app'), where('isEnabled', '==', true))));
    await assertSucceeds(getDocs(query(sub(d, 'filter_rules'), where('category', '==', 'url'), where('isEnabled', '==', true))));
    await assertSucceeds(getDocs(query(sub(d, 'requests'), where('status', '==', 'approved'))));
    await assertSucceeds(getDocs(query(sub(d, 'requests'), orderBy('createdAt', 'desc'), limit(20))));
    await assertSucceeds(getDocs(sub(d, 'zones')));
    await assertSucceeds(getDocs(sub(d, 'installed_apps')));
  } finally {
    await env.cleanup();
  }
});
