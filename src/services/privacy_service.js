const { db, admin } = require('../config/firebase');
const { ServiceError } = require('./child_service');

const FieldValue = admin.firestore.FieldValue;

const TERMS_VERSION =
  process.env.VESTA_TERMS_VERSION || '1.0.0-draft';

const PRIVACY_VERSION =
  process.env.VESTA_PRIVACY_VERSION || '1.0.0-draft';

const PURPOSES = Object.freeze([
  'location',
  'device_status',
  'usage_stats',
  'app_filtering',
  'domain_filtering',
  'alerts',
]);

const MINOR_PARTICIPATION = Object.freeze([
  'informed',
  'heard',
  'not_applicable',
]);

function validateConsentInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ServiceError(400, 'invalid-argument', 'Datos no válidos.');
  }

  // Never record acceptances while the documents are still drafts.
  if (
    TERMS_VERSION.toLowerCase().includes('draft') ||
    PRIVACY_VERSION.toLowerCase().includes('draft')
  ) {
    throw new ServiceError(
      409,
      'failed-precondition',
      'Los documentos legales todavía están pendientes de aprobación.'
    );
  }

  if (
    data.termsVersion !== TERMS_VERSION ||
    data.privacyVersion !== PRIVACY_VERSION
  ) {
    throw new ServiceError(
      409,
      'failed-precondition',
      'Las versiones de los documentos no coinciden con las vigentes.'
    );
  }

  if (data.acceptTerms !== true || data.acknowledgePrivacy !== true) {
    throw new ServiceError(
      400,
      'invalid-argument',
      'Debes aceptar los términos y confirmar la lectura de privacidad.'
    );
  }

  if (data.guardianDeclaration !== true) {
    throw new ServiceError(
      400,
      'invalid-argument',
      'Se requiere la declaración de responsabilidad del tutor.'
    );
  }

  if (
    !data.purposes ||
    typeof data.purposes !== 'object' ||
    Array.isArray(data.purposes)
  ) {
    throw new ServiceError(
      400,
      'invalid-argument',
      'Debes especificar las finalidades del tratamiento.'
    );
  }

  for (const purpose of PURPOSES) {
    if (typeof data.purposes[purpose] !== 'boolean') {
      throw new ServiceError(
        400,
        'invalid-argument',
        `La finalidad ${purpose} debe tener un valor booleano.`
      );
    }
  }

  const unknownPurposes = Object.keys(data.purposes)
    .filter((purpose) => !PURPOSES.includes(purpose));

  if (unknownPurposes.length > 0) {
    throw new ServiceError(
      400,
      'invalid-argument',
      'Se recibieron finalidades desconocidas.'
    );
  }

  if (!MINOR_PARTICIPATION.includes(data.minorParticipation)) {
    throw new ServiceError(
      400,
      'invalid-argument',
      'La participación del menor no tiene un valor válido.'
    );
  }

  return {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    acceptTerms: true,
    acknowledgePrivacy: true,
    guardianDeclaration: true,
    minorParticipation: data.minorParticipation,
    purposes: Object.fromEntries(
      PURPOSES.map((purpose) => [purpose, data.purposes[purpose]])
    ),
  };
}

function userRef(uid) {
  return db.collection('users').doc(uid);
}

function deniedPurposes() {
  return Object.fromEntries(PURPOSES.map((purpose) => [purpose, false]));
}

/**
 * Recomputes a minor's permissions using the current consent of all
 * their guardians. The write happens in a transaction.
 */
async function recalculateChildPrivacyAuthorization(childId) {
  const childRef = db.collection('children').doc(childId);

  return db.runTransaction(async (transaction) => {
    const childSnap = await transaction.get(childRef);

    if (!childSnap.exists) return null;

    const child = childSnap.data();
    const parentIds = Array.isArray(child.parentIds)
      ? [...new Set(child.parentIds.filter(
          (uid) => typeof uid === 'string' && uid.trim()
        ))]
      : [];

    let purposes = deniedPurposes();

    if (parentIds.length > 0) {
      const consentSnapshots = [];

      for (const uid of parentIds) {
        const ref = db.collection('users')
          .doc(uid)
          .collection('privacy_consents')
          .doc('current');

        consentSnapshots.push(await transaction.get(ref));
      }

      const validConsents = consentSnapshots.map((snapshot) => {
        if (!snapshot.exists) return null;

        const consent = snapshot.data();
        const valid =
          consent.revocationPending !== true &&
          ['active', 'partially_revoked'].includes(consent.status) &&
          consent.termsVersion === TERMS_VERSION &&
          consent.privacyVersion === PRIVACY_VERSION &&
          consent.acceptTerms === true &&
          consent.acknowledgePrivacy === true &&
          consent.guardianDeclaration === true;

        return valid ? consent : null;
      });

      purposes = Object.fromEntries(
        PURPOSES.map((purpose) => [
          purpose,
          validConsents.length === parentIds.length &&
          validConsents.every(
            (consent) => consent?.purposes?.[purpose] === true
          ),
        ])
      );
    }

    const linked = child.status === 'vinculado' &&
      typeof child.deviceUid === 'string' &&
      child.deviceUid.length > 0;

    const authorized = linked && Object.values(purposes).some(Boolean);

    transaction.set(childRef, {
      privacyAuthorization: {
        status: authorized ? 'authorized' : 'blocked',
        policy: 'all_guardians_must_authorize',
        purposes: linked ? purposes : deniedPurposes(),
        guardianCount: parentIds.length,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        updatedAt: FieldValue.serverTimestamp(),
      },
    }, { merge: true });

    return {
      status: authorized ? 'authorized' : 'blocked',
      purposes: linked ? purposes : deniedPurposes(),
    };
  });
}

/**
 * Updates every minor associated with a guardian.
 */
async function recalculateChildrenForParent(uid) {
  const snapshot = await db.collection('children')
    .where('parentIds', 'array-contains', uid)
    .get();

  for (const child of snapshot.docs) {
    await recalculateChildPrivacyAuthorization(child.id);
  }

  return snapshot.size;
}

async function acceptConsent(uid, input) {
  const consent = validateConsentInput(input);
  const currentRef = userRef(uid)
    .collection('privacy_consents')
    .doc('current');

  const eventRef = userRef(uid)
    .collection('privacy_events')
    .doc();

  const now = FieldValue.serverTimestamp();

  await db.runTransaction(async (transaction) => {
    transaction.set(currentRef, {
      ...consent,
      status: 'active',
      revocationPending: false,
      revocationId: null,
      revokedPurposes: [],
      acceptedAt: now,
      updatedAt: now,
    });

    transaction.create(eventRef, {
      eventType: 'consent_accepted',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
      purposes: consent.purposes,
      minorParticipation: consent.minorParticipation,
      createdAt: now,
    });
  });

  await recalculateChildrenForParent(uid);

  return {
    success: true,
    status: 'active',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    purposes: consent.purposes,
  };
}

async function getConsent(uid) {
  const snapshot = await userRef(uid)
    .collection('privacy_consents')
    .doc('current')
    .get();

  if (!snapshot.exists) {
    return {
      exists: false,
      valid: false,
      currentVersions: {
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
      },
      consent: null,
    };
  }

  const consent = snapshot.data();

  const valid =
    consent.revocationPending !== true &&
    ['active', 'partially_revoked'].includes(consent.status) &&
    consent.termsVersion === TERMS_VERSION &&
    consent.privacyVersion === PRIVACY_VERSION &&
    consent.acceptTerms === true &&
    consent.acknowledgePrivacy === true &&
    consent.guardianDeclaration === true;

  return {
    exists: true,
    valid,
    currentVersions: {
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    },
    consent,
  };
}

async function revokeConsent(uid, purpose) {
  if (typeof purpose !== 'string' ||
      (!PURPOSES.includes(purpose) && purpose !== 'all')) {
    throw new ServiceError(
      400,
      'invalid-argument',
      'La finalidad que deseas revocar no es válida.'
    );
  }

  const currentRef = userRef(uid)
    .collection('privacy_consents')
    .doc('current');
  const eventRef = userRef(uid)
    .collection('privacy_events')
    .doc();

  // Phase 1: set the block before recomputing profiles.
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(currentRef);

    if (!snapshot.exists) {
      throw new ServiceError(
        404,
        'not-found',
        'No existe un consentimiento registrado.'
      );
    }

    const current = snapshot.data();

    if (current.status === 'revoked') {
      throw new ServiceError(
        409,
        'failed-precondition',
        'El consentimiento ya está revocado.'
      );
    }

    transaction.update(currentRef, {
      revocationPending: true,
      revocationId: eventRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // While the mark is set, recomputation denies every purpose.
  await recalculateChildrenForParent(uid);

  // Phase 2: finish only if this operation is still the current one.
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(currentRef);

    if (
      !snapshot.exists ||
      snapshot.data().revocationId !== eventRef.id
    ) {
      throw new ServiceError(
        409,
        'aborted',
        'La operación de revocación fue reemplazada por un cambio posterior.'
      );
    }

    const current = snapshot.data();
    const purposes = { ...(current.purposes || {}) };

    if (purpose === 'all') {
      for (const key of PURPOSES) {
        purposes[key] = false;
      }
    } else {
      purposes[purpose] = false;
    }

    const allRevoked = PURPOSES.every(
      (key) => purposes[key] === false
    );

    transaction.update(currentRef, {
      purposes,
      status: allRevoked ? 'revoked' : 'partially_revoked',
      revocationPending: false,
      revocationId: FieldValue.delete(),
      revokedPurposes: purpose === 'all'
        ? PURPOSES
        : FieldValue.arrayUnion(purpose),
      updatedAt: FieldValue.serverTimestamp(),
      revokedAt: FieldValue.serverTimestamp(),
    });

    transaction.create(eventRef, {
      eventType: purpose === 'all'
        ? 'consent_fully_revoked'
        : 'consent_purpose_revoked',
      purpose,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  // Update the final state of every associated profile.
  await recalculateChildrenForParent(uid);

  return {
    success: true,
    revoked: purpose,
  };
}
async function getDevicePrivacyStatus(deviceUid) {
  if (typeof deviceUid !== 'string' || !deviceUid.trim()) {
    throw new ServiceError(
      400,
      'invalid-argument',
      'Identificador de dispositivo no válido.'
    );
  }

  const deviceRef = db.collection('devices').doc(deviceUid);
  const deviceSnap = await deviceRef.get();

  // Explicit "not linked" answer. The Tracker tells it apart from a
  // network failure and clears its local state instead of retrying forever.
  const unlinkedResponse = (reason) => ({
    linked: false,
    authorized: false,
    status: 'unlinked',
    reason,
    purposes: deniedPurposes(),
    policy: 'all_guardians_must_authorize',
  });

  if (!deviceSnap.exists) {
    return unlinkedResponse('device_not_found');
  }

  if (deviceSnap.data().status === 'desvinculado') {
    return unlinkedResponse('unlinked_by_guardian');
  }

  if (
    deviceSnap.data().status !== 'vinculado' ||
    deviceSnap.data().deviceUid !== deviceUid ||
    typeof deviceSnap.data().childId !== 'string' ||
    !deviceSnap.data().childId
  ) {
    throw new ServiceError(
      403,
      'permission-denied',
      'El dispositivo no tiene una vinculación válida.'
    );
  }

  const childId = deviceSnap.data().childId;
  const childRef = db.collection('children').doc(childId);
  const childSnap = await childRef.get();

  if (!childSnap.exists) {
    return unlinkedResponse('profile_deleted');
  }

  if (childSnap.data().deviceUid !== deviceUid) {
    // The profile was linked to another device after this one.
    return unlinkedResponse('replaced_by_another_device');
  }

  const child = childSnap.data();
  const parentIds = Array.isArray(child.parentIds)
    ? [...new Set(child.parentIds.filter(
        (uid) => typeof uid === 'string' && uid.trim()
      ))]
    : [];

  if (
    child.status !== 'vinculado' ||
    child.deviceUid !== deviceUid ||
    parentIds.length === 0
  ) {
    throw new ServiceError(
      403,
      'permission-denied',
      'La vinculación o los tutores del perfil no son válidos.'
    );
  }

  const consentRefs = parentIds.map((uid) =>
    db.collection('users')
      .doc(uid)
      .collection('privacy_consents')
      .doc('current')
  );

  const consentSnapshots = await db.getAll(...consentRefs);

  // Deny by default: every guardian must have a valid consent
  // and authorise each purpose individually.
  const validConsents = consentSnapshots.map((snapshot) => {
    if (!snapshot.exists) return null;

    const consent = snapshot.data();
    const valid =
      consent.revocationPending !== true &&
      ['active', 'partially_revoked'].includes(consent.status) &&
      consent.termsVersion === TERMS_VERSION &&
      consent.privacyVersion === PRIVACY_VERSION &&
      consent.acceptTerms === true &&
      consent.acknowledgePrivacy === true &&
      consent.guardianDeclaration === true;

    return valid ? consent : null;
  });

  const purposes = Object.fromEntries(
    PURPOSES.map((purpose) => [
      purpose,
      validConsents.length === parentIds.length &&
      validConsents.every(
        (consent) => consent?.purposes?.[purpose] === true
      ),
    ])
  );

  return {
    linked: true,
    childId,
    authorized: Object.values(purposes).some(Boolean),
    status: Object.values(purposes).some(Boolean)
      ? 'authorized'
      : 'blocked',
    purposes,
    policy: 'all_guardians_must_authorize',
  };
}

module.exports = {
  TERMS_VERSION,
  PRIVACY_VERSION,
  PURPOSES,
  validateConsentInput,
  acceptConsent,
  getConsent,
  revokeConsent,
  getDevicePrivacyStatus,
  recalculateChildPrivacyAuthorization,
  recalculateChildrenForParent,
}
