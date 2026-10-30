/**
 * As LIGAÇÕES do main.js — `node src/continuidade-do-cliente.test.js`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ POR QUE INVARIANTE ESTRUTURAL, E NÃO TESTE DE COMPORTAMENTO
 * ══════════════════════════════════════════════════════════════════════════
 * O `main.js` importa `electron` e não carrega fora do Electron. O que estes
 * casos protegem são as LIGAÇÕES entre as peças — e é nelas que o defeito
 * mora: a fila tem teste, o registro tem teste, o envio tem teste, e em
 * 30/10/2026 o cliente perdia 73% das etiquetas em ZPL porque as peças não
 * estavam ligadas na ordem certa. Uma inversão aqui não produz erro: produz
 * etiqueta duplicada ou perdida, em silêncio, na máquina do cliente.
 *
 * O caso do `require` depois do uso (TDZ) está em `registro-de-impressao.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

const posicao = (trecho) => main.indexOf(trecho);

teste('🚨 nenhum execSync sobrou — é ele que derrubava o MQTT durante a impressão', () => {
  const ocorrencias = main.split('\n').filter((l) => /execSync\s*\(/.test(l) && !l.trim().startsWith('*'));
  assert.deepStrictEqual(ocorrencias, [], `execSync em: ${ocorrencias.join(' | ')}`);
});

teste('o envio RAW usa execFile com LISTA de argumentos', () => {
  assert.ok(main.includes('argumentosPowerShell(script, printerName, file)'));
  assert.ok(main.includes("const { execFile } = require('child_process')"));
});

teste('🚨 o teto do ENVIO é proporcional ao lote, nunca um número fixo', () => {
  /*
   * ⚠️ A asserção olha só o corpo do `imprimirZpl`: o teto de 15 s do
   * `desligarBidi` é legítimo e fica — ele configura o spooler e não depende
   * de quantas etiquetas vão sair. Foi o teto do ENVIO que matava o lote e
   * disparava o fallback um-a-um (8,2 s por etiqueta contra 0,36 s).
   */
  const inicio = posicao('async function imprimirZpl (');
  const fim = posicao('async function registrarAgente (');
  assert.ok(inicio > 0 && fim > inicio, 'não achei o corpo do imprimirZpl');
  const corpo = main.slice(inicio, fim).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(corpo.includes('tetoDoEnvioRaw(etiquetas)'), 'o teto não é calculado pelo lote');
  assert.ok(!/timeout:\s*\d+/.test(corpo), 'voltou um teto FIXO no envio RAW');
});

teste('🚨 o lote informa QUANTAS etiquetas vão no fluxo', () => {
  assert.ok(
    main.includes('job.printer_system_name, buffers.length)'),
    'o número de etiquetas não chega no envio — o teto viraria o de 1 etiqueta',
  );
});

teste('🚨 o caminho TCP 9100 também tem teto PROPORCIONAL, não fixo', () => {
  /*
   * O winspool foi corrigido primeiro e o TCP ficou com `10000` fixo — a
   * mesma classe de defeito do outro lado. Nenhuma impressora usa `zpl_host`
   * hoje, o que torna mais fácil (e mais barato) acertar antes do primeiro
   * uso em volume.
   */
  const inicio = posicao('if (zplHost) {');
  const fim = posicao("} else if (canalDeZpl(");
  assert.ok(inicio > 0 && fim > inicio, 'não achei o ramo TCP do imprimirZpl');
  const ramo = main.slice(inicio, fim).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(ramo.includes('tetoDoEnvioRaw(etiquetas)'), 'o teto do TCP não depende do lote');
  assert.ok(!/setTimeout\([\s\S]*?,\s*\d{3,}\s*\)/.test(ramo), 'voltou um teto FIXO no TCP');
});

teste('⚠️ o temporizador do TCP é cancelado (não fica pendurado por impressão)', () => {
  const inicio = posicao('if (zplHost) {');
  const fim = posicao("} else if (canalDeZpl(");
  const ramo = main.slice(inicio, fim);
  assert.ok(ramo.includes('clearTimeout(relogio)'), 'o timer do TCP não é cancelado');
});

teste('🚨 o confirmar GRAVA no registro antes de falar com a rede', () => {
  const gravou = posicao('registroDeImpressao.marcarImpresso(item.job.job_uuid, status, erro)');
  const publicou = posicao('`hub/ack/${item.userId}/${item.job.job_uuid}`');
  assert.ok(gravou > 0, 'o confirmar não grava no registro');
  assert.ok(publicou > 0, 'o confirmar não publica mais o ACK');
  assert.ok(gravou < publicou, 'a gravação tem de vir ANTES da publicação');
});

teste('⚠️ o ACK por MQTT usa o callback do QoS 1 (PUBACK) para dar por confirmado', () => {
  assert.ok(main.includes('(erroDoPublish) => {'), 'publish sem callback: nada prova a entrega');
  assert.ok(main.includes('registroDeImpressao.marcarConfirmado(item.job.job_uuid)'));
});

teste('⚠️ cliente offline NÃO perde o ACK (deixa pendente para o HTTP)', () => {
  const trecho = main.slice(posicao('confirmar: (item, status, erro) => {'), posicao('registrar: (m) => registrar(`[fila]'));
  assert.ok(trecho.includes('agendarAcksPendentes()'), 'offline volta sem registrar o pendente');
  assert.ok(
    !/if \(!mqttClient\) return/.test(trecho),
    'voltou o return cego: imprimir offline deixaria papel na mão e nenhum registro',
  );
});

teste('🚨 o enfileirar DESCARTA job já impresso (a trava da duplicata do pull)', () => {
  const trecho = main.slice(posicao('function enfileirar (job, userId) {'), posicao('function enfileirar (job, userId) {') + 600);
  assert.ok(trecho.includes('registroDeImpressao.jaImprimiu(job.job_uuid)'));
  assert.ok(trecho.includes('agendarAcksPendentes()'), 'job já impresso tem de ser RECONFIRMADO');
});

teste('🚨 o registro marca ENVIANDO antes de qualquer byte sair', () => {
  /*
   * A duplicata de 30/10/2026 nasceu na janela entre "os bytes saíram" e
   * "anotei que saíram": o app fechou no meio e a recuperação reimprimiu.
   */
  const inicio = posicao('imprimir: async (lote) => {');
  const fim = posicao('confirmar: (item, status, erro) => {');
  assert.ok(inicio > 0 && fim > inicio, 'não achei o imprimir da fila');
  const corpo = main.slice(inicio, fim);
  const marcou = corpo.indexOf('registroDeImpressao.marcarEnviando(');
  const converteu = corpo.indexOf('Buffer.from(i.job.data');
  assert.ok(marcou > 0, 'o lote não marca `enviando`');
  assert.ok(marcou < converteu, 'o `enviando` tem de vir ANTES de preparar os bytes');
});

teste('🚨 o confirmar grava SÍNCRONO, não por debounce', () => {
  const inicio = posicao('confirmar: (item, status, erro) => {');
  const corpo = main.slice(inicio, inicio + 900).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(corpo.includes('registroDeImpressao.salvar()'), 'o confirmar não grava na hora');
  assert.ok(
    !/marcarImpresso[\s\S]{0,120}agendarGravacaoDoRegistro\(\)/.test(corpo),
    'voltou o debounce no caminho do desfecho: não sobrevive ao fechamento',
  );
});

teste('🚨 job reoferecido pelo Hub é DESMARCADO para reconfirmar', () => {
  /*
   * Dois jobs voltavam em todo pull para sempre: o cliente os tinha como
   * confirmados (PUBACK do broker) e nunca os reenviava; o Hub nunca soube.
   */
  const ocorrencias = (main.match(/registroDeImpressao\.precisaReconfirmar\(/g) || []).length;
  assert.strictEqual(ocorrencias, 2, `esperava 2 (pull e fila), achei ${ocorrencias}`);
});

teste('🚨 o pull roda no connect, e os ACKs vão ANTES dele', () => {
  const trecho = main.slice(posicao("mqttClient.on('connect'"), posicao("mqttClient.on('message'"));
  const acks = trecho.indexOf('await enviarAcksPendentes()');
  const pull = trecho.indexOf('await puxarPendentes()');
  assert.ok(acks > 0, 'o connect não confirma o que ficou pendente');
  assert.ok(pull > 0, 'o connect não puxa os pendentes do Hub');
  assert.ok(acks < pull, 'confirmar tem de vir antes de puxar, senão o Hub oferece o que já saiu');
  assert.ok(trecho.includes('ligarRotinasDeContinuidade()'));
});

teste('⚠️ as rotinas periódicas existem e não dependem de evento de rede', () => {
  assert.ok(main.includes('INTERVALO_DE_PULL_MS'), 'sem pull periódico, só a reconexão recupera');
  assert.ok(main.includes('INTERVALO_DE_ACKS_MS'));
  assert.ok(main.includes('setInterval(() => void puxarPendentes()'));
  assert.ok(main.includes('setInterval(() => void enviarAcksPendentes()'));
});

teste('🚨 a falha da descoberta de impressoras vai para o LOG, não só para o console', () => {
  /*
   * 30/10/2026: o Leonardo instalou a versão nova, logou, e "não puxou
   * nenhuma impressora". Não havia NENHUM rastro na máquina — o `catch` da
   * descoberta escrevia só em `console.error`, que num app de bandeja
   * ninguém lê. A causa só apareceu cruzando duas colunas do banco do
   * SERVIDOR. Todo catch de borda tem de dizer o motivo onde alguém procura.
   */
  const inicio = posicao('async function descobrirImpressoras');
  const fim = posicao('function detectarTipoImpressora');
  assert.ok(inicio > 0 && fim > inicio, 'não achei a descoberta');
  const corpo = main.slice(inicio, fim);
  assert.ok(/registrar\(`\[impressoras\] FALHA/.test(corpo), 'a falha não é registrada no log');
  assert.ok(/registrar\(`\[impressoras\] \$\{list\.length\}/.test(corpo), 'o sucesso não registra quantas achou');
});

teste('⚠️ o teto da descoberta é nomeado e generoso (uma fila ruim some com todas)', () => {
  assert.ok(main.includes('TETO_DA_DESCOBERTA_MS'), 'o teto voltou a ser número solto');
  const m = main.match(/const TETO_DA_DESCOBERTA_MS = (\d+)/);
  assert.ok(m, 'não achei a constante');
  assert.ok(Number(m[1]) >= 30000, `teto curto demais: ${m[1]} ms`);
});

teste('⚠️ o registro é gravado ao FECHAR o app', () => {
  assert.ok(
    /registroDeImpressao\.salvar\(\)[\s\S]{0,80}mqttClient\.end\(true\)/.test(main),
    'fechar sem gravar perde a prova de que o papel saiu',
  );
});

teste('o pull tem trava de concorrência (connect + temporizador podem coincidir)', () => {
  assert.ok(main.includes('if (pullEmCurso) return'));
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
