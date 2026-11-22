const crypto = require('node:crypto');
const { db, admin } = require('../config/firebase');

const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

// A linking code is valid for 24 h. If it expires, the guardian generates
// another one from the app (POST /api/children/:id/pairing-code).
const PAIRING_CODE_TTL_MS = 24 * 60 * 60 * 1000;

function pairingExpiry() {
  return Timestamp.fromMillis(Date.now() + PAIRING_CODE_TTL_MS);
}

/** Expiry of a reservation; old ones without `expiresAt` use `createdAt`. */
function reservationExpiresAtMs(reservation) {
  const explicit = reservation?.expiresAt?.toMillis?.();
  if (typeof explicit === 'number') return explicit;
  const created = reservation?.createdAt?.toMillis?.();
  return typeof created === 'number' ? created + PAIRING_CODE_TTL_MS : 0;
}

function assertNotExpired(reservation) {
  if (reservationExpiresAtMs(reservation) <= Date.now()) {
    throw new ServiceError(
      410,
      'deadline-exceeded',
      'El código ha caducado. Pide al tutor que genere uno nuevo en Vesta.'
    );
  }
}

const DENIED_PRIVACY_AUTHORIZATION = Object.freeze({
  status: 'blocked',
  policy: 'all_guardians_must_authorize',
  purposes: Object.freeze({
    location: false,
    device_status: false,
    usage_stats: false,
    app_filtering: false,
    domain_filtering: false,
    alerts: false,
  }),
  guardianCount: 0,
});

class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function generatePairingCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

function validateChildData(data) {
  const nombre = String(data?.nombre || '').trim();
  const edad = data?.edad;
  const color = data?.color;

  if (!nombre || nombre.length > 80) {
    throw new ServiceError(400, 'invalid-argument', 'Nombre no válido.');
  }

  if (!Number.isSafeInteger(edad) || edad < 0) {
    throw new ServiceError(400, 'invalid-argument', 'Edad no válida.');
  }

  if (!Number.isSafeInteger(color) || color < 0 || color > 0xFFFFFFFF) {
    throw new ServiceError(400, 'invalid-argument', 'Color no válido.');
  }

  return { nombre, edad, color };
}

async function createChild(uid, data) {
  const { nombre, edad, color } = validateChildData(data);
  const childRef = db.collection('children').doc();

  for (let attempt = 0; attempt < 10; attempt++) {
    const pairingCode = generatePairingCode();
    const codeRef = db.collection('pairing_codes').doc(pairingCode);

    const created = await db.runTransaction(async (transaction) => {
      const codeSnap = await transaction.get(codeRef);

      if (codeSnap.exists) return false;

      const expiresAt = pairingExpiry();

      transaction.create(codeRef, {
        childId: childRef.id,
        status: 'available',
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
      });

      transaction.create(childRef, {
        nombre,
        edad,
        color,
        status: 'esperando_vinculacion',
        pairingCode,
        pairingCodeExpiresAt: expiresAt,
        deviceId: null,
        deviceUid: null,
        parentIds: [uid],
        privacyAuthorization: {
          ...DENIED_PRIVACY_AUTHORIZATION,
          purposes: { ...DENIED_PRIVACY_AUTHORIZATION.purposes },
          updatedAt: FieldValue.serverTimestamp(),
        },
        createdAt: FieldValue.serverTimestamp(),
        linkedAt: null,
      });

      return true;
    });

    if (created) {
      return { childId: childRef.id, pairingCode };
    }
  }

  throw new ServiceError(
    500,
    'internal',
    'No se pudo generar un código de vinculación único.'
  );
}

async function linkDevice(uid, inputCode) {
  const code = String(inputCode || '').trim().toUpperCase();

  if (!/^[A-F0-9]{10}$/.test(code)) {
    throw new ServiceError(400, 'invalid-argument', 'Código no válido.');
  }

  const codeRef = db.collection('pairing_codes').doc(code);
  const initialReservation = await codeRef.get();

  if (
    !initialReservation.exists ||
    initialReservation.data().status !== 'available'
  ) {
    throw new ServiceError(
      404,
      'not-found',
      'Código incorrecto, inexistente o ya utilizado.'
    );
  }

  assertNotExpired(initialReservation.data());

  const childId = initialReservation.data().childId;

  if (typeof childId !== 'string' || !childId) {
    throw new ServiceError(
      409,
      'failed-precondition',
      'La reserva de vinculación no es válida.'
    );
  }

  const childRef = db.collection('children').doc(childId);
  const deviceRef = db.collection('devices').doc(uid);

  await db.runTransaction(async (transaction) => {
    const reservationSnap = await transaction.get(codeRef);
    const childSnap = await transaction.get(childRef);
    const deviceSnap = await transaction.get(deviceRef);

    if (
      !reservationSnap.exists ||
      reservationSnap.data().status !== 'available' ||
      reservationSnap.data().childId !== childId
    ) {
      throw new ServiceError(
        409,
        'failed-precondition',
        'El código ya fue utilizado o no está disponible.'
      );
    }

    assertNotExpired(reservationSnap.data());

    if (!childSnap.exists) {
      throw new ServiceError(404, 'not-found', 'Perfil no encontrado.');
    }

    const child = childSnap.data();

    if (
      child.pairingCode !== code ||
      child.status !== 'esperando_vinculacion'
    ) {
      throw new ServiceError(
        409,
        'failed-precondition',
        'Este perfil ya tiene un dispositivo vinculado o el código ha cambiado.'
      );
    }

    if (deviceSnap.exists && deviceSnap.data().status === 'vinculado') {
      throw new ServiceError(
        409,
        'failed-precondition',
        'Este dispositivo ya está vinculado a otro perfil.'
      );
    }

    transaction.update(childRef, {
      status: 'vinculado',
      deviceId: uid,
      deviceUid: uid,
      linkedAt: FieldValue.serverTimestamp(),
      privacyAuthorization: {
        ...DENIED_PRIVACY_AUTHORIZATION,
        purposes: { ...DENIED_PRIVACY_AUTHORIZATION.purposes },
        updatedAt: FieldValue.serverTimestamp(),
      },
    });

    transaction.set(deviceRef, {
      childId,
      deviceUid: uid,
      status: 'vinculado',
      linkedAt: FieldValue.serverTimestamp(),
    });

    transaction.update(codeRef, {
      status: 'consumed',
      consumedBy: uid,
      consumedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(
      db.collection('telemetria').doc(childId),
      {
        status: 'pendiente',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  // Recompute permissions with the current consents.
  const { recalculateChildPrivacyAuthorization } =
    require('./privacy_service');
  await recalculateChildPrivacyAuthorization(childId);

  return { childId, status: 'vinculado' };
}

async function unlinkDevice(uid, childIdInput) {
  const childId = String(childIdInput || '').trim();

  if (!childId || childId.length > 150) {
    throw new ServiceError(400, 'invalid-argument', 'Falta childId válido.');
  }

  const childRef = db.collection('children').doc(childId);

  for (let attempt = 0; attempt < 10; attempt++) {
    const pairingCode = generatePairingCode();
    const codeRef = db.collection('pairing_codes').doc(pairingCode);

    const unlinked = await db.runTransaction(async (transaction) => {
      const childSnap = await transaction.get(childRef);
      const codeSnap = await transaction.get(codeRef);

      if (codeSnap.exists) return false;

      if (!childSnap.exists) {
        throw new ServiceError(404, 'not-found', 'Perfil no encontrado.');
      }

      const child = childSnap.data();

      if (
        !Array.isArray(child.parentIds) ||
        !child.parentIds.includes(uid)
      ) {
        throw new ServiceError(403, 'permission-denied', 'Acceso denegado.');
      }

      if (child.status !== 'vinculado' || !child.deviceUid) {
        throw new ServiceError(
          409,
          'failed-precondition',
          'Este perfil no tiene un dispositivo vinculado.'
        );
      }

      const oldDeviceUid = child.deviceUid;
      const expiresAt = pairingExpiry();

      transaction.create(codeRef, {
        childId,
        status: 'available',
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
      });

      transaction.update(childRef, {
        status: 'esperando_vinculacion',
        pairingCode,
        pairingCodeExpiresAt: expiresAt,
        deviceId: null,
        deviceUid: null,
        linkedAt: null,
        privacyAuthorization: {
          ...DENIED_PRIVACY_AUTHORIZATION,
          purposes: { ...DENIED_PRIVACY_AUTHORIZATION.purposes },
          updatedAt: FieldValue.serverTimestamp(),
        },
        unlinkedAt: FieldValue.serverTimestamp(),
      });

      transaction.set(
        db.collection('devices').doc(oldDeviceUid),
        {
          status: 'desvinculado',
          childId: null,
          unlinkedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      transaction.set(
        db.collection('telemetria').doc(childId),
        {
          status: 'desvinculado',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return true;
    });

    if (unlinked) {
      return { success: true, pairingCode };
    }
  }

  throw new ServiceError(
    500,
    'internal',
    'No se pudo generar un nuevo código de vinculación.'
  );
}

function normalizeChildId(childIdInput) {
  const childId = String(childIdInput || '').trim();

  if (!childId || childId.length > 150 || childId.includes('/')) {
    throw new ServiceError(400, 'invalid-argument', 'Falta childId válido.');
  }

  return childId;
}

function assertParentOf(child, uid) {
  if (!Array.isArray(child.parentIds) || !child.parentIds.includes(uid)) {
    throw new ServiceError(403, 'permission-denied', 'Acceso denegado.');
  }
}

/**
 * Validates a partial profile update. Only fields the guardian may edit
 * are accepted; the rest (status, link, guardians, privacy) can never be
 * changed this way.
 */
function validateChildUpdate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ServiceError(400, 'invalid-argument', 'Datos no válidos.');
  }

  const allowed = ['nombre', 'edad', 'color'];
  const unknown = Object.keys(data).filter((key) => !allowed.includes(key));

  if (unknown.length > 0) {
    throw new ServiceError(
      400,
      'invalid-argument',
      'Se recibieron campos que no se pueden editar.'
    );
  }

  const keys = Object.keys(data);

  if (keys.length === 0) {
    throw new ServiceError(400, 'invalid-argument', 'No hay cambios que guardar.');
  }

  // Reuse the same rules as when creating the profile.
  const merged = validateChildData({
    nombre: 'nombre' in data ? data.nombre : 'x',
    edad: 'edad' in data ? data.edad : 0,
    color: 'color' in data ? data.color : 0,
  });

  return Object.fromEntries(keys.map((key) => [key, merged[key]]));
}

async function updateChild(uid, childIdInput, data) {
  const childId = normalizeChildId(childIdInput);
  const changes = validateChildUpdate(data);
  const childRef = db.collection('children').doc(childId);

  await db.runTransaction(async (transaction) => {
    const childSnap = await transaction.get(childRef);

    if (!childSnap.exists) {
      throw new ServiceError(404, 'not-found', 'Perfil no encontrado.');
    }

    assertParentOf(childSnap.data(), uid);

    transaction.update(childRef, {
      ...changes,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    });
  });

  return { success: true, childId, ...changes };
}

/**
 * Generates a new linking code for a profile that has no device yet.
 * The previous code is invalidated.
 */
async function regeneratePairingCode(uid, childIdInput) {
  const childId = normalizeChildId(childIdInput);
  const childRef = db.collection('children').doc(childId);

  for (let attempt = 0; attempt < 10; attempt++) {
    const pairingCode = generatePairingCode();
    const codeRef = db.collection('pairing_codes').doc(pairingCode);

    const created = await db.runTransaction(async (transaction) => {
      const childSnap = await transaction.get(childRef);
      const codeSnap = await transaction.get(codeRef);

      if (!childSnap.exists) {
        throw new ServiceError(404, 'not-found', 'Perfil no encontrado.');
      }

      const child = childSnap.data();
      assertParentOf(child, uid);

      if (child.status !== 'esperando_vinculacion') {
        throw new ServiceError(
          409,
          'failed-precondition',
          'El perfil ya tiene un dispositivo vinculado.'
        );
      }

      if (codeSnap.exists) return false;

      const oldCode = typeof child.pairingCode === 'string'
        ? child.pairingCode
        : null;

      if (oldCode && /^[A-F0-9]{10}$/.test(oldCode)) {
        const oldRef = db.collection('pairing_codes').doc(oldCode);
        const oldSnap = await transaction.get(oldRef);

        if (
          oldSnap.exists &&
          oldSnap.data().status === 'available' &&
          oldSnap.data().childId === childId
        ) {
          transaction.update(oldRef, {
            status: 'revoked',
            revokedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      const expiresAt = pairingExpiry();

      transaction.create(codeRef, {
        childId,
        status: 'available',
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
      });

      transaction.update(childRef, {
        pairingCode,
        pairingCodeExpiresAt: expiresAt,
        pairingCodeUpdatedAt: FieldValue.serverTimestamp(),
      });

      return true;
    });

    if (created) return { childId, pairingCode };
  }

  throw new ServiceError(
    500,
    'internal',
    'No se pudo generar un nuevo código de vinculación.'
  );
}

module.exports = {
  PAIRING_CODE_TTL_MS,
  reservationExpiresAtMs,
  ServiceError,
  generatePairingCode,
  validateChildData,
  validateChildUpdate,
  createChild,
  updateChild,
  regeneratePairingCode,
  linkDevice,
  unlinkDevice,
};
