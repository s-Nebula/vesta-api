const express = require('express');
const router = express.Router();

const {
  createChild,
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

module.exports = router;
