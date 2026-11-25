/**
 * 🚨 REENTREGA NÃO PODE VIRAR SEGUNDA IMPRESSÃO (25/11/2026)
 *
 * O caso: onda das 18:55 de 25/11 (pilha local) SAIU no papel, o cliente
 * publicou ACK success e o Hub DESCARTOU o ACK (consumidor de `mqtt:acks`
 * desligado). O job ficou `sent` sem `acked_at` — exatamente o que a
 * reentrega do servidor (`backend-novo/src/impressao/reenvio-de-jobs-sem-ack.ts`)
 * republica quando o agente reconecta, entre 3 e 30 min.
 *
 * "Sem ACK no banco" NÃO quer dizer "não saiu". Quem sabe o que saiu é o
 * registro LOCAL. Este teste monta o caminho inteiro com as peças REAIS
 * (`registro-de-impressao` + `decisao-do-job`) — só a impressora e a rede são
 * duplos — e prova as duas metades da regra da casa:
 *   1. o que já saiu NÃO sai de novo (falta notícia, não papel → reconfirma);
 *   2. o que nunca chegou CONTINUA saindo (etiqueta perdida é pior que repetida).
 */
const assert = require('assert');
const { criarRegistroDeImpressao } = require('./registro-de-impressao');
const { decidirSobreJob, aplicarDecisaoDoJob } = require('./decisao-do-job');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

/** Um Print Client com disco em memória, impressora e ACK de mentira. */
function criarCliente() {
  let disco = {};
  const registro = criarRegistroDeImpressao({
    ler: () => JSON.parse(JSON.stringify(disco)),
    gravar: (d) => { disco = JSON.parse(JSON.stringify(d)); },
  });
  const papel = [];
  let acksAgendados = 0;

  // O `enfileirar` do main.js, com a fila trocada por "imprime na hora".
  function chegou(job) {
    return aplicarDecisaoDoJob({
      job,
      userId: 17,
      decisao: decidirSobreJob({
        estado: registro.estadoDe(job.job_uuid),
        podeReimprimir: registro.podeReimprimir(job.job_uuid),
        controleSeguro: job.controle?.versao === 1,
      }),
      registro,
      imprimir: (j) => {
        // A ordem da fila de verdade: `enviando` ANTES dos bytes, desfecho depois.
        registro.marcarEnviando(j.job_uuid);
        papel.push(j.job_uuid);
        registro.marcarImpresso(j.job_uuid, 'success', null);
        registro.salvar();
      },
      registrar: () => {},
      agendarAcks: () => { acksAgendados++; },
    });
  }

  return { registro, papel, chegou, acksAgendados: () => acksAgendados };
}

const ONDA = { job_uuid: 'dedcb559-fe3a-44e0-a34b-6cc780873566', type: 'zpl', data: '' };

teste('🚨 job IMPRESSO, ACK PERDIDO, reconexão: a reentrega NÃO imprime de novo', () => {
  const c = criarCliente();
  c.chegou(ONDA);                          // 1ª entrega: sai no papel
  assert.deepStrictEqual(c.papel, [ONDA.job_uuid]);
  // O ACK se perde: ninguém chama marcarConfirmado.
  const decisao = c.chegou(ONDA);          // reconexão → o Hub republica
  assert.strictEqual(decisao, 'ja_impresso');
  assert.deepStrictEqual(c.papel, [ONDA.job_uuid], 'a onda saiu DUAS vezes no papel');
});

teste('…e em vez de papel, o ACK é reenviado (o Hub precisa da notícia)', () => {
  const c = criarCliente();
  c.chegou(ONDA);
  const antes = c.acksAgendados();
  c.chegou(ONDA);
  assert.ok(c.acksAgendados() > antes, 'a reentrega não reagendou o ACK');
  const pendentes = c.registro.pendentesDeConfirmacao(17).map((p) => p.job_uuid || p.uuid || p);
  assert.ok(
    JSON.stringify(pendentes).includes(ONDA.job_uuid),
    'o job impresso sem ACK aceito tem de seguir na lista de reconfirmação',
  );
});

teste('…e continua assim em reconexões seguidas (agente instável)', () => {
  const c = criarCliente();
  c.chegou(ONDA);
  for (let i = 0; i < 5; i++) c.chegou(ONDA);
  assert.strictEqual(c.papel.length, 1);
});

teste('🚨 job que NUNCA chegou ao agente CONTINUA sendo impresso na reentrega', () => {
  const c = criarCliente();
  const perdido = { job_uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', type: 'zpl', data: '' };
  // A 1ª publicação evaporou (agente fora, sessão limpa): o cliente nunca viu.
  assert.strictEqual(c.registro.estadoDe(perdido.job_uuid) || null, null);
  const decisao = c.chegou(perdido);       // a reentrega é a 1ª vez que ele chega
  assert.strictEqual(decisao, 'imprimir');
  assert.deepStrictEqual(c.papel, [perdido.job_uuid], 'etiqueta perdida não saiu na reentrega');
});

teste('o registro sobrevive a reiniciar o app (disco), então a dedupe também', () => {
  let disco = {};
  const io = { ler: () => JSON.parse(JSON.stringify(disco)), gravar: (d) => { disco = JSON.parse(JSON.stringify(d)); } };
  const r1 = criarRegistroDeImpressao(io);
  r1.marcarEnviando(ONDA.job_uuid);
  r1.marcarImpresso(ONDA.job_uuid, 'success', null);
  r1.salvar();
  const r2 = criarRegistroDeImpressao(io);   // app reaberto
  assert.strictEqual(decidirSobreJob({ estado: r2.estadoDe(ONDA.job_uuid), podeReimprimir: r2.podeReimprimir(ONDA.job_uuid) }), 'ja_impresso');
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
