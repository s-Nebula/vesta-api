/**
 * Texts of the push notifications sent by the server, in Spanish and English.
 *
 * Each guardian's device stores its language in `users/{uid}/fcmTokens/{token}.lang`
 * ('es' or 'en'). Tokens without it (older app versions) get Spanish.
 *
 * Alerts written by Vesta Tracker carry their text in the minor's phone
 * language, plus an `eventKey` and, for some events, the data needed to
 * rebuild the text. `alertText` rebuilds the text in the guardian's
 * language from that data and falls back to the stored text when an event
 * is unknown or a value is missing.
 */

const LANGS = ['es', 'en'];
const DEFAULT_LANG = 'es';

function normalizeLang(value) {
  if (typeof value !== 'string') return DEFAULT_LANG;
  const code = value.trim().toLowerCase().slice(0, 2);
  return LANGS.includes(code) ? code : DEFAULT_LANG;
}

function formatDuration(ms, lang = DEFAULT_LANG) {
  const minutes = Math.round(ms / 60000);
  const en = lang === 'en';
  if (minutes < 120) {
    if (en) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  }
  const hours = (ms / 3600000).toFixed(1).replace('.0', '');
  return en ? `${hours} hours` : `${hours} horas`;
}

function formatHours(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** First number in a text ("La batería está al 15%." → "15"). */
function firstNumber(text) {
  const match = String(text || '').match(/\d+(?:[.,]\d+)?/);
  return match ? match[0].replace(',', '.') : null;
}

/** Text after the last ": " ("Intentó abrir: Juego" → "Juego"). */
function afterColon(text) {
  const value = String(text || '');
  const index = value.lastIndexOf(': ');
  return index >= 0 ? str(value.slice(index + 2)) : null;
}

/** App name in the daily-limit notice, in either language. */
function limitApp(text) {
  const match = String(text || '').match(/(?:de hoy en|today's time on) (.+)$/);
  return match ? str(match[1]) : null;
}

function offlineMinutes(alert) {
  if (Number.isFinite(alert.offlineMinutes)) return alert.offlineMinutes;
  return null;
}

/**
 * Builders by event: (alert) → { es: [title, body], en: [title, body] } or
 * null when the data needed is missing.
 */
const ALERTS = {
  battery_low(alert) {
    const level = firstNumber(alert.subtitle);
    if (!level) return null;
    return {
      es: ['Batería baja', `La batería del dispositivo está al ${level}%.`],
      en: ['Low battery', `The device battery is at ${level}%.`],
    };
  },
  battery_critical(alert) {
    const level = firstNumber(alert.subtitle);
    if (!level) return null;
    return {
      es: ['Batería crítica', `La batería está al ${level}%. Conecte el dispositivo a un cargador.`],
      en: ['Critical battery', `The battery is at ${level}%. Plug the device into a charger.`],
    };
  },
  zone_enter(alert) {
    const zone = str(alert.zoneName);
    if (!zone) return null;
    return {
      es: [`Llegó a ${zone}`, `El dispositivo entró en la zona segura "${zone}".`],
      en: [`Arrived at ${zone}`, `The device entered the safe zone "${zone}".`],
    };
  },
  zone_exit(alert) {
    const zone = str(alert.zoneName);
    if (!zone) return null;
    return {
      es: [`Salió de ${zone}`, `El dispositivo salió de la zona segura "${zone}".`],
      en: [`Left ${zone}`, `The device left the safe zone "${zone}".`],
    };
  },
  speed(alert) {
    const kmh = firstNumber(alert.subtitle);
    if (!kmh) return null;
    return {
      es: ['Exceso de velocidad', `Velocidad detectada: ${kmh} km/h`],
      en: ['Speeding', `Speed detected: ${kmh} km/h`],
    };
  },
  location_permission_revoked: () => ({
    es: ['Permiso de ubicación retirado', 'Se retiró el permiso de ubicación de Vesta Tracker en el dispositivo.'],
    en: ['Location permission removed', "Vesta Tracker's location permission was removed on the device."],
  }),
  location_disabled: () => ({
    es: ['Ubicación desactivada', 'Se desactivó la ubicación del dispositivo. El mapa dejará de actualizarse.'],
    en: ['Location turned off', 'Location was turned off on the device. The map will stop updating.'],
  }),
  location_enabled: () => ({
    es: ['Ubicación reactivada', 'El dispositivo vuelve a compartir su ubicación.'],
    en: ['Location back on', 'The device is sharing its location again.'],
  }),
  offline_period(alert) {
    const minutes = offlineMinutes(alert);
    if (minutes === null) return null;
    const ms = minutes * 60000;
    return {
      es: ['Dispositivo sin conexión', `El dispositivo estuvo sin internet durante ${formatDuration(ms, 'es')}. Ya volvió a conectarse.`],
      en: ['Device offline', `The device had no internet for ${formatDuration(ms, 'en')}. It is back online.`],
    };
  },
  device_offline(alert) {
    const minutes = offlineMinutes(alert);
    if (minutes === null) return null;
    return deviceOfflineText(minutes * 60000);
  },
  blocked_app(alert) {
    const app = afterColon(alert.subtitle);
    if (!app) return null;
    return {
      es: ['Aplicación bloqueada', `Intentó abrir: ${app}`],
      en: ['App blocked', `Tried to open: ${app}`],
    };
  },
  blocked_domain(alert) {
    const domain = str(alert.domain) || afterColon(alert.subtitle);
    if (!domain) return null;
    return {
      es: ['Acceso bloqueado', `Intentó acceder a: ${domain}`],
      en: ['Access blocked', `Tried to access: ${domain}`],
    };
  },
  app_limit_reached(alert) {
    const app = limitApp(alert.subtitle);
    if (!app) return null;
    return {
      es: ['Tiempo diario agotado', `Usó todo el tiempo de hoy en ${app}`],
      en: ['Daily time used up', `Used all of today's time on ${app}`],
    };
  },
  study_mode_block(alert) {
    const app = afterColon(alert.subtitle);
    if (!app) return null;
    return {
      es: ['Intento de uso en modo estudio', `Intentó abrir: ${app}`],
      en: ['Attempted use in study mode', `Tried to open: ${app}`],
    };
  },
  vpn_revoked: () => ({
    es: ['Filtro web desactivado', 'Se desconectó la protección DNS de Vesta en el dispositivo.'],
    en: ['Web filter turned off', 'Vesta DNS protection was disconnected on the device.'],
  }),
  accessibility_disabled: () => ({
    es: ['Bloqueo de apps desactivado', 'Se desactivó el servicio de accesibilidad de Vesta en el dispositivo.'],
    en: ['App blocking turned off', "Vesta's accessibility service was turned off on the device."],
  }),
  sos(alert) {
    const located = Number.isFinite(alert.lat) && Number.isFinite(alert.lng);
    return {
      es: ['SOS: necesita ayuda', located
        ? 'Pulsó el botón de emergencia. Toca para ver su ubicación.'
        : 'Pulsó el botón de emergencia en su teléfono.'],
      en: ['SOS: needs help', located
        ? 'Pressed the emergency button. Tap to see their location.'
        : 'Pressed the emergency button on their phone.'],
    };
  },
};

function deviceOfflineText(ms) {
  return {
    es: ['Dispositivo sin conexión', `Vesta Tracker no envía datos desde hace ${formatDuration(ms, 'es')}. ` +
      'Puede estar apagado, sin batería, sin internet o con la app detenida.'],
    en: ['Device offline', `Vesta Tracker has not sent data for ${formatDuration(ms, 'en')}. ` +
      'It may be switched off, out of battery, without internet or with the app stopped.'],
  };
}

const FALLBACK = {
  es: { minor: 'Menor', title: 'Incidente detectado', body: 'Vesta ha registrado una alerta.' },
  en: { minor: 'Minor', title: 'Incident detected', body: 'Vesta has recorded an alert.' },
};

/** Title and body of an alert in `lang`. */
function alertText(alert, lang) {
  const builder = ALERTS[alert.eventKey];
  let texts = null;
  try {
    texts = builder ? builder(alert) : null;
  } catch (_) {
    texts = null;
  }
  if (texts) return { title: texts[lang][0], body: texts[lang][1] };
  return {
    title: str(alert.title) || FALLBACK[lang].title,
    body: str(alert.subtitle) || FALLBACK[lang].body,
  };
}

function minorName(child, lang) {
  return str(child?.nombre) || FALLBACK[lang].minor;
}

/** Push for a minor's pending request. */
function requestText(request, name, lang) {
  const en = lang === 'en';
  const app = String(
    request.appName || request.packageName || (en ? 'an app' : 'una app')
  ).slice(0, 100);
  const minutes = request.minutes;
  const verb = request.type === 'extra_time'
    ? (en ? `asks for ${minutes} more min of ${app}` : `pide ${minutes} min más de ${app}`)
    : (en ? `asks to use ${app} for ${minutes} min` : `pide usar ${app} durante ${minutes} min`);
  const message = request.message ? String(request.message).slice(0, 200) : null;
  return {
    title: `🙋 ${name} ${verb}`,
    body: message
      ? `"${message}" · ${en ? 'Tap to answer' : 'Toca para responder'}`
      : (en ? 'Tap to approve or reject.' : 'Toca para aprobar o rechazar.'),
  };
}

/** Push for the weekly summary. */
function weeklySummaryText(summary, name, lang) {
  const en = lang === 'en';
  const parts = [];
  if (summary.usage?.daysWithData) {
    const daily = formatHours(summary.usage.averageDailyMs);
    parts.push(en ? `${daily}/day of screen time` : `${daily}/día de pantalla`);
    const top = summary.usage.topApps[0];
    if (top) parts.push(en ? `most used: ${top.appName}` : `más usada: ${top.appName}`);
  }
  const total = summary.alerts.total;
  const critical = summary.alerts.byType.critical;
  if (total === 0) {
    parts.push(en ? 'no alerts' : 'sin alertas');
  } else if (en) {
    parts.push(`${total} ${total === 1 ? 'alert' : 'alerts'} (${critical} critical)`);
  } else {
    parts.push(`${total} ${total === 1 ? 'alerta' : 'alertas'} (${critical} ${critical === 1 ? 'crítica' : 'críticas'})`);
  }
  return {
    title: en ? `📊 ${name}'s weekly summary` : `📊 Resumen semanal de ${name}`,
    body: parts.join(' · '),
  };
}

module.exports = {
  LANGS,
  DEFAULT_LANG,
  normalizeLang,
  formatDuration,
  formatHours,
  alertText,
  deviceOfflineText,
  minorName,
  requestText,
  weeklySummaryText,
};
