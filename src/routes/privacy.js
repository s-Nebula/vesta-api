const express = require('express');
const router = express.Router();

const {
  authenticate,
  requireParent,
} = require('../middleware/auth');

const {
  acceptConsent,
  getConsent,
  revokeConsent,
} = require('../services/privacy_service');

router.use(authenticate, requireParent);

router.get('/status', async (req, res, next) => {
  try {
    res.json(await getConsent(req.auth.uid));
  } catch (error) {
    next(error);
  }
});

router.post('/consent', async (req, res, next) => {
  try {
    const result = await acceptConsent(req.auth.uid, req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/revoke', async (req, res, next) => {
  try {
    const result = await revokeConsent(
      req.auth.uid,
      req.body?.purpose
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
