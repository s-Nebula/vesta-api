const { auth } = require('../config/firebase');

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        error: 'unauthenticated',
        message: 'Se requiere un token de autenticación.',
      });
    }

    const decoded = await auth.verifyIdToken(match[1]);

    req.auth = {
      uid: decoded.uid,
      isAnonymous: decoded.firebase?.sign_in_provider === 'anonymous',
      decoded,
    };

    next();
  } catch {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'Token inválido o expirado.',
    });
  }
}

function requireParent(req, res, next) {
  if (req.auth.isAnonymous) {
    return res.status(403).json({
      error: 'permission-denied',
      message: 'Se requiere una cuenta de padre o tutor.',
    });
  }

  next();
}

function requireDevice(req, res, next) {
  if (!req.auth.isAnonymous) {
    return res.status(403).json({
      error: 'permission-denied',
      message: 'La vinculación requiere una sesión de dispositivo.',
    });
  }

  next();
}

module.exports = { authenticate, requireParent, requireDevice };
