const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TERMS_VERSION,
  PRIVACY_VERSION,
  PURPOSES,
  validateConsentInput,
} = require('../src/services/privacy_service');

function validInput() {
  return {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    acceptTerms: true,
    acknowledgePrivacy: true,
    guardianDeclaration: true,
    minorParticipation: 'informed',
    purposes: Object.fromEntries(
      PURPOSES.map((purpose) => [purpose, true])
    ),
  };
}

test('acepta un consentimiento completo y válido', () => {
  const result = validateConsentInput(validInput());

  assert.equal(result.termsVersion, TERMS_VERSION);
  assert.equal(result.privacyVersion, PRIVACY_VERSION);
  assert.equal(result.guardianDeclaration, true);
  assert.equal(result.purposes.location, true);
});

test('permite seleccionar finalidades individualmente', () => {
  const input = validInput();
  input.purposes.location = true;
  input.purposes.usage_stats = false;

  const result = validateConsentInput(input);

  assert.equal(result.purposes.location, true);
  assert.equal(result.purposes.usage_stats, false);
});

test('rechaza versiones desactualizadas', () => {
  const input = validInput();
  input.termsVersion = 'version-antigua';

  assert.throws(
    () => validateConsentInput(input),
    (error) => error.status === 409
  );
});

test('rechaza la falta de aceptación de términos', () => {
  const input = validInput();
  input.acceptTerms = false;

  assert.throws(
    () => validateConsentInput(input),
    (error) => error.status === 400
  );
});

test('rechaza la falta de declaración del tutor', () => {
  const input = validInput();
  input.guardianDeclaration = false;

  assert.throws(
    () => validateConsentInput(input),
    (error) => error.status === 400
  );
});

test('rechaza finalidades incompletas', () => {
  const input = validInput();
  delete input.purposes.location;

  assert.throws(
    () => validateConsentInput(input),
    (error) => error.status === 400
  );
});

test('rechaza finalidades desconocidas', () => {
  const input = validInput();
  input.purposes.extra_data = true;

  assert.throws(
    () => validateConsentInput(input),
    (error) => error.status === 400
  );
});

test('rechaza valores de finalidad que no sean booleanos', () => {
  const input = validInput();
  input.purposes.location = 'sí';

  assert.throws(
    () => validateConsentInput(input),
    (error) => error.status === 400
  );
});

test('rechaza una participación del menor no válida', () => {
  const input = validInput();
  input.minorParticipation = 'unknown';

  assert.throws(
    () => validateConsentInput(input),
    (error) => error.status === 400
  );
});
