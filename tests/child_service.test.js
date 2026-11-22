const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ServiceError,
  generatePairingCode,
  validateChildData,
} = require('../src/services/child_service');

test('genera códigos de vinculación de 10 caracteres hexadecimales', () => {
  const code = generatePairingCode();

  assert.match(code, /^[A-F0-9]{10}$/);
});

test('acepta datos válidos y limpia el nombre', () => {
  const result = validateChildData({
    nombre: '  Perfil de prueba  ',
    edad: 12,
    color: 4294967295,
  });

  assert.deepEqual(result, {
    nombre: 'Perfil de prueba',
    edad: 12,
    color: 4294967295,
  });
});

test('rechaza nombres vacíos', () => {
  assert.throws(
    () => validateChildData({ nombre: '   ', edad: 10, color: 1 }),
    (error) => error instanceof ServiceError && error.status === 400
  );
});

test('rechaza nombres de más de 80 caracteres', () => {
  assert.throws(
    () => validateChildData({ nombre: 'A'.repeat(81), edad: 10, color: 1 }),
    ServiceError
  );
});

test('rechaza edades negativas o que no sean enteros seguros', () => {
  for (const edad of [-1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateChildData({ nombre: 'Prueba', edad, color: 1 }),
      ServiceError
    );
  }
});
test('acepta edades enteras sin límite máximo de 18 años', () => {
  for (const edad of [0, 18, 19, 25, 80, 120]) {
    assert.equal(
      validateChildData({ nombre: 'Prueba', edad, color: 1 }).edad,
      edad
    );
  }
});

test('acepta los límites válidos de edad', () => {
  for (const edad of [0, 18]) {
    assert.equal(
      validateChildData({ nombre: 'Prueba', edad, color: 1 }).edad,
      edad
    );
  }
});

test('rechaza colores fuera del rango permitido', () => {
  for (const color of [-1, 4294967296, 1.5, '123', null]) {
    assert.throws(
      () => validateChildData({ nombre: 'Prueba', edad: 10, color }),
      ServiceError
    );
  }
});

test('acepta los límites válidos de color', () => {
  for (const color of [0, 4294967295]) {
    assert.equal(
      validateChildData({ nombre: 'Prueba', edad: 10, color }).color,
      color
    );
  }
});

const { validateChildUpdate } = require('../src/services/child_service');

test('validateChildUpdate acepta cambios parciales válidos', () => {
  assert.deepEqual(validateChildUpdate({ nombre: '  Ana ' }), { nombre: 'Ana' });
  assert.deepEqual(validateChildUpdate({ edad: 11, color: 5 }), { edad: 11, color: 5 });
});

test('validateChildUpdate rechaza campos protegidos, vacíos o inválidos', () => {
  for (const data of [
    {},
    null,
    [],
    { status: 'vinculado' },
    { parentIds: ['x'] },
    { nombre: '' },
    { edad: -1 },
    { color: 0x1FFFFFFFF },
  ]) {
    assert.throws(() => validateChildUpdate(data), (error) => error.status === 400);
  }
});
