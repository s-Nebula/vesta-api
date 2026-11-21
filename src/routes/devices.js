const express = require('express');
const router = express.Router();

const { linkDevice } = require('../services/child_service');
const {
  getDevicePrivacyStatus,
} = require('../services/privacy_service');

const {
  authenticate,
  requireDevice,
} = require('../middleware/auth');

router.get('/privacy-status', authenticate, requireDevice, async (req, res, next) => {
  try {
    const result = await getDevicePrivacyStatus(req.auth.uid);
    res.json(result);
  } catch (error) {
    next(error);
  }
});
router.post('/link', authenticate, requireDevice, async (req, res, next) => {
  try {
    const result = await linkDevice(req.auth.uid, req.body?.pairingCode);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
