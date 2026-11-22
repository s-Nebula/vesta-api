const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const childrenRouter = require('./routes/children');
const devicesRouter = require('./routes/devices');
const privacyRouter = require('./routes/privacy');
const { ServiceError } = require('./services/child_service');

const app = express();
app.set('trust proxy', 'loopback');

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // A Tracker checks its authorisation every minute; several families may
  // share an IP (NAT). 300 per 15 min leaves headroom without allowing abuse.
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'too-many-requests',
    message: 'Demasiadas solicitudes. Inténtalo más tarde.',
  },
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'vesta-api' });
});

app.use('/api', apiLimiter);
app.use('/api/children', childrenRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/privacy', privacyRouter);

app.use((req, res) => {
  res.status(404).json({
    error: 'not-found',
    message: 'Endpoint no encontrado.',
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof ServiceError) {
    return res.status(error.status).json({
      error: error.code,
      message: error.message,
    });
  }

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'invalid-json',
      message: 'El cuerpo JSON no es válido.',
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'payload-too-large',
      message: 'La solicitud supera el tamaño permitido.',
    });
  }

  console.error('Error interno de API:', error.message);

  return res.status(500).json({
    error: 'internal',
    message: 'Error interno del servidor.',
  });
});

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`Vesta API escuchando en ${HOST}:${PORT}`);
  });

  // Push notifications and monitoring of disconnected devices.
  // Can be turned off with VESTA_ALERT_DISPATCH=0 (e.g. if an equivalent
  // Cloud Function is ever deployed).
  let dispatcher = null;
  if (process.env.VESTA_ALERT_DISPATCH !== '0') {
    const { admin, db } = require('./config/firebase');
    const { createAlertDispatcher } = require('./services/alert_dispatcher');
    dispatcher = createAlertDispatcher({
      db,
      messaging: admin.messaging(),
      FieldValue: admin.firestore.FieldValue,
    });
    dispatcher.start();
  }

  const shutdown = () => {
    dispatcher?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
