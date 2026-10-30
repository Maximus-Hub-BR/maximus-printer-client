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
