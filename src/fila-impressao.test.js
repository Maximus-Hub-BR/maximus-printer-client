/**
 * Teste da fila de impressão — `node src/fila-impressao.test.js`.
 *
 * Sem Electron, sem impressora, sem rede: a fila recebe as duas pontas por
 * injeção, então o que se prova aqui é a REGRA. E a regra tem três promessas
 * que, se quebrarem, aparecem no papel da expedição e não num log:
 * nenhuma etiqueta se perde, nenhuma sai fora de ordem, e toda uma recebe ACK.
 */
const assert = require('assert');
const { criarFilaDeImpressao, chaveDoDestino, chaveDaImpressora } = require('./fila-impressao');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

/** Monta o ambiente: registra os lotes impressos e os ACKs publicados. */
function montar({ falhar = () => false, duracaoMs = 0, maxPorLote } = {}) {
  const lotes = [];
  const acks = [];
  /*
   * 🚨 Quantas chamadas estão DENTRO do `imprimir` ao mesmo tempo, por
   * impressora física. É o que o `lp` concorrente faz, e o que nenhum teste
   * media antes de 23/11/2026: a fila dizia "serializo" e serializava — por
   * destino, não por aparelho.
   */
  const dentro = new Map();
  /*
   * ⚠️ DOIS picos, porque são duas perguntas opostas:
   *   `pico`  — a MAIOR concorrência numa MESMA impressora. Tem de ser 1.
   *   `total` — quantas impressoras trabalham juntas. Tem de ser > 1 quando
   *             há mais de um aparelho, senão a correção virou fila única e
   *             a expedição perdeu o paralelismo das bancadas.
   * Medir só o primeiro deixaria passar exatamente esse estrago.
   */
  let emVoo = 0;
  const concorrencia = { pico: 0, total: 0, porImpressora: {} };
  const fila = criarFilaDeImpressao({
    maxPorLote,
    imprimir: async (lote) => {
      const alvo = aparelhoReal(lote[0].job);
      const agora = (dentro.get(alvo) || 0) + 1;
      dentro.set(alvo, agora);
      emVoo += 1;
      concorrencia.pico = Math.max(concorrencia.pico, agora);
      concorrencia.total = Math.max(concorrencia.total, emVoo);
      concorrencia.porImpressora[alvo] = Math.max(concorrencia.porImpressora[alvo] || 0, agora);
      try {
        if (duracaoMs) await pausa(duracaoMs);
      } finally {
        dentro.set(alvo, (dentro.get(alvo) || 1) - 1);
        emVoo -= 1;
      }
      const uuids = lote.map((i) => i.job.job_uuid);
      if (falhar(lote)) {
        lotes.push({ uuids, ok: false });
        const erro = new Error(`falha simulada em ${uuids.join(',')}`);
        erro.antesDoEnvio = true; // Este cenário representa preparo de PDF, sem bytes enviados.
        throw erro;
      }
      lotes.push({ uuids, ok: true });
    },
    confirmar: (item, status, erro) => acks.push({ uuid: item.job.job_uuid, status, erro }),
  });
  return { fila, lotes, acks, concorrencia };
}

/*
 * 🚨 O APARELHO FÍSICO, calculado NO TESTE — nunca por `chaveDaImpressora`.
 *
 * Medir a concorrência com a função sob teste foi um erro cometido em
 * 23/11/2026: com a porta dentro da chave, `onda` (sem porta) e `avulso`
 * (porta 9100) viravam dois contadores diferentes, cada um com pico 1 — e o
 * teste dava VERDE sobre exatamente o defeito que existia para provar. O
 * instrumento concorda com o erro quando compartilha a premissa dele.
 *
 * Aqui a regra é a física: o papel sai por SOCKET quando há host; sem host,
 * sai pela fila do CUPS, e `zpl_port` não toca em nada.
 */
const aparelhoReal = (j) =>
  j.zpl_host ? `socket:${j.zpl_host}` : `cups:${j.printer_system_name || ''}`;

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

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 UMA IMPRESSORA, UMA CONVERSA (23/11/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Estes casos são a prova do que a fila por DESTINO não garantia. Desfaça a
 * correção (volte o `enfileirar` a indexar por `chaveDoDestino`) e eles ficam
 * VERMELHOS — é o que os torna teste, e não enfeite.
 */
teste('🚨 destinos diferentes na MESMA impressora NÃO imprimem ao mesmo tempo', async () => {
  const { fila, concorrencia } = montar({ duracaoMs: 30 });
  // o que a expedição faz: a onda sai (PDF com escala) e alguém bipa no
  // picking (PDF sem escala). Mesma Zebra, destinos diferentes.
  const daOnda = fila.enfileirar(job('onda', { escala: 'label' }), 9);
  const doPicking = fila.enfileirar(job('picking'), 9);
  await Promise.all([daOnda, doPicking]);
  assert.strictEqual(concorrencia.pico, 1,
    `a mesma impressora recebeu ${concorrencia.pico} chamadas simultâneas`);
});

teste('🚨 ZPL e PDF na MESMA impressora também se esperam', async () => {
  const { fila, concorrencia } = montar({ duracaoMs: 30 });
  await Promise.all([
    fila.enfileirar(job('zpl', { type: 'zpl' }), 9),
    fila.enfileirar(job('pdf'), 9),
  ]);
  assert.strictEqual(concorrencia.pico, 1);
});

teste('🚨 onda e avulso na MESMA Zebra NÃO disputam o lp (a porta não separa)', async () => {
  const { fila, concorrencia } = montar({ duracaoMs: 30 });
  /*
   * O caso mais comum da expedição: a onda está saindo e alguém clica
   * "Imprimir" num pedido. O servidor manda a onda SEM host/porta e o avulso
   * COM `zpl_port: 9100` (destino-do-job.ts) — mas sem host nada vai por
   * socket: as duas saem pela MESMA fila do CUPS.
   */
  await Promise.all([
    fila.enfileirar(job('onda', { escala: 'label' }), 9),
    fila.enfileirar(job('avulso', { escala: 'label', zpl_host: null, zpl_port: 9100 }), 9),
  ]);
  assert.strictEqual(concorrencia.pico, 1,
    `onda e avulso rodaram juntos na mesma impressora (${concorrencia.pico} chamadas)`);
});

teste('⚠️ impressora de REDE (com host) continua sendo outro aparelho', async () => {
  const { fila, concorrencia } = montar({ duracaoMs: 30 });
  // prova NEGATIVA da regra acima: com host, o socket é o destino real, e uma
  // Zebra de rede não pode ser serializada contra a fila local do mesmo nome.
  await Promise.all([
    fila.enfileirar(job('local', {}), 9),
    fila.enfileirar(job('rede', { zpl_host: '10.1.1.50', zpl_port: 9100 }), 9),
  ]);
  assert.strictEqual(concorrencia.total, 2, 'a de rede e a local deviam ir em paralelo');
  assert.strictEqual(concorrencia.pico, 1);
});

teste('impressoras diferentes CONTINUAM em paralelo', async () => {
  const { fila, concorrencia } = montar({ duracaoMs: 30 });
  await Promise.all([
    fila.enfileirar(job('a', { printer_system_name: 'Zebra-1' }), 9),
    fila.enfileirar(job('b', { printer_system_name: 'Zebra-2' }), 9),
  ]);
  // prova POSITIVA: se a correção tivesse virado fila única, `total` daria 1 e
  // a expedição perderia o paralelismo das duas bancadas.
  assert.strictEqual(concorrencia.total, 2, 'as duas impressoras não trabalharam juntas');
  assert.strictEqual(concorrencia.pico, 1, 'nenhuma impressora recebeu duas chamadas');
  assert.strictEqual(concorrencia.porImpressora['cups:Zebra-1'], 1);
  assert.strictEqual(concorrencia.porImpressora['cups:Zebra-2'], 1);
});

teste('destinos intercalados saem na ORDEM de chegada, sem misturar o lote', async () => {
  const { fila, lotes } = montar({ duracaoMs: 20 });
  // [pdf, zpl, pdf] na mesma impressora: varrer por tipo mandaria os dois pdf
  // juntos e poria a 3ª no papel antes da 2ª.
  const todos = [
    fila.enfileirar(job('1'), 9),
    fila.enfileirar(job('2', { type: 'zpl' }), 9),
    fila.enfileirar(job('3'), 9),
  ];
  await Promise.all(todos);
  assert.deepStrictEqual(lotes.flatMap((l) => l.uuids), ['1', '2', '3']);
  for (const l of lotes) assert.strictEqual(l.uuids.length, 1, 'tipos não podem ir no mesmo lote');
});

teste('a rajada de MESMO destino continua virando UM lote', async () => {
  const { fila, lotes } = montar({ duracaoMs: 30 });
  const primeiro = fila.enfileirar(job('a'), 9);
  await pausa(5);
  const resto = [fila.enfileirar(job('b'), 9), fila.enfileirar(job('c'), 9)];
  await Promise.all([primeiro, ...resto]);
  // a economia de 09/10 não pode ter sido desfeita pela correção
  assert.deepStrictEqual(lotes.map((l) => l.uuids), [['a'], ['b', 'c']]);
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
  assert.deepStrictEqual(fila.pendentes(), { [chaveDaImpressora(job('zzz'))]: 0 });
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
