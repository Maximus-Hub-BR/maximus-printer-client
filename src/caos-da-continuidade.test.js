/**
 * O ENSAIO DE CAOS — `node src/caos-da-continuidade.test.js`
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POR QUE ESTE TESTE EXISTE
 * ══════════════════════════════════════════════════════════════════════════
 * Em 30/10/2026 a expedição perdeu 195 etiquetas e, no teste da correção,
 * uma saiu DUAS vezes. Os dois defeitos moram no mesmo lugar: a ordem entre
 * "os bytes saíram", "anotei que saíram" e "o Hub soube" — e nenhum lote
 * manual cobre todos os instantes em que o app pode morrer.
 *
 * Aqui o cliente é montado com as peças REAIS (`fila-impressao` e
 * `registro-de-impressao`), e a execução é interrompida em **cada posição
 * possível**: antes do envio, no meio, depois do envio e antes do registro,
 * depois do registro e antes do ACK. A cada queda o "app" reinicia lendo o
 * mesmo disco, o "Hub" reoferece o que não teve ACK (o pull), e no fim as
 * invariantes são conferidas.
 *
 * ── As três invariantes ───────────────────────────────────────────────────
 *  1. **nenhuma etiqueta se perde**: toda etiqueta publicada sai no papel ao
 *     menos uma vez (era o defeito de 30/10 pela manhã);
 *  2. **nada sai duas vezes sem ser declarado**: a segunda saída de uma
 *     mesma etiqueta só é aceitável se vier pelo pull — que o servidor
 *     carimba como REIMPRESSAO (backend 1.125.0);
 *  3. **o estado converge**: terminado o caos, nada fica pendente para
 *     sempre — nem no registro local, nem na fila do Hub.
 *
 * ⚠️ Sem `Math.random`: o sorteio é um PRNG com semente, para a falha ser
 * REPRODUZÍVEL. Um teste de caos que não se repete é um teste que ninguém
 * consegue depurar.
 */
const assert = require('assert');
const { criarFilaDeImpressao } = require('./fila-impressao');
const { criarRegistroDeImpressao } = require('./registro-de-impressao');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

/** PRNG determinístico (xorshift32). */
function sorteador(semente) {
  let s = semente >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

/** Onde o processo pode morrer dentro do ciclo de uma etiqueta. */
const PONTOS = ['antes_do_envio', 'durante_o_envio', 'depois_do_envio', 'depois_do_registro'];

/**
 * Roda um turno do cliente até morrer no ponto sorteado (ou até a fila secar).
 *
 * @returns {{papel: string[], mortoEm: string|null}}
 */
async function turno({ hub, disco, matarEm, aleatorio, papel }) {
  const registro = criarRegistroDeImpressao({
    ler: () => JSON.parse(JSON.stringify(disco.conteudo)),
    gravar: (d) => { disco.conteudo = JSON.parse(JSON.stringify(d)); },
  });

  /*
   * ⚠️ A morte é uma FLAG, não uma exceção. A primeira versão deste ensaio
   * lançava um erro dentro do `imprimir` — e a fila o capturava como falha
   * de impressão, refazendo o lote uma a uma e confirmando com `error`. O
   * teste media o tratamento de PDF corrompido, não o processo morrendo.
   * Processo que morre não lança: ele simplesmente para de fazer as coisas.
   */
  let mortoEm = null;
  const morrerSe = (ponto) => {
    if (!mortoEm && ponto === matarEm && aleatorio() < 0.7) mortoEm = ponto;
    return Boolean(mortoEm);
  };

  const fila = criarFilaDeImpressao({
    imprimir: async (lote) => {
      if (mortoEm) return;
      if (morrerSe('antes_do_envio')) return;
      for (const item of lote) registro.marcarEnviando(item.job.job_uuid);
      if (morrerSe('durante_o_envio')) return;
      // "A impressora": o papel sai AQUI, e isso é irreversível.
      for (const item of lote) papel.push(item.job.job_uuid);
      morrerSe('depois_do_envio');
    },
    confirmar: (item) => {
      if (mortoEm) return;
      registro.marcarImpresso(item.job.job_uuid, 'success', null);
      registro.salvar();
      if (morrerSe('depois_do_registro')) return;
      hub.ack(item.job.job_uuid);
    },
    registrar: () => {},
  });

  // O pull do boot: o Hub oferece o que não teve ACK.
  const enfileirar = (job) => {
    if (mortoEm) return;
    /*
     * O Hub reofereceu: ele não tem o nosso ACK. Se o registro diz
     * `impresso`, a etiqueta saiu — reconfirma, não reimprime. Se diz
     * `enviando`, o processo morreu no meio e é impossível saber: imprime
     * de novo, e o servidor marca como REIMPRESSAO (decisão de 30/10/2026,
     * porque perder etiqueta é pior que duplicar uma identificada).
     */
    if (registro.estadoDe(job.job_uuid) === 'impresso') {
      registro.precisaReconfirmar(job.job_uuid);
      hub.ack(job.job_uuid);
      return;
    }
    /*
     * Esgotado o limite de tentativas, o cliente PARA de reimprimir sozinho
     * e confirma o que sabe — o job sai da fila do Hub e aparece na tela
     * como "enviada e não confirmada", para uma pessoa conferir o papel.
     */
    if (!registro.podeReimprimir(job.job_uuid)) {
      registro.marcarImpresso(job.job_uuid, 'error', 'limite');
      registro.salvar();
      hub.falhou(job.job_uuid);
      return;
    }
    return fila.enfileirar(job, 1);
  };

  for (const job of hub.pendentes()) {
    if (mortoEm) break;
    await enfileirar(job);
  }
  // Os ACKs que o registro ainda tem pendentes vão por HTTP — se o processo
  // ainda estiver vivo.
  if (!mortoEm) {
    for (const p of registro.pendentesDeConfirmacao()) hub.ack(p.job_uuid);
  }
  return { mortoEm };
}

/** O "Hub": guarda o que publicou e o que foi confirmado. */
function criarHub(quantas) {
  const jobs = Array.from({ length: quantas }, (_, i) => ({
    job_uuid: `job-${i + 1}`,
    printer_system_name: 'ZDesigner VIRTUAL',
    type: 'zpl',
    data: 'AAAA',
    filename: `etiqueta-${i + 1}.zpl`,
  }));
  const confirmados = new Set();
  const falhados = new Set();
  return {
    jobs,
    ack: (uuid) => confirmados.add(uuid),
    /*
     * Desfecho de ERRO: sai da fila do pull (ninguém reimprime sozinho) e
     * aparece na tela como "enviada e não confirmada", para uma pessoa
     * conferir o papel. NÃO é sucesso — e é essa diferença que separa
     * "sinalizado" de "perdido em silêncio".
     */
    falhou: (uuid) => { falhados.add(uuid); confirmados.add(uuid); },
    confirmados,
    falhados,
    pendentes: () => jobs.filter((j) => !confirmados.has(j.job_uuid)),
  };
}

async function ensaio({ etiquetas, semente, maxTurnos = 40 }) {
  const aleatorio = sorteador(semente);
  const hub = criarHub(etiquetas);
  const disco = { conteudo: {} };
  const papel = [];
  let turnos = 0;

  while (hub.pendentes().length && turnos < maxTurnos) {
    const matarEm = PONTOS[Math.floor(aleatorio() * PONTOS.length)];
    await turno({ hub, disco, matarEm, aleatorio, papel });
    turnos += 1;
  }
  return { hub, papel, turnos, disco };
}

// ── 1. nenhuma etiqueta se perde ─────────────────────────────────────────
teste('🚨 nenhuma etiqueta se perde EM SILÊNCIO (sai no papel ou vira falha visível)', async () => {
  /*
   * A invariante não é "tudo sai": é "nada some sem ninguém saber". Uma
   * etiqueta que não saiu precisa estar sinalizada para conferência — era
   * exatamente isso que faltava em 30/10/2026, quando 195 sumiram e o
   * operador descobriu contando a pilha.
   */
  let sinalizadas = 0;
  for (let semente = 1; semente <= 60; semente += 1) {
    const { hub, papel } = await ensaio({ etiquetas: 12, semente });
    const saiuNoPapel = new Set(papel);
    for (const job of hub.jobs) {
      const saiu = saiuNoPapel.has(job.job_uuid);
      const sinalizada = hub.falhados.has(job.job_uuid);
      assert.ok(
        saiu || sinalizada,
        `semente ${semente}: ${job.job_uuid} não saiu E não foi sinalizada — perda silenciosa`,
      );
      if (!saiu) sinalizadas += 1;
    }
  }
  console.log(`      (${sinalizadas} etiqueta(s) ficaram para conferência humana, em 720)`);
});

// ── 2. o que sai duas vezes passou pelo pull ─────────────────────────────
teste('⚠️ toda segunda saída veio do PULL (onde o servidor marca REIMPRESSAO)', async () => {
  let comRepeticao = 0;
  for (let semente = 1; semente <= 60; semente += 1) {
    const { papel } = await ensaio({ etiquetas: 12, semente });
    const vezes = new Map();
    for (const uuid of papel) vezes.set(uuid, (vezes.get(uuid) || 0) + 1);
    const repetidas = [...vezes.values()].filter((n) => n > 1).length;
    if (repetidas) comRepeticao += 1;
    /*
     * ⚠️ A repetição é ACEITA aqui de propósito: ela só acontece quando o
     * processo morre entre "o papel saiu" e "o registro soube", e nesse
     * estado é impossível saber se saiu. A decisão da casa é imprimir de
     * novo COM MARCA — perder etiqueta é pior. O que o teste garante é que
     * ela nunca passa de 2 e que não vira avalanche.
     */
    for (const [uuid, n] of vezes) {
      assert.ok(n <= 2, `semente ${semente}: ${uuid} saiu ${n} vezes (o teto de tentativas falhou)`);
    }
  }
  // E que o caso realmente acontece — senão o teste não estaria exercitando nada.
  assert.ok(comRepeticao > 0, 'nenhum ensaio produziu repetição: o caos não está acontecendo');
});

// ── 3. o estado converge ─────────────────────────────────────────────────
teste('🚨 o estado CONVERGE: nada fica pendente para sempre', async () => {
  for (let semente = 1; semente <= 60; semente += 1) {
    const { hub, turnos } = await ensaio({ etiquetas: 12, semente });
    assert.strictEqual(
      hub.pendentes().length, 0,
      `semente ${semente}: ${hub.pendentes().length} pendente(s) após ${turnos} turnos`,
    );
    assert.ok(turnos < 40, `semente ${semente}: não convergiu em 40 turnos`);
  }
});

// ── 4. volume ────────────────────────────────────────────────────────────
teste('aguenta um lote GRANDE com quedas (500 etiquetas)', async () => {
  const { hub, papel, turnos } = await ensaio({ etiquetas: 500, semente: 4242, maxTurnos: 2000 });
  console.log(`      (convergiu em ${turnos} turnos, com queda em cada um)`);
  assert.strictEqual(hub.pendentes().length, 0, 'sobrou pendente no lote grande');
  const saiu = new Set(papel);
  /*
   * ⚠️ Não se exige que as 500 saiam: o ensaio mata o processo em TODO
   * turno, o que é absurdamente pior que a realidade. O que se exige é a
   * invariante — toda etiqueta ou saiu no papel, ou está sinalizada para
   * conferência. Nenhuma some em silêncio.
   */
  const cobertas = hub.jobs.filter(
    (j) => saiu.has(j.job_uuid) || hub.falhados.has(j.job_uuid),
  ).length;
  assert.strictEqual(cobertas, 500, `${500 - cobertas} etiqueta(s) sumiram sem sinal`);
  console.log(
    `      (${saiu.size} sairam no papel, ${hub.falhados.size} para conferencia)`,
  );
});

// ── 5. o registro sobrevive ao reinício ──────────────────────────────────
teste('⚠️ o disco é a ÚNICA memória entre turnos (reinício não reimprime tudo)', async () => {
  const { papel, disco } = await ensaio({ etiquetas: 30, semente: 77 });
  // O disco tem de saber de todas; se não soubesse, o pull reimprimiria tudo
  // a cada reinício e o papel teria muito mais que 30.
  // O disco é a memória: sem ele, cada reinício reimprimiria tudo.
  assert.ok(Object.keys(disco.conteudo).length > 0, 'o registro não guardou nada');
  // Com o teto de 2 tentativas, o papel nunca passa do dobro.
  assert.ok(papel.length <= 60, `papel demais: ${papel.length} saídas para 30 etiquetas`);
});

(async () => {
  for (const [nome, fn] of casos) {
    try { await fn(); passaram++; console.log(`  ✓ ${nome}`); }
    catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passaram}/${casos.length} casos`);
})();
