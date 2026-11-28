/**
 * Sends alert push notifications and monitors disconnected devices,
 * running inside the API (no Cloud Functions needed).
 *
 * Background: vesta_app's `enviarNotificacionAlerta` Cloud Function was
 * never deployed, so guardians did not receive pushes. This module does the
 * same from the server, which is always on:
 *
 * 1. Listens to the alerts of every linked profile and sends a push to its
 *    guardians' FCM tokens. Each alert is "claimed" in a transaction
 *    (`pushSentAt`) so it is never sent twice, even across restarts or
 *    multiple instances.
 * 2. Every few minutes it checks each profile's `device_status/current`. If
 *    the device has not reported for more than `offlineAfterMs`, it creates a
 *    `device_offline` alert: it is the only way to report a disconnection,
 *    since the disconnected phone cannot report it itself.
 *
 * Only simple collection queries are used (no composite or
 * collection-group indexes).
 */

const texts = require('./push_texts');

const DEFAULTS = Object.freeze({
  // Alerts older than this are not notified on start-up (avoids notifying
  // everything that happened while the server was down all at once).
  maxAgeMs: 30 * 60 * 1000,
  offlineAfterMs: 20 * 60 * 1000,
  watchdogIntervalMs: 5 * 60 * 1000,
  recentAlertsPerChild: 20,
  androidChannelId: 'vesta_alerts',
  // Web panel: tapping a browser notification opens this app.
  webAppUrl: process.env.VESTA_WEB_APP_URL || 'https://app.vestasecurity.date',
  summaryCheckIntervalMs: 60 * 60 * 1000,
  // Sunday (0) from 19:00, server local time.
  summaryWeekday: 0,
  summaryHour: 19,
});

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

function purposesAllow(child, ...purposes) {
  const auth = child?.privacyAuthorization;
  return child?.status === 'vinculado' &&
    auth?.status === 'authorized' &&
    purposes.every((purpose) => auth?.purposes?.[purpose] === true);
}

const formatDuration = texts.formatDuration;

/**
 * Web panel screen a push opens (hash URLs of the Flutter web app), the
 * same places the phone app opens from a notification.
 */
function webLink(baseUrl, data = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const childId = typeof data.childId === 'string' ? data.childId : '';
  if (!childId) return `${base}/`;
  const id = encodeURIComponent(childId);
  switch (data.kind) {
    case 'request':
      return `${base}/#/home/${id}?open=requests`;
    case 'weekly_summary':
      return `${base}/#/home/${id}?tab=reports`;
    default:
      return `${base}/#/home/${id}?tab=alerts`;
  }
}

function createAlertDispatcher({
  db,
  messaging,
  FieldValue,
  now = () => Date.now(),
  logger = console,
  options = {},
}) {
  const config = { ...DEFAULTS, ...options };
  const childListeners = new Map();
  let childrenUnsubscribe = null;
  let watchdogTimer = null;
  let summaryTimer = null;
  let stopped = false;
  const inFlight = new Set();

  async function claimAlert(alertRef) {
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(alertRef);
      if (!snapshot.exists || snapshot.data().pushSentAt) return null;
      transaction.update(alertRef, {
        pushSentAt: FieldValue.serverTimestamp(),
      });
      return snapshot.data();
    });
  }

  /**
   * Guardians' tokens. `filter(prefs)` excludes whoever chose not to get
   * that kind of notice instantly.
   */
  async function tokensFor(parentIds, filter = () => true) {
    const userSnaps = await Promise.all(
      parentIds.map((uid) => db.collection('users').doc(uid).get())
    );
    const wanted = parentIds.filter((uid, index) =>
      filter(userSnaps[index].data()?.notificationPrefs || {})
    );

    const snapshots = await Promise.all(
      wanted.map((uid) =>
        db.collection('users').doc(uid).collection('fcmTokens').get()
      )
    );
    const docs = snapshots.flatMap((snapshot) => snapshot.docs);
    // Language of each token: the one the guardian's app uses (Spanish if unknown).
    const langOf = new Map();
    for (const doc of docs) {
      const data = doc.data();
      if (typeof data.token === 'string' && data.token && !langOf.has(data.token)) {
        langOf.set(data.token, texts.normalizeLang(data.lang));
      }
    }
    const tokens = [...langOf.keys()];
    return { docs, tokens, langOf };
  }

  /**
   * Sends one push per language: `build(lang)` returns { title, body }.
   * Returns the number of devices reached.
   */
  async function pushLocalized({ tokens, docs, langOf, build, data, priority, tag }) {
    let sent = 0;
    for (const lang of texts.LANGS) {
      const group = tokens.filter((token) => langOf.get(token) === lang);
      if (group.length === 0) continue;
      const { title, body } = build(lang);
      sent += await push({ tokens: group, docs, title, body, data, priority, tag });
    }
    return sent;
  }

  async function push({ tokens, docs, title, body, data, priority, tag }) {
    if (tokens.length === 0) return 0;

    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
      android: {
        priority,
        notification: {
          sound: 'default',
          channelId: config.androidChannelId,
          tag,
        },
      },
      apns: { payload: { aps: { sound: 'default' } } },
      // Browsers (web panel). Same tag: a repeated alert replaces the old one.
      webpush: {
        notification: {
          icon: `${config.webAppUrl}/icons/Icon-192.png`,
          badge: `${config.webAppUrl}/icons/Icon-192.png`,
          ...(tag ? { tag } : {}),
        },
        fcmOptions: { link: webLink(config.webAppUrl, data) },
      },
    });

    const invalid = new Set();
    response.responses.forEach((result, index) => {
      if (!result.success && INVALID_TOKEN_CODES.has(result.error?.code)) {
        invalid.add(tokens[index]);
      }
    });

    if (invalid.size > 0) {
      const batch = db.batch();
      for (const doc of docs) {
        if (invalid.has(doc.data().token)) batch.delete(doc.ref);
      }
      await batch.commit();
    }

    return response.successCount;
  }

  async function claim(ref, field) {
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.data()[field]) return null;
      transaction.update(ref, { [field]: FieldValue.serverTimestamp() });
      return snapshot.data();
    });
  }

  async function sendAlert(childId, alertId, alertRef) {
    const key = `${childId}/${alertId}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    try {
      const alert = await claim(alertRef, 'pushSentAt');
      if (!alert) return;

      const childSnap = await db.collection('children').doc(childId).get();
      if (!childSnap.exists) return;
      const child = childSnap.data();
      if (!purposesAllow(child, 'alerts')) return;

      const type = typeof alert.type === 'string' ? alert.type : 'critical';
      const parentIds = Array.isArray(child.parentIds) ? child.parentIds : [];
      // "Only critical alerts instantly": the rest stay in the app and the summary.
      const { docs, tokens, langOf } = await tokensFor(
        parentIds,
        (prefs) => type === 'critical' || prefs.instant !== 'critical'
      );

      const icon = alert.eventKey === 'sos'
        ? '🆘'
        : type === 'critical' ? '🚨' : type === 'warning' ? '⚠️' : 'ℹ️';

      const sent = await pushLocalized({
        tokens,
        docs,
        langOf,
        build: (lang) => {
          const text = texts.alertText(alert, lang);
          return {
            title: `${icon} ${texts.minorName(child, lang)}: ${text.title.slice(0, 120)}`,
            body: text.body.slice(0, 300),
          };
        },
        data: {
          childId,
          alertId,
          type,
          eventKey: String(alert.eventKey || ''),
        },
        priority: type === 'info' ? 'normal' : 'high',
        tag: alertId,
      });

      logger.info?.(`Push de alerta ${alertId}: ${sent}/${tokens.length}.`);
    } catch (error) {
      logger.error?.(`Error enviando push de ${key}: ${error.message}`);
    } finally {
      inFlight.delete(key);
    }
  }

  async function sendRequest(childId, requestId, requestRef) {
    const key = `req:${childId}/${requestId}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);

    try {
      const request = await claim(requestRef, 'notifiedAt');
      if (!request || request.status !== 'pending') return;

      const childSnap = await db.collection('children').doc(childId).get();
      if (!childSnap.exists) return;
      const child = childSnap.data();
      if (!purposesAllow(child, 'app_filtering')) return;

      const parentIds = Array.isArray(child.parentIds) ? child.parentIds : [];
      const { docs, tokens, langOf } = await tokensFor(parentIds);

      await pushLocalized({
        tokens,
        docs,
        langOf,
        build: (lang) => texts.requestText(request, texts.minorName(child, lang), lang),
        data: { childId, requestId, kind: 'request' },
        priority: 'high',
        tag: `request-${requestId}`,
      });
    } catch (error) {
      logger.error?.(`Error enviando push de ${key}: ${error.message}`);
    } finally {
      inFlight.delete(key);
    }
  }

  function watchChild(childId) {
    if (childListeners.has(childId)) return;

    const unsubscribe = db.collection('children')
      .doc(childId)
      .collection('alerts')
      .orderBy('timestamp', 'desc')
      .limit(config.recentAlertsPerChild)
      .onSnapshot((snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'removed') continue;
          const data = change.doc.data();
          if (data.pushSentAt) continue;

          const createdAt = toMillis(data.timestamp);
          if (createdAt === null) continue; // no server time yet
          if (now() - createdAt > config.maxAgeMs) continue;

          sendAlert(childId, change.doc.id, change.doc.ref);
        }
      }, (error) => {
        logger.error?.(`Error escuchando alertas de ${childId}: ${error.message}`);
        childListeners.delete(childId);
      });

    const unsubscribeRequests = db.collection('children')
      .doc(childId)
      .collection('requests')
      .where('status', '==', 'pending')
      .onSnapshot((snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'removed') continue;
          const data = change.doc.data();
          if (data.notifiedAt) continue;
          const createdAt = toMillis(data.createdAt);
          if (createdAt === null || now() - createdAt > config.maxAgeMs) continue;
          sendRequest(childId, change.doc.id, change.doc.ref);
        }
      }, (error) => {
        logger.error?.(`Error escuchando peticiones de ${childId}: ${error.message}`);
      });

    childListeners.set(childId, () => {
      unsubscribe();
      unsubscribeRequests();
    });
  }

  function unwatchChild(childId) {
    const unsubscribe = childListeners.get(childId);
    if (unsubscribe) unsubscribe();
    childListeners.delete(childId);
  }

  async function checkOfflineDevices() {
    const children = await db.collection('children')
      .where('status', '==', 'vinculado')
      .get();

    let created = 0;

    for (const childDoc of children.docs) {
      const child = childDoc.data();
      if (!purposesAllow(child, 'alerts', 'device_status')) continue;

      const statusSnap = await childDoc.ref
        .collection('device_status').doc('current').get();
      const lastSeen = toMillis(statusSnap.data()?.updatedAt) ??
        toMillis(child.linkedAt);
      if (lastSeen === null) continue;

      const offlineFor = now() - lastSeen;
      // Internal state only reachable from the server (rules: denied).
      const stateRef = db.collection('server_state').doc(childDoc.id);

      const createdAlert = await db.runTransaction(async (transaction) => {
        const stateSnap = await transaction.get(stateRef);
        const alertedFor = stateSnap.data()?.offlineAlertedForMs ?? null;

        if (offlineFor < config.offlineAfterMs) {
          // It reported again: re-arm the notice for next time.
          if (alertedFor !== null) {
            transaction.set(stateRef, { offlineAlertedForMs: null }, { merge: true });
          }
          return false;
        }

        // This same disconnection was already notified.
        if (alertedFor === lastSeen) return false;

        transaction.set(stateRef, {
          offlineAlertedForMs: lastSeen,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        // Stored in Spanish for the in-app list; `offlineMinutes` lets the
        // push be written in each guardian's language.
        const [title, subtitle] = texts.deviceOfflineText(offlineFor).es;
        transaction.create(childDoc.ref.collection('alerts').doc(), {
          title,
          subtitle,
          offlineMinutes: Math.round(offlineFor / 60000),
          type: 'critical',
          eventKey: 'device_offline',
          source: 'server',
          lastSeenAt: new Date(lastSeen),
          timestamp: FieldValue.serverTimestamp(),
        });

        return true;
      });

      if (createdAlert) created++;
    }

    return created;
  }

  function weekStartKey(date) {
    // Monday of the week of `date` (local time), as YYYY-MM-DD.
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const offset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - offset);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  function dateKey(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${mm}-${dd}`;
  }

  /** Computes and stores a minor's summary of the last 7 days. */
  async function buildWeeklySummary(childDoc, at = new Date(now())) {
    const child = childDoc.data();
    const weekId = weekStartKey(at);
    const ref = childDoc.ref.collection('weekly_summaries').doc(weekId);
    const from = new Date(at.getTime() - 7 * 24 * 3600 * 1000);

    const alertsSnap = await childDoc.ref.collection('alerts')
      .where('timestamp', '>=', from)
      .get();
    const byType = { critical: 0, warning: 0, info: 0 };
    const byEvent = {};
    for (const doc of alertsSnap.docs) {
      const data = doc.data();
      const type = ['critical', 'warning'].includes(data.type) ? data.type : 'info';
      byType[type]++;
      const event = String(data.eventKey || 'other');
      byEvent[event] = (byEvent[event] || 0) + 1;
    }

    const summary = {
      weekId,
      from,
      to: at,
      alerts: { total: alertsSnap.size, byType, byEvent },
      createdAt: FieldValue.serverTimestamp(),
    };

    // Device usage only if the guardians authorised that purpose.
    if (purposesAllow(child, 'usage_stats')) {
      const days = [];
      for (let i = 0; i < 7; i++) {
        days.push(dateKey(new Date(at.getTime() - i * 24 * 3600 * 1000)));
      }
      const reportSnaps = await Promise.all(days.map((day) =>
        childDoc.ref.collection('usage_reports').doc(day).get()
      ));
      const reports = reportSnaps.filter((r) => r.exists).map((r) => r.data());
      const totalMs = reports.reduce(
        (sum, r) => sum + (Number(r.totalScreenTimeMs) || 0), 0
      );
      const apps = {};
      for (const report of reports) {
        for (const app of Array.isArray(report.apps) ? report.apps : []) {
          const pkg = String(app.packageName || '');
          if (!pkg) continue;
          apps[pkg] ??= { packageName: pkg, appName: app.appName || pkg, ms: 0 };
          apps[pkg].ms += Number(app.foregroundTimeMs) || 0;
        }
      }
      summary.usage = {
        daysWithData: reports.length,
        totalScreenTimeMs: totalMs,
        averageDailyMs: reports.length ? Math.round(totalMs / reports.length) : 0,
        topApps: Object.values(apps).sort((a, b) => b.ms - a.ms).slice(0, 5),
      };
    }

    const created = await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) return false;
      transaction.create(ref, summary);
      return true;
    });

    return created ? summary : null;
  }

  async function sendWeeklySummaries(at = new Date(now())) {
    if (at.getDay() !== config.summaryWeekday || at.getHours() < config.summaryHour) {
      return 0;
    }

    const children = await db.collection('children')
      .where('status', '==', 'vinculado')
      .get();
    let sent = 0;

    for (const childDoc of children.docs) {
      const child = childDoc.data();
      if (!purposesAllow(child, 'alerts')) continue;

      const summary = await buildWeeklySummary(childDoc, at);
      if (!summary) continue; // already generated this week

      const parentIds = Array.isArray(child.parentIds) ? child.parentIds : [];
      const { docs, tokens, langOf } = await tokensFor(
        parentIds,
        (prefs) => prefs.weeklySummary !== false
      );

      await pushLocalized({
        tokens,
        docs,
        langOf,
        build: (lang) => texts.weeklySummaryText(summary, texts.minorName(child, lang), lang),
        data: { childId: childDoc.id, kind: 'weekly_summary', weekId: summary.weekId },
        priority: 'normal',
        tag: `summary-${childDoc.id}-${summary.weekId}`,
      });
      sent++;
    }

    return sent;
  }

  function start() {
    childrenUnsubscribe = db.collection('children')
      .where('status', '==', 'vinculado')
      .onSnapshot((snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'removed') {
            unwatchChild(change.doc.id);
          } else {
            watchChild(change.doc.id);
          }
        }
      }, (error) => {
        logger.error?.(`Error escuchando perfiles: ${error.message}`);
      });

    const runWatchdog = () => {
      if (stopped) return;
      checkOfflineDevices().catch((error) => {
        logger.error?.(`Error en la vigilancia de conexión: ${error.message}`);
      });
    };

    watchdogTimer = setInterval(runWatchdog, config.watchdogIntervalMs);
    watchdogTimer.unref?.();

    summaryTimer = setInterval(() => {
      if (stopped) return;
      sendWeeklySummaries().catch((error) => {
        logger.error?.(`Error en el resumen semanal: ${error.message}`);
      });
    }, config.summaryCheckIntervalMs);
    summaryTimer.unref?.();
    // First check after giving devices time to report.
    setTimeout(runWatchdog, 60 * 1000).unref?.();

    logger.info?.('Despachador de alertas iniciado.');
  }

  function stop() {
    stopped = true;
    if (childrenUnsubscribe) childrenUnsubscribe();
    for (const childId of [...childListeners.keys()]) unwatchChild(childId);
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (summaryTimer) clearInterval(summaryTimer);
  }

  return {
    start,
    stop,
    // Exposed for tests.
    watchChild,
    sendAlert,
    sendRequest,
    checkOfflineDevices,
    buildWeeklySummary,
    sendWeeklySummaries,
  };
}

module.exports = { createAlertDispatcher, purposesAllow, formatDuration, webLink };
