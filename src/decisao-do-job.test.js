/**
 * O que fazer com um job que chegou — a regra que a 1.0.22 tinha em DOIS
 * lugares, com respostas opostas. Ver o cabeçalho de `decisao-do-job.js`.
 *
 * O primeiro caso é o defeito medido em produção em 31/10/2026: a etiqueta
 * em DÚVIDA era descartada como "já impressa" e nunca saía no papel.
 */
const assert = require('assert');
const { decidirSobreJob, aplicarDecisaoDoJob } = require('./decisao-do-job');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

teste('🚨 job em DÚVIDA é IMPRESSO, não descartado como já impresso', () => {
  // O defeito: `jaImprimiu` dava true para `enviando` e o `enfileirar`
  // pulava a impressão. 3 ciclos de pull seguidos, ENSAIO-45-01 nunca saiu.
  assert.strictEqual(
    decidirSobreJob({ estado: 'enviando', podeReimprimir: true }),
    'reimprimir',
  );
});

teste('job que JÁ SAIU no papel não é impresso de novo (falta notícia, não papel)', () => {
  assert.strictEqual(
    decidirSobreJob({ estado: 'impresso', podeReimprimir: false }),
    'ja_impresso',
  );
});

teste('⚠️ `impresso` nunca é reimpresso, mesmo se o teto permitisse', () => {
  // Blinda contra o inverso do defeito: colar etiqueta errada no pacote.
  assert.strictEqual(
    decidirSobreJob({ estado: 'impresso', podeReimprimir: true }),
    'ja_impresso',
  );
});

teste('job nunca visto é trabalho NOVO', () => {
  assert.strictEqual(decidirSobreJob({ estado: null, podeReimprimir: true }), 'imprimir');
  assert.strictEqual(decidirSobreJob({ estado: undefined, podeReimprimir: false }), 'imprimir');
  assert.strictEqual(decidirSobreJob({}), 'imprimir');
});

teste('🚨 dúvida com o TETO esgotado vira CONFERÊNCIA, nunca sucesso', () => {
  // Confirmar como impressa o que talvez não tenha saído a faria SUMIR da
  // tela — e aí a perda volta a ser silenciosa.
  assert.strictEqual(
    decidirSobreJob({ estado: 'enviando', podeReimprimir: false }),
    'esgotado',
  );
});

teste('⚠️ estado DESCONHECIDO cai no caminho que tem freio e desfecho visível', () => {
  // Nem 'imprimir' (ignoraria o teto) nem 'ja_impresso' (repetiria o defeito).
  assert.strictEqual(
    decidirSobreJob({ estado: 'coisa-que-nao-existe', podeReimprimir: true }),
    'reimprimir',
  );
  assert.strictEqual(
    decidirSobreJob({ estado: 'coisa-que-nao-existe', podeReimprimir: false }),
    'esgotado',
  );
});

teste('a decisão NÃO depende de mais nada além do estado e do teto', () => {
  // Se um campo novo mudar o resultado, a regra deixou de ser esta.
  const a = decidirSobreJob({ estado: 'enviando', podeReimprimir: true });
  const b = decidirSobreJob({
    estado: 'enviando', podeReimprimir: true,
    confirmado: true, status: 'success', em: 1, tentativas: 99,
  });
  assert.strictEqual(a, b);
});

teste('só existem quatro vereditos', () => {
  const vistos = new Set();
  for (const estado of [null, 'impresso', 'enviando', 'xpto']) {
    for (const pode of [true, false]) vistos.add(decidirSobreJob({ estado, podeReimprimir: pode }));
  }
  assert.deepStrictEqual(
    [...vistos].sort(),
    ['esgotado', 'imprimir', 'ja_impresso', 'reimprimir'],
  );
});

/*
 * ══════════════════════════════════════════════════════════════════════════
 * O EFEITO, não a presença do código
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ Estes casos existem por uma medição: ao reintroduzir o defeito de
 * propósito, os 29 casos estruturais do `main.js` passaram todos — eles
 * conferem se o trecho está escrito, não o que ele faz. "Desfiz e nada
 * quebrou" é achado, não alívio. Aqui a asserção é sobre o EFEITO: a
 * etiqueta foi para a fila, ou não foi.
 */
function bancada (decisao) {
  const efeitos = { impressos: [], logs: [], acks: 0, marcados: [], salvou: 0, reconfirmados: [] };
  const registro = {
    precisaReconfirmar: (u) => { efeitos.reconfirmados.push(u); return true; },
    marcarImpresso: (u, st, er) => efeitos.marcados.push({ u, st, er }),
    salvar: () => { efeitos.salvou += 1; },
  };
  const devolvido = aplicarDecisaoDoJob({
    job: { job_uuid: 'u-1' },
    userId: 7,
    decisao,
    registro,
    imprimir: (j, u) => efeitos.impressos.push({ uuid: j.job_uuid, userId: u }),
    registrar: (m) => efeitos.logs.push(m),
    agendarAcks: () => { efeitos.acks += 1; },
  });
  return { efeitos, devolvido };
}

teste('🚨 EFEITO: a etiqueta em dúvida VAI para a fila', () => {
  const { efeitos } = bancada('reimprimir');
  assert.deepStrictEqual(efeitos.impressos, [{ uuid: 'u-1', userId: 7 }]);
  // E não é marcada como impressa ainda — quem faz isso é a fila, depois.
  assert.deepStrictEqual(efeitos.marcados, []);
});

teste('🚨 EFEITO: o que já saiu NÃO vai para a fila, e é reconfirmado', () => {
  const { efeitos } = bancada('ja_impresso');
  assert.deepStrictEqual(efeitos.impressos, [], 'reimprimir aqui é colar etiqueta errada no pacote');
  assert.deepStrictEqual(efeitos.reconfirmados, ['u-1']);
  assert.strictEqual(efeitos.acks, 1, 'o que falta é o Hub saber');
});

teste('🚨 EFEITO: teto esgotado NÃO imprime e marca ERRO com instrução', () => {
  const { efeitos } = bancada('esgotado');
  assert.deepStrictEqual(efeitos.impressos, []);
  assert.strictEqual(efeitos.marcados.length, 1);
  assert.strictEqual(efeitos.marcados[0].st, 'error', 'sucesso aqui faria a perda voltar a ser silenciosa');
  assert.ok(/confira o papel/.test(efeitos.marcados[0].er), 'a pessoa precisa saber o que fazer');
  assert.strictEqual(efeitos.salvou, 1, 'sem salvar, o desfecho morre no próximo fechamento');
});

teste('EFEITO: job novo vai para a fila sem tocar o registro', () => {
  const { efeitos } = bancada('imprimir');
  assert.deepStrictEqual(efeitos.impressos, [{ uuid: 'u-1', userId: 7 }]);
  assert.deepStrictEqual(efeitos.marcados, []);
  assert.deepStrictEqual(efeitos.reconfirmados, []);
  assert.strictEqual(efeitos.acks, 0);
});

teste('⚠️ a reimpressão por DÚVIDA aparece no log (o operador precisa entender o papel)', () => {
  const { efeitos } = bancada('reimprimir');
  assert.ok(efeitos.logs.some((l) => /DÚVIDA/.test(l)), `logs: ${JSON.stringify(efeitos.logs)}`);
});

teste('aplicarDecisaoDoJob devolve a decisão que aplicou', () => {
  for (const d of ['imprimir', 'reimprimir', 'ja_impresso', 'esgotado']) {
    assert.strictEqual(bancada(d).devolvido, d);
  }
});

teste('🚨 EFEITO ponta a ponta: dúvida que CABE no teto imprime; sem teto, não', () => {
  // A cadeia completa: decidir -> aplicar. É o caminho que falhou em produção.
  let imprimiuComTeto = false;
  const cabe = aplicarDecisaoDoJob({
    job: { job_uuid: 'u-2' }, userId: 1,
    decisao: decidirSobreJob({ estado: 'enviando', podeReimprimir: true }),
    registro: { precisaReconfirmar: () => true, marcarImpresso: () => {}, salvar: () => {} },
    imprimir: () => { imprimiuComTeto = true; }, registrar: () => {}, agendarAcks: () => {},
  });
  assert.strictEqual(cabe, 'reimprimir');
  assert.strictEqual(imprimiuComTeto, true, 'a dúvida dentro do teto TEM de imprimir');

  let imprimiu = false;
  const semTeto = aplicarDecisaoDoJob({
    job: { job_uuid: 'u-3' }, userId: 1,
    decisao: decidirSobreJob({ estado: 'enviando', podeReimprimir: false }),
    registro: { precisaReconfirmar: () => true, marcarImpresso: () => {}, salvar: () => {} },
    imprimir: () => { imprimiu = true; }, registrar: () => {}, agendarAcks: () => {},
  });
  assert.strictEqual(semTeto, 'esgotado');
  assert.strictEqual(imprimiu, false, 'esgotado não pode imprimir');
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
