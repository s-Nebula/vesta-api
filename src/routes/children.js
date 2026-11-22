const express = require('express');
const router = express.Router();

const {
  createChild,
  updateChild,
  regeneratePairingCode,
  unlinkDevice,
} = require('../services/child_service');

const {
  authenticate,
  requireParent,
} = require('../middleware/auth');

router.post('/', authenticate, requireParent, async (req, res, next) => {
  try {
    const result = await createChild(req.auth.uid, req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.post(
  '/:childId/unlink',
  authenticate,
  requireParent,
  async (req, res, next) => {
    try {
      const result = await unlinkDevice(req.auth.uid, req.params.childId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Edit profile data (name, age, colour).
router.patch(
  '/:childId',
  authenticate,
  requireParent,
  async (req, res, next) => {
    try {
      const result = await updateChild(
        req.auth.uid,
        req.params.childId,
        req.body
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// New linking code (invalidates the previous one). Also used by the QR.
router.post(
  '/:childId/pairing-code',
  authenticate,
  requireParent,
  async (req, res, next) => {
    try {
      const result = await regeneratePairingCode(
        req.auth.uid,
        req.params.childId
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
