const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/services/push_texts');

test('normalizeLang defaults to Spanish', () => {
  assert.equal(t.normalizeLang('en'), 'en');
  assert.equal(t.normalizeLang('en-US'), 'en');
  assert.equal(t.normalizeLang('fr'), 'es');
  assert.equal(t.normalizeLang(undefined), 'es');
});

test('formatDuration in both languages', () => {
  assert.equal(t.formatDuration(25 * 60000), '25 minutos');
  assert.equal(t.formatDuration(25 * 60000, 'en'), '25 minutes');
  assert.equal(t.formatDuration(2.5 * 3600000, 'en'), '2.5 hours');
});

test('rebuilds tracker alerts in the guardian language', () => {
  const es = { title: 'Batería baja', subtitle: 'La batería del dispositivo está al 18%.', eventKey: 'battery_low' };
  assert.deepEqual(t.alertText(es, 'en'), { title: 'Low battery', body: 'The device battery is at 18%.' });

  const en = { title: 'App blocked', subtitle: 'Tried to open: Roblox', eventKey: 'blocked_app' };
  assert.deepEqual(t.alertText(en, 'es'), { title: 'Aplicación bloqueada', body: 'Intentó abrir: Roblox' });

  const limit = { subtitle: 'Usó todo el tiempo de hoy en YouTube', eventKey: 'app_limit_reached' };
  assert.equal(t.alertText(limit, 'en').body, "Used all of today's time on YouTube");

  const offline = { eventKey: 'device_offline', offlineMinutes: 45 };
  assert.match(t.alertText(offline, 'en').body, /has not sent data for 45 minutes/);

  const sos = { eventKey: 'sos', lat: 1, lng: 2 };
  assert.equal(t.alertText(sos, 'en').title, 'SOS: needs help');
});

test('falls back to the stored text when the event is unknown', () => {
  const alert = { title: 'Algo nuevo', subtitle: 'Detalle', eventKey: 'future_event' };
  assert.deepEqual(t.alertText(alert, 'en'), { title: 'Algo nuevo', body: 'Detalle' });
  assert.deepEqual(t.alertText({}, 'en'), { title: 'Incident detected', body: 'Vesta has recorded an alert.' });
});

test('requests and weekly summary', () => {
  const req = { type: 'extra_time', minutes: 30, appName: 'Call of Duty', message: 'Por favor' };
  assert.deepEqual(t.requestText(req, 'Ana', 'en'), {
    title: '🙋 Ana asks for 30 more min of Call of Duty',
    body: '"Por favor" · Tap to answer',
  });
  const summary = {
    usage: { daysWithData: 7, averageDailyMs: 90 * 60000, topApps: [{ appName: 'YouTube' }] },
    alerts: { total: 3, byType: { critical: 1 } },
  };
  assert.deepEqual(t.weeklySummaryText(summary, 'Ana', 'en'), {
    title: "📊 Ana's weekly summary",
    body: '1 h 30 min/day of screen time · most used: YouTube · 3 alerts (1 critical)',
  });
  assert.equal(t.weeklySummaryText(summary, 'Ana', 'es').body,
    '1 h 30 min/día de pantalla · más usada: YouTube · 3 alertas (1 crítica)');
});

test('webLink: the web panel screen each push opens', () => {
  const { webLink } = require('../src/services/alert_dispatcher');
  const base = 'https://app.vestasecurity.date/';
  assert.equal(webLink(base, { childId: 'a b', kind: 'alert' }), 'https://app.vestasecurity.date/#/home/a%20b?tab=alerts');
  assert.equal(webLink(base, { childId: 'x', kind: 'request' }), 'https://app.vestasecurity.date/#/home/x?open=requests');
  assert.equal(webLink(base, { childId: 'x', kind: 'weekly_summary' }), 'https://app.vestasecurity.date/#/home/x?tab=reports');
  assert.equal(webLink(base, {}), 'https://app.vestasecurity.date/');
});
