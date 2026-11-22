const express = require('express');
const router = express.Router();

const { authenticate, requireParent } = require('../middleware/auth');
const { deleteAccount } = require('../services/account_service');

// Deletes the guardian's account and data (Google Play account deletion
// requirement). Needs a recent sign-in; see account_service.
router.delete('/', authenticate, requireParent, async (req, res, next) => {
  try {
    res.json(await deleteAccount(req.auth.uid, req.auth.decoded));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
