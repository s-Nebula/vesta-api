const crypto = require('node:crypto');
const { db, admin, auth } = require('../config/firebase');
const { ServiceError } = require('./child_service');
const { recalculateChildPrivacyAuthorization } = require('./privacy_service');

const FieldValue = admin.firestore.FieldValue;

// Deleting the account is irreversible, so it needs a fresh sign-in:
// the ID token must come from a login (or re-authentication) at most this
// long ago. The app re-authenticates the guardian right before calling.
const RECENT_LOGIN_MS = 5 * 60 * 1000;

function assertRecentLogin(decodedToken, now = Date.now()) {
  const authTimeMs = Number(decodedToken?.auth_time) * 1000;

  if (!Number.isFinite(authTimeMs) || authTimeMs <= 0 || now - authTimeMs > RECENT_LOGIN_MS) {
    throw new ServiceError(
      401,
      'requires-recent-login',
      'Por seguridad, vuelve a iniciar sesión antes de eliminar la cuenta.'
    );
  }
}

/**
 * Takes the guardian out of one profile. If other guardians remain, the
 * profile stays with them; if this was the only guardian, the profile and
 * everything recorded for it is deleted and its device is unlinked.
 * Returns 'kept' or 'deleted'.
 */
async function detachOrDeleteChild(uid, childRef) {
  const outcome = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(childRef);
    if (!snap.exists) return { result: 'gone' };

    const child = snap.data();
    const parentIds = Array.isArray(child.parentIds) ? child.parentIds : [];
    const others = parentIds.filter((id) => id !== uid);

    if (others.length > 0) {
      transaction.update(childRef, {
        parentIds: FieldValue.arrayRemove(uid),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { result: 'kept' };
    }

    if (typeof child.deviceUid === 'string' && child.deviceUid) {
      // Same state unlinkDevice leaves: the Tracker sees it is no longer linked.
      transaction.set(
        db.collection('devices').doc(child.deviceUid),
        {
          status: 'desvinculado',
          childId: null,
          unlinkedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return { result: 'deleted' };
  });

  if (outcome.result === 'kept') {
    // With one guardian fewer, the remaining guardians' consents decide.
    await recalculateChildPrivacyAuthorization(childRef.id);
    return 'kept';
  }

  if (outcome.result === 'deleted') {
    const codes = await db.collection('pairing_codes')
      .where('childId', '==', childRef.id)
      .get();
    await Promise.all(codes.docs.map((doc) => doc.ref.delete()));

    await db.recursiveDelete(db.collection('telemetria').doc(childRef.id));
    await db.recursiveDelete(childRef);
    return 'deleted';
  }

  return 'gone';
}

/**
 * Deletes a guardian account: their profiles (or their place in shared
 * profiles), their user document with tokens and consents, and the
 * Firebase Authentication user. Leaves only an anonymous record that the
 * deletion was carried out (no uid, e-mail or name).
 */
async function deleteAccount(uid, decodedToken, { authClient = auth } = {}) {
  if (typeof uid !== 'string' || !uid) {
    throw new ServiceError(400, 'invalid-argument', 'Usuario no válido.');
  }

  assertRecentLogin(decodedToken);

  const children = await db.collection('children')
    .where('parentIds', 'array-contains', uid)
    .get();

  let profilesDeleted = 0;
  let profilesKept = 0;

  for (const doc of children.docs) {
    const result = await detachOrDeleteChild(uid, doc.ref);
    if (result === 'deleted') profilesDeleted++;
    if (result === 'kept') profilesKept++;
  }

  await db.recursiveDelete(db.collection('users').doc(uid));

  await db.collection('account_deletions').add({
    subjectHash: crypto.createHash('sha256').update(uid).digest('hex'),
    profilesDeleted,
    profilesKept,
    deletedAt: FieldValue.serverTimestamp(),
  });

  try {
    await authClient.deleteUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }

  return { success: true, profilesDeleted, profilesKept };
}

module.exports = {
  RECENT_LOGIN_MS,
  assertRecentLogin,
  deleteAccount,
};
