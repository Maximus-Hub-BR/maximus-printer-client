/**
 * Teste da fila de impressão — `node src/fila-impressao.test.js`.
 *
 * Sem Electron, sem impressora, sem rede: a fila recebe as duas pontas por
 * injeção, então o que se prova aqui é a REGRA. E a regra tem três promessas
 * que, se quebrarem, aparecem no papel da expedição e não num log:
 * nenhuma etiqueta se perde, nenhuma sai fora de ordem, e toda uma recebe ACK.
 */
const assert = require('assert');
const { criarFilaDeImpressao, chaveDoDestino } = require('./fila-impressao');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

/** Monta o ambiente: registra os lotes impressos e os ACKs publicados. */
function montar({ falhar = () => false, duracaoMs = 0, maxPorLote } = {}) {
  const lotes = [];
  const acks = [];
  const fila = criarFilaDeImpressao({
    maxPorLote,
    imprimir: async (lote) => {
      if (duracaoMs) await pausa(duracaoMs);
      const uuids = lote.map((i) => i.job.job_uuid);
      if (falhar(lote)) {
        lotes.push({ uuids, ok: false });
        throw new Error(`falha simulada em ${uuids.join(',')}`);
      }
      lotes.push({ uuids, ok: true });
    },
    confirmar: (item, status, erro) => acks.push({ uuid: item.job.job_uuid, status, erro }),
  });
  return { fila, lotes, acks };
}

const job = (uuid, over = {}) => ({
  job_uuid: uuid,
  type: 'pdf',
  data: '',
  printer_system_name: 'Zebra',
  ...over,
});

// ── o caso comum: uma etiqueta avulsa ──────────────────────────────────────
teste('etiqueta única imprime na hora, sem esperar nada', async () => {
  const { fila, lotes, acks } = montar();
  await fila.enfileirar(job('a'), 9);
  assert.deepStrictEqual(lotes, [{ uuids: ['a'], ok: true }]);
  assert.deepStrictEqual(acks, [{ uuid: 'a', status: 'success', erro: null }]);
});

/**
 * ⚠️ O ponto do recurso. Enquanto o primeiro lote está na impressora, os que
 * chegam se acumulam — e saem JUNTOS, numa chamada só. Sem isto, cada
 * etiqueta pagaria de novo o custo de abrir a impressora, que é a pausa que
 * a expedição reclamou.
 */
teste('rajada durante a impressão vira UM lote', async () => {
  const { fila, lotes, acks } = montar({ duracaoMs: 20 });
  const primeira = fila.enfileirar(job('a'), 9);
  // Chegam enquanto 'a' imprime.
  fila.enfileirar(job('b'), 9);
  fila.enfileirar(job('c'), 9);
  fila.enfileirar(job('d'), 9);
  await primeira;

  assert.deepStrictEqual(lotes, [
    { uuids: ['a'], ok: true },
    { uuids: ['b', 'c', 'd'], ok: true },
  ]);
  assert.strictEqual(acks.length, 4);
  assert.ok(acks.every((a) => a.status === 'success'));
});

teste('a ORDEM de chegada é a ordem do papel', async () => {
  const { fila, lotes } = montar({ duracaoMs: 10 });
  const p = fila.enfileirar(job('1'), 9);
  for (const u of ['2', '3', '4', '5']) fila.enfileirar(job(u), 9);
  await p;
  assert.deepStrictEqual(lotes.flatMap((l) => l.uuids), ['1', '2', '3', '4', '5']);
});

// ── destinos ───────────────────────────────────────────────────────────────
teste('impressoras diferentes NÃO entram no mesmo lote', async () => {
  const { fila, lotes } = montar({ duracaoMs: 10 });
  const p = fila.enfileirar(job('a', { printer_system_name: 'Zebra' }), 9);
  fila.enfileirar(job('b', { printer_system_name: 'Zebra' }), 9);
  fila.enfileirar(job('c', { printer_system_name: 'Argox' }), 9);
  await p;
  await pausa(40);
  const comAmbas = lotes.find((l) => l.uuids.includes('c'));
  assert.deepStrictEqual(comAmbas.uuids, ['c']);
});

/** ⚠️ A escala vale para o DOCUMENTO: juntar escalas diferentes é impossível. */
teste('escalas diferentes NÃO entram no mesmo lote', () => {
  assert.notStrictEqual(
    chaveDoDestino(job('a', { escala: 'label' })),
    chaveDoDestino(job('b', { escala: 'fit' })),
  );
});

teste('ZPL e PDF nunca se misturam', () => {
  assert.notStrictEqual(chaveDoDestino(job('a', { type: 'zpl' })), chaveDoDestino(job('b')));
});

// ── falha ──────────────────────────────────────────────────────────────────
/**
 * ⚠️ A promessa que protege a expedição: um PDF corrompido no meio não pode
 * derrubar as outras 24. O lote falho é refeito uma a uma e só a culpada
 * recebe ACK de erro.
 */
teste('lote que falha é refeito uma a uma; só a culpada erra', async () => {
  const { fila, lotes, acks } = montar({
    duracaoMs: 10,
    falhar: (lote) => lote.some((i) => i.job.job_uuid === 'ruim'),
  });
  const p = fila.enfileirar(job('a'), 9);
  fila.enfileirar(job('b'), 9);
  fila.enfileirar(job('ruim'), 9);
  fila.enfileirar(job('c'), 9);
  await p;
  await pausa(80);

  const porUuid = Object.fromEntries(acks.map((a) => [a.uuid, a.status]));
  assert.strictEqual(porUuid.b, 'success');
  assert.strictEqual(porUuid.c, 'success');
  assert.strictEqual(porUuid.ruim, 'error');
  // O lote de 3 foi tentado e depois cada uma sozinha.
  assert.ok(lotes.some((l) => l.uuids.length === 3 && !l.ok));
  assert.ok(lotes.some((l) => l.uuids.length === 1 && l.uuids[0] === 'ruim' && !l.ok));
});

/** Job sem ACK fica preso para sempre na tela do operador. */
teste('TODO job recebe ACK, mesmo quando tudo falha', async () => {
  const { fila, acks } = montar({ duracaoMs: 5, falhar: () => true });
  const p = fila.enfileirar(job('a'), 9);
  fila.enfileirar(job('b'), 9);
  await p;
  await pausa(60);
  assert.deepStrictEqual(acks.map((a) => a.uuid).sort(), ['a', 'b']);
  assert.ok(acks.every((a) => a.status === 'error' && a.erro));
});

// ── tetos e frestas ────────────────────────────────────────────────────────
teste('o lote respeita o teto e o excedente sai no ciclo seguinte', async () => {
  const { fila, lotes } = montar({ duracaoMs: 10, maxPorLote: 3 });
  const p = fila.enfileirar(job('1'), 9);
  for (const u of ['2', '3', '4', '5', '6', '7']) fila.enfileirar(job(u), 9);
  await p;
  await pausa(60);
  assert.ok(lotes.every((l) => l.uuids.length <= 3));
  assert.deepStrictEqual(
    lotes.flatMap((l) => l.uuids),
    ['1', '2', '3', '4', '5', '6', '7'],
  );
});

/**
 * ⚠️ A fresta do `finally`: job que chega entre o fim do laço e a baixa do
 * `rodando` encontraria a fila "ocupada" e ficaria parado até o PRÓXIMO
 * chegar — uma etiqueta presa sem erro nenhum.
 */
teste('job que chega no fecho do ciclo não fica preso', async () => {
  const { fila, lotes } = montar({ duracaoMs: 5 });
  await fila.enfileirar(job('a'), 9);
  // Fila já ociosa: o próximo tem de disparar sozinho.
  await fila.enfileirar(job('b'), 9);
  assert.deepStrictEqual(lotes.flatMap((l) => l.uuids), ['a', 'b']);
  assert.deepStrictEqual(fila.pendentes(), { 'pdf|Zebra|||': 0 });
});

teste('nada fica pendente ao fim de uma rajada', async () => {
  const { fila, acks } = montar({ duracaoMs: 3 });
  const p = fila.enfileirar(job('1'), 9);
  for (let i = 2; i <= 30; i++) fila.enfileirar(job(String(i)), 9);
  await p;
  await pausa(80);
  assert.strictEqual(acks.length, 30);
  assert.ok(Object.values(fila.pendentes()).every((n) => n === 0));
});

(async () => {
  /*
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 11 ETIQUETAS PARA 6 PEDIDOS — o mesmo job por dois caminhos
 * ══════════════════════════════════════════════════════════════════════════
 * Medido no print.log da RDF em 31/10/2026: o MQTT publicou 6 e o pull
 * entregou as mesmas 6 no mesmo segundo (nenhuma tinha ACK ainda). As duas
 * cópias entraram na fila e o papel saiu em dobro — 11 ACKs para 6 uuids.
 */

teste('🚨 o MESMO job_uuid não entra duas vezes na fila', async () => {
  const { fila, lotes } = montar();
  const primeira = fila.enfileirar(job('u-1'), 9);
  fila.enfileirar(job('u-1'), 9);   // mesma entrega, outro caminho
  await primeira;
  await pausa(30);
  const saidas = lotes.flatMap((l) => l.uuids);
  assert.deepStrictEqual(saidas, ['u-1'], `saiu em dobro: ${JSON.stringify(saidas)}`);
});

teste('🚨 seis pedidos por DOIS caminhos continuam seis etiquetas', async () => {
  const { fila, lotes } = montar({ duracaoMs: 20 });
  const seis = ['a', 'b', 'c', 'd', 'e', 'f'];
  const primeira = fila.enfileirar(job('a'), 9);
  for (const u of seis.slice(1)) fila.enfileirar(job(u), 9);  // MQTT
  for (const u of seis) fila.enfileirar(job(u), 9);           // pull, no mesmo instante
  await primeira;
  await pausa(60);
  const saidas = lotes.flatMap((l) => l.uuids);
  assert.strictEqual(saidas.length, 6, `esperava 6, saíram ${saidas.length}: ${saidas}`);
  assert.deepStrictEqual([...saidas].sort(), seis);
});

teste('⚠️ jobs DIFERENTES continuam entrando (a dedupe não pode segurar a fila)', async () => {
  const { fila, lotes } = montar({ duracaoMs: 10 });
  const primeira = fila.enfileirar(job('x'), 9);
  fila.enfileirar(job('y'), 9);
  fila.enfileirar(job('z'), 9);
  await primeira;
  await pausa(40);
  assert.deepStrictEqual(lotes.flatMap((l) => l.uuids).sort(), ['x', 'y', 'z']);
});

teste('🚨 depois de IMPRESSO, o mesmo uuid pode voltar (o pull reoferece)', async () => {
  const { fila, lotes } = montar();
  await fila.enfileirar(job('u-2'), 9);
  await pausa(20);
  await fila.enfileirar(job('u-2'), 9);
  await pausa(20);
  assert.strictEqual(
    lotes.flatMap((l) => l.uuids).length, 2,
    'a dedupe vale enquanto o job está NA fila, não para sempre',
  );
});

teste('🚨 job que FALHOU libera o uuid (preso seria PERDA, pior que duplicata)', async () => {
  const { fila, lotes } = montar({ falhar: () => true });
  await fila.enfileirar(job('u-3'), 9);
  await pausa(20);
  await fila.enfileirar(job('u-3'), 9);
  await pausa(20);
  assert.ok(
    lotes.flatMap((l) => l.uuids).length >= 2,
    'depois de falhar, a etiqueta tem de poder voltar',
  );
});

/*
 * `ocupada()` — é o que decide se o cliente pode se reiniciar para instalar
 * uma versão crítica. Reiniciar no meio de um lote custa etiquetas.
 */

teste('🚨 ocupada() enxerga o lote EM VOO, não só a fila de espera', async () => {
  const { fila } = montar({ duracaoMs: 40 });
  assert.strictEqual(fila.ocupada(), false, 'começa livre');
  const p = fila.enfileirar(job('a'), 9);
  // Agora o job saiu de `pendentes` pelo splice e está imprimindo: se
  // `ocupada` olhasse só a fila de espera, diria "livre" no pior momento.
  assert.strictEqual(fila.ocupada(), true, 'imprimindo tem de contar como ocupada');
  await p;
  await pausa(30);
  assert.strictEqual(fila.ocupada(), false, 'terminou, pode reiniciar');
});

teste('⚠️ ocupada() volta a false mesmo quando o job FALHA', async () => {
  // Senão uma falha deixaria a máquina marcada como ocupada para sempre e
  // ela nunca mais se atualizaria.
  const { fila } = montar({ falhar: () => true });
  await fila.enfileirar(job('b'), 9);
  await pausa(30);
  assert.strictEqual(fila.ocupada(), false);
});

for (const [nome, fn] of casos) {
    try {
      await fn();
      passaram++;
      console.log(`  ✓ ${nome}`);
    } catch (erro) {
      console.error(`  ✗ ${nome}\n    ${erro.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passaram}/${casos.length} casos`);
})();
