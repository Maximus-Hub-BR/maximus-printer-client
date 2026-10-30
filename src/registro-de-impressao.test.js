/**
 * Teste do registro local — `node src/registro-de-impressao.test.js`.
 *
 * Cada caso corresponde a uma forma de perder ou duplicar etiqueta medida no
 * incidente de 30/10/2026 (ver o cabeçalho do módulo).
 */
const assert = require('assert');
const { criarRegistroDeImpressao, HORAS_DE_MEMORIA } = require('./registro-de-impressao');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

function memoria(inicial = {}, agoraFn) {
  let disco = JSON.parse(JSON.stringify(inicial));
  let gravacoes = 0;
  const reg = criarRegistroDeImpressao({
    ler: () => JSON.parse(JSON.stringify(disco)),
    gravar: (d) => { disco = JSON.parse(JSON.stringify(d)); gravacoes++; },
    ...(agoraFn ? { agora: agoraFn } : {}),
  });
  return { reg, disco: () => disco, gravacoes: () => gravacoes };
}

teste('🚨 job já impresso é reconhecido — é o que impede a duplicata do pull', () => {
  const { reg } = memoria();
  assert.strictEqual(reg.jaImprimiu('u-1'), false);
  reg.marcarImpresso('u-1', 'success', null);
  assert.strictEqual(reg.jaImprimiu('u-1'), true);
});

teste('⚠️ job que FALHOU também conta como impresso (não se tenta de novo em silêncio)', () => {
  const { reg } = memoria();
  reg.marcarImpresso('u-2', 'error', 'sem papel');
  assert.strictEqual(reg.jaImprimiu('u-2'), true);
  assert.deepStrictEqual(reg.pendentesDeConfirmacao(), [
    { job_uuid: 'u-2', status: 'error', error: 'sem papel' },
  ]);
});

teste('o pendente de confirmação sai da lista quando o Hub aceita', () => {
  const { reg } = memoria();
  reg.marcarImpresso('u-1', 'success', null);
  assert.strictEqual(reg.pendentesDeConfirmacao().length, 1);
  reg.marcarConfirmado('u-1');
  assert.strictEqual(reg.pendentesDeConfirmacao().length, 0);
  // Mas continua lembrado — senão o pull o reimprimiria.
  assert.strictEqual(reg.jaImprimiu('u-1'), true);
});

teste('a ORDEM dos pendentes é a do papel (mais antigo primeiro)', () => {
  let t = 1000;
  const { reg } = memoria({}, () => (t += 1000));
  reg.marcarImpresso('u-b', 'success', null);
  reg.marcarImpresso('u-a', 'success', null);
  assert.deepStrictEqual(reg.pendentesDeConfirmacao().map((p) => p.job_uuid), ['u-b', 'u-a']);
});

teste('marcar duas vezes NÃO reescreve o instante (a poda depende dele)', () => {
  let t = 10000;
  const { reg, disco } = memoria({}, () => t);
  reg.marcarImpresso('u-1', 'success', null);
  reg.salvar();
  const primeiro = disco()['u-1'].em;
  t = 99999;
  reg.marcarImpresso('u-1', 'error', 'outro');
  reg.salvar();
  assert.strictEqual(disco()['u-1'].em, primeiro);
  assert.strictEqual(disco()['u-1'].status, 'success');
});

teste('🚨 a poda NUNCA leva ACK não confirmado', () => {
  const velho = Date.now() - (HORAS_DE_MEMORIA + 10) * 3600000;
  const { reg, disco } = memoria({
    'u-velho-pendente': { em: velho, status: 'success', erro: null, confirmado: false },
    'u-velho-ok': { em: velho, status: 'success', erro: null, confirmado: true },
  });
  reg.salvar();
  assert.ok(disco()['u-velho-pendente'], 'ACK pendente foi podado');
  assert.ok(!disco()['u-velho-ok'], 'confirmado antigo deveria sair');
});

teste('⚠️ a memória é MAIOR que a janela do Hub (2 h) — senão a duplicata volta', () => {
  assert.ok(HORAS_DE_MEMORIA > 2, `memória de ${HORAS_DE_MEMORIA}h`);
});

teste('arquivo corrompido não derruba nada: começa vazio', () => {
  const reg = criarRegistroDeImpressao({
    ler: () => { throw new Error('json inválido'); },
    gravar: () => {},
  });
  assert.strictEqual(reg.jaImprimiu('u-1'), false);
  reg.marcarImpresso('u-1', 'success', null);
  assert.strictEqual(reg.jaImprimiu('u-1'), true);
});

teste('⚠️ falha ao GRAVAR não derruba a impressão', () => {
  const reg = criarRegistroDeImpressao({
    ler: () => ({}),
    gravar: () => { throw new Error('disco cheio'); },
  });
  reg.marcarImpresso('u-1', 'success', null);
  assert.doesNotThrow(() => reg.salvar());
  assert.strictEqual(reg.jaImprimiu('u-1'), true);
});

teste('o registro sobrevive ao reinício (é o ponto de ter disco)', () => {
  const { reg, disco } = memoria();
  reg.marcarImpresso('u-1', 'success', null);
  reg.salvar();
  const segundo = criarRegistroDeImpressao({ ler: () => disco(), gravar: () => {} });
  assert.strictEqual(segundo.jaImprimiu('u-1'), true);
});

teste('uuid vazio é ignorado nas duas pontas', () => {
  const { reg } = memoria();
  reg.marcarImpresso('', 'success', null);
  reg.marcarImpresso(undefined, 'success', null);
  assert.strictEqual(reg.jaImprimiu(''), false);
  assert.strictEqual(reg.jaImprimiu(undefined), false);
  assert.strictEqual(reg.pendentesDeConfirmacao().length, 0);
});

teste('🚨 no main.js o require vem ANTES do uso (TDZ não aparece no --check)', () => {
  // Esta inversão aconteceu ao integrar o registro em 30/10/2026: o
  // `const { criarRegistroDeImpressao } = require(...)` ficou DEPOIS da
  // chamada, e `node --check` passou — o erro só apareceria ao abrir o app,
  // na máquina do cliente, como "ReferenceError: Cannot access before
  // initialization". Nenhuma etiqueta sairia.
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const doRequire = main.indexOf("require('./src/registro-de-impressao')");
  const doUso = main.indexOf('criarRegistroDeImpressao({');
  assert.ok(doRequire > 0, 'o require do registro desapareceu do main.js');
  assert.ok(doUso > 0, 'o registro não é mais criado no main.js');
  assert.ok(doRequire < doUso, 'o require precisa vir ANTES da chamada');
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
