/**
 * Teste do registro local — `node src/registro-de-impressao.test.js`.
 *
 * Cada caso corresponde a uma forma de perder ou duplicar etiqueta medida no
 * incidente de 30/10/2026 (ver o cabeçalho do módulo).
 */
const assert = require('assert');
const {
  criarRegistroDeImpressao,
  HORAS_DE_MEMORIA,
  HORAS_DE_DUVIDA,
} = require('./registro-de-impressao');

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

teste('🚨 `enviando` é gravado NA HORA (sobrevive ao fechamento do app)', () => {
  /*
   * O caso de 30/10/2026: a etiqueta foi entregue no destino, o app fechou
   * antes de o cliente registrar, e a recuperação imprimiu de novo. A
   * gravação do `enviando` não pode depender de debounce.
   */
  let gravacoes = 0;
  let disco = {};
  const reg = criarRegistroDeImpressao({
    ler: () => disco,
    gravar: (d) => { disco = JSON.parse(JSON.stringify(d)); gravacoes++; },
  });
  reg.marcarEnviando('u-1');
  assert.strictEqual(gravacoes, 1, 'o enviando não foi gravado imediatamente');
  assert.ok(disco['u-1'], 'o enviando não chegou ao disco');
  assert.strictEqual(disco['u-1'].estado, 'enviando');
});

teste('o estado avança de enviando para impresso', () => {
  const { reg } = memoria();
  reg.marcarEnviando('u-1');
  assert.strictEqual(reg.estadoDe('u-1'), 'enviando');
  reg.marcarImpresso('u-1', 'success', null);
  assert.strictEqual(reg.estadoDe('u-1'), 'impresso');
});

teste('⚠️ job em `enviando` NÃO é confirmado ao Hub (não sabemos se saiu)', () => {
  const { reg } = memoria();
  reg.marcarEnviando('u-1');
  assert.deepStrictEqual(reg.pendentesDeConfirmacao(), []);
  reg.marcarImpresso('u-1', 'success', null);
  assert.strictEqual(reg.pendentesDeConfirmacao().length, 1);
});

teste('🚨 reconfirmar DESMARCA o confirmado (o Hub provou que não recebeu)', () => {
  /*
   * Dois jobs ficaram voltando em TODO pull (23:03, 23:05, 23:07, 23:12…):
   * o cliente os tinha como confirmados porque o MQTT deu PUBACK — que prova
   * que o BROKER recebeu, não que o Hub registrou.
   */
  const { reg } = memoria();
  reg.marcarImpresso('u-1', 'success', null);
  reg.marcarConfirmado('u-1');
  assert.strictEqual(reg.pendentesDeConfirmacao().length, 0, 'devia estar confirmado');

  assert.strictEqual(reg.precisaReconfirmar('u-1'), true);
  assert.strictEqual(reg.pendentesDeConfirmacao().length, 1, 'não voltou para a fila de ACK');
});

teste('reconfirmar job desconhecido devolve false, sem criar entrada', () => {
  const { reg } = memoria();
  assert.strictEqual(reg.precisaReconfirmar('u-nunca-visto'), false);
  assert.strictEqual(reg.jaImprimiu('u-nunca-visto'), false);
});

teste('marcarEnviando não sobrescreve um job que JÁ saiu', () => {
  const { reg } = memoria();
  reg.marcarImpresso('u-1', 'success', null);
  reg.marcarEnviando('u-1');
  assert.strictEqual(reg.estadoDe('u-1'), 'impresso');
});

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 QUAL DÚVIDA O PULL DECLARA AO HUB (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * O Hub não sabe se o papel saiu; este registro sabe. Medido em dois ensaios
 * de queda com identidade por etiqueta: das 19 etiquetas recuperadas em cada
 * leva, **19 eram inéditas** — e saíram todas marcadas `REIMPRESSAO`, que é
 * convite ao descarte. `emEnviando()` é o que separa a dúvida real do resto.
 */

teste('🚨 emEnviando: job INÉDITO não entra na lista', () => {
  const { reg } = memoria();
  // Nunca vimos este job — e é o caso das 19 de cada leva.
  assert.deepStrictEqual(reg.emEnviando(), []);
});

teste('emEnviando: job IMPRESSO e confirmado não é dúvida', () => {
  const { reg } = memoria();
  reg.marcarEnviando('u-ok');
  reg.marcarImpresso('u-ok', 'success', null);
  reg.marcarConfirmado('u-ok');
  assert.deepStrictEqual(reg.emEnviando(), []);
});

teste('🚨 emEnviando: só o job que foi ao papel e não teve desfecho', () => {
  const { reg } = memoria();
  reg.marcarEnviando('u-duvida');          // o processo morreria exatamente aqui
  reg.marcarEnviando('u-saiu');
  reg.marcarImpresso('u-saiu', 'success', null);
  assert.deepStrictEqual(reg.emEnviando(), ['u-duvida']);
});

teste('emEnviando: job com ERRO não é dúvida (sabemos que NÃO saiu)', () => {
  const { reg } = memoria();
  reg.marcarEnviando('u-erro');
  reg.marcarImpresso('u-erro', 'error', 'sem papel');
  assert.deepStrictEqual(reg.emEnviando(), []);
});

teste('⚠️ emEnviando: tem teto e manda os MAIS RECENTES', () => {
  let t = 1000;
  const { reg } = memoria({}, () => (t += 1000));
  for (let i = 0; i < 30; i += 1) reg.marcarEnviando(`u-${i}`);
  const lista = reg.emEnviando(5);
  assert.strictEqual(lista.length, 5);
  // O teto existe porque a lista vai na URL e o servidor descarta lista
  // absurda INTEIRA; mandar os recentes preserva a marca no job da queda.
  assert.ok(lista.includes('u-29'), 'o mais recente tem de estar na lista');
  assert.ok(!lista.includes('u-0'), 'o mais antigo não deveria estar');
});

teste('🚨 emEnviando: sobrevive à leitura do DISCO (é o caso do crash)', () => {
  const { reg, disco } = memoria();
  reg.marcarEnviando('u-crash');
  // `marcarEnviando` grava na hora — é por isto que a dúvida sobrevive ao
  // processo morrer. Um segundo registro lendo o mesmo disco tem de vê-la.
  const segundo = criarRegistroDeImpressao({ ler: () => disco(), gravar: () => {} });
  assert.deepStrictEqual(segundo.emEnviando(), ['u-crash']);
});

teste('🚨 dúvida VENCIDA não é mais declarada (órfão não marca papel por engano)', () => {
  let t = 10 * 24 * 3600000;                 // um instante qualquer, longe de 0
  const { reg } = memoria({}, () => t);
  reg.marcarEnviando('u-velho');
  // Passam HORAS_DE_DUVIDA + 1 h. O pull do Hub só olha 2 h para trás, então
  // esta entrada já não pode voltar por ali — e deixar de ser dúvida é o
  // certo: se o job reaparecer por outro caminho, não leva marca.
  t += (HORAS_DE_DUVIDA + 1) * 3600000;
  assert.deepStrictEqual(reg.emEnviando(), []);
});

teste('dúvida DENTRO do prazo continua declarada', () => {
  let t = 10 * 24 * 3600000;
  const { reg } = memoria({}, () => t);
  reg.marcarEnviando('u-novo');
  t += (HORAS_DE_DUVIDA - 1) * 3600000;
  assert.deepStrictEqual(reg.emEnviando(), ['u-novo']);
});

teste('🚨 a PODA remove o `enviando` vencido (sem isto ele ficava para sempre)', () => {
  let t = 10 * 24 * 3600000;
  const { reg, disco } = memoria({}, () => t);
  reg.marcarEnviando('u-orfao');
  assert.ok(disco()['u-orfao'], 'deveria estar gravado');
  t += (HORAS_DE_DUVIDA + 1) * 3600000;
  reg.salvar();                              // `salvar` é quem poda
  assert.strictEqual(
    disco()['u-orfao'],
    undefined,
    'orfao em `enviando` nunca saía: a poda só olhava `confirmado`, e ele nasce false',
  );
});

teste('⚠️ a poda NÃO leva quem tem desfecho e ACK pendente (a regra original)', () => {
  let t = 10 * 24 * 3600000;
  const { reg, disco } = memoria({}, () => t);
  reg.marcarImpresso('u-sem-ack', 'success', null);   // desfecho, sem confirmar
  t += (HORAS_DE_MEMORIA + 1) * 3600000;
  reg.salvar();
  assert.ok(
    disco()['u-sem-ack'],
    'aquele ACK é a única notícia que o Hub vai receber — não pode ser podado',
  );
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
