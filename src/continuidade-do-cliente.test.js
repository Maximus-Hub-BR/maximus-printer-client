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

teste('🚨 o enfileirar DELEGA para a regra única (a invariante está em decisao-do-job)', () => {
  /*
   * ⚠️ ATUALIZADO 2x em 31/10/2026, e o histórico importa:
   *  1. o caso afirmava `jaImprimiu(job.job_uuid)` — e era essa chamada o
   *     defeito: ela dá `true` para `enviando`, que significa "não sei se
   *     saiu". A etiqueta em dúvida nunca era impressa;
   *  2. depois o corpo inteiro saiu daqui e foi para `decisao-do-job.js`,
   *     porque reintroduzir o defeito deixava estes 29 casos VERDES — eles
   *     conferem presença de código, não efeito.
   * Agora a invariante ("já saiu ⇒ não imprime"; "dúvida ⇒ imprime com
   * teto") é provada por EFEITO em `decisao-do-job.test.js`, com duplos. O
   * que SOBRA para este arquivo é garantir que o main.js delega — se ele
   * voltar a decidir sozinho, a divergência volta.
   */
  const trecho = main.slice(posicao('function enfileirar (job, userId) {'), posicao('function enfileirar (job, userId) {') + 700);
  assert.ok(trecho.includes('aplicarDecisaoDoJob({'), 'o enfileirar parou de delegar');
  assert.ok(trecho.includes('decisao: decidirSobreJob({'), 'a decisão saiu da regra única');
  // As portas: sem elas a regra não tem como agir.
  for (const porta of ['registro: registroDeImpressao', 'imprimir:', 'registrar,', 'agendarAcks:']) {
    assert.ok(trecho.includes(porta), `porta ausente: ${porta}`);
  }
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
   *
   * ⚠️ ATUALIZADO em 31/10/2026: a chamada mudou de arquivo junto com o
   * resto da decisão. Ter a regra em dois lugares É o defeito que causou a
   * perda por dúvida — então o que se trava aqui é que o main.js NÃO a tem,
   * e o módulo SIM.
   */
  const noMain = (main.match(/registroDeImpressao\.precisaReconfirmar\(/g) || []).length;
  assert.strictEqual(noMain, 0, `a decisão voltou para o main.js (${noMain} chamada(s))`);
  const modulo = require('fs').readFileSync(require('path').join(__dirname, 'decisao-do-job.js'), 'utf8');
  assert.ok(modulo.includes('registro.precisaReconfirmar(uuid)'), 'a reconfirmação desapareceu da regra');
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

teste('🚨 o pull respeita o TETO de tentativas (não vira pilha de duplicatas)', () => {
  assert.ok(main.includes('registroDeImpressao.podeReimprimir('), 'o pull não consulta o teto');
});

teste('🚨 limite esgotado vira ERRO visível, nunca "sucesso"', () => {
  /*
   * Confirmar como impressa uma etiqueta que talvez não tenha saído a faria
   * SUMIR da tela — e aí a perda volta a ser silenciosa.
   *
   * ⚠️ ATUALIZADO em 31/10/2026: mora em `decisao-do-job.js`, e o EFEITO
   * ("não imprime, marca error, grava") é provado lá com duplos. Aqui fica a
   * garantia de que a mensagem continua dizendo o que a pessoa deve fazer.
   */
  const modulo = require('fs').readFileSync(require('path').join(__dirname, 'decisao-do-job.js'), 'utf8');
  assert.ok(modulo.includes("decisao === 'esgotado'"), 'o ramo do teto esgotado desapareceu');
  assert.ok(/marcarImpresso\([\s\S]{0,120}'error'/.test(modulo), 'o limite não marca erro');
  assert.ok(modulo.includes('confira o papel'), 'a mensagem não diz o que a pessoa deve fazer');
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

teste('🚨 o pull DECLARA os suspeitos ao Hub (senão a marca sai em etiqueta inédita)', () => {
  /*
   * A informação existe no registro local e, até 30/10/2026, não chegava ao
   * Hub: ele carimbava `REIMPRESSAO` em tudo que reentregava — 19 de 19
   * inéditas em cada um dos dois ensaios de queda. Sem esta chamada a
   * correção do backend não tem efeito nenhum, e nada quebra: as etiquetas
   * só voltam a sair sem marca. Defeito mudo, a classe mais cara da casa.
   */
  assert.ok(
    main.includes('registroDeImpressao.emEnviando()'),
    'o pull voltou a não perguntar ao registro o que está em dúvida',
  );
  assert.ok(
    /params:\s*\{\s*suspeitos:\s*suspeitos\.join\(','\)\s*\}/.test(main),
    'os suspeitos não estão sendo enviados na requisição do pull',
  );
});

teste('⚠️ lista vazia NÃO manda o parâmetro (a rota antiga segue respondendo)', () => {
  assert.ok(
    /suspeitos\.length\s*\?\s*\{\s*params/.test(main),
    'mandar `suspeitos=` vazio é diferente de não mandar — não force o parâmetro',
  );
});

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 A DECISÃO MORA EM UM LUGAR SÓ (31/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Medido em produção: a etiqueta em DÚVIDA era descartada pelo `enfileirar`
 * como "já impressa" e nunca saía — 3 ciclos de pull seguidos, zero papel,
 * zero ACK. O pull decidia certo e o `enfileirar` o atropelava.
 */

teste('🚨 o enfileirar NÃO usa jaImprimiu (ele dá true para a DÚVIDA)', () => {
  assert.ok(
    !/function enfileirar[\s\S]{0,400}registroDeImpressao\.jaImprimiu/.test(main),
    'o guard voltou a tratar qualquer entrada do registro como "já impresso"',
  );
});

teste('🚨 o enfileirar decide pela regra ÚNICA, e passa estado + teto', () => {
  assert.ok(
    /function enfileirar[\s\S]{0,600}decidirSobreJob\(\{/.test(main),
    'a decisão saiu do ponto único',
  );
  assert.ok(main.includes('estado: registroDeImpressao.estadoDe(uuid)'));
  assert.ok(main.includes('podeReimprimir: registroDeImpressao.podeReimprimir(uuid)'));
});

teste('🚨 a DÚVIDA chega à fila de verdade (provado por efeito no módulo)', () => {
  /*
   * ⚠️ Este caso era estrutural e NÃO pegava o defeito: com a dúvida
   * tratada como impressa, ele passava. A prova real é o caso
   * "EFEITO: a etiqueta em dúvida VAI para a fila" em
   * `decisao-do-job.test.js` — verificado desfazendo, 3 casos vermelhos.
   * Aqui só se garante que a porta `imprimir` do main.js aponta para a fila
   * de verdade: se ela virar um no-op, a regra fica certa e nada imprime.
   */
  const trecho = main.slice(posicao('function enfileirar (job, userId) {'), posicao('function enfileirar (job, userId) {') + 700);
  assert.ok(
    /imprimir: \(j, u\) => filaDeImpressao\.enfileirar\(j, u\)/.test(trecho),
    'a porta `imprimir` não vai mais para a fila de impressão',
  );
});

teste('⚠️ o PULL não decide mais — só lê o veredito do enfileirar', () => {
  const pull = main.slice(main.indexOf('async function puxarPendentes'));
  const corpo = pull.slice(0, pull.indexOf('async function', 20));
  assert.ok(
    !corpo.includes('registroDeImpressao.jaImprimiu'),
    'o pull voltou a decidir por conta própria — é a divergência que causou a perda',
  );
  assert.ok(
    /const decisao = enfileirar\(job, userId\)/.test(corpo),
    'o pull precisa usar o retorno do enfileirar',
  );
});

teste('🚨 todo caminho de ACK LOGA (ausência de linha não provava nada)', () => {
  // A sessão da VM procurou no print.log o ACK de 40 etiquetas e não achou
  // nenhum — nem das 39 que o banco provava confirmadas.
  assert.ok(main.includes('confirmado por MQTT'), 'o ACK por MQTT voltou a ser mudo');
  assert.ok(main.includes('MQTT offline — fica pendente para o HTTP'));
  assert.ok(main.includes('MQTT falhou'));
  assert.ok(main.includes('confirmação(ões) enviada(s) por HTTP'));
});

teste('⚠️ o require de decisao-do-job vem ANTES do uso (TDZ não aparece no --check)', () => {
  const req = main.indexOf("require('./src/decisao-do-job')");
  const uso = main.indexOf('decidirSobreJob({');
  assert.ok(req > 0 && uso > 0, 'não achei require ou uso');
  assert.ok(req < uso, 'o require ficou DEPOIS do uso: ReferenceError em produção');
});

/*
 * ══════════════════════════════════════════════════════════════════════════
 * A VELOCIDADE: o preparo colado e o bidi fora do caminho (31/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Medido no print.log da RDF: 5 bytes de preparo custaram 16.182 ms e a
 * consulta do bidirecional 11.610 ms, as duas ANTES da primeira etiqueta —
 * 27,8 s de preparação para 5,1 s de impressão.
 *
 * ⚠️ O EFEITO (o corpo da etiqueta sai intacto, o comando vem antes) é
 * provado por BYTES em `preparo-impressora.test.js`. Aqui só se garante que
 * o main.js continua ligando as peças: se ele parar de colar ou voltar a
 * esperar pelo bidi, a lentidão volta sem nenhum teste reclamar.
 */

teste('🚨 o lote ZPL pede o comando COLADO antes de montar o buffer', () => {
  assert.ok(
    /job\.type === 'zpl'[\s\S]{0,200}preparoDeImpressora\.comandoColado\(/.test(main),
    'o caminho ZPL parou de pedir o comando colado — volta a abrir o spooler 2x',
  );
});

teste('🚨 o buffer enviado PASSA pela colagem (a prova de bytes está no módulo)', () => {
  assert.ok(
    main.includes('colarNaEtiqueta(colado && colado.texto, corpo)'),
    'o preparo deixou de entrar no buffer da etiqueta',
  );
  assert.ok(
    /imprimirZpl\(comPreparo,/.test(main),
    'o buffer com o preparo não é o que vai para a impressora',
  );
});

teste('⚠️ o caminho ANTIGO continua como rede quando não dá para colar', () => {
  // PDF, impressora que não fala ZPL, linguagem divergente, preparo recente:
  // nesses casos o comportamento tem de ser exatamente o de hoje.
  assert.ok(
    /if \(!colado\) await preparoDeImpressora\.preparar\(/.test(main),
    'sem a rede, quem não pode colar deixa de ser preparado',
  );
});

teste('🚨 o preparo só é CONFIRMADO depois do envio dar certo', () => {
  // Confirmar antes faria um envio que falhou contar como preparo feito, e a
  // impressora ficaria uma hora sem o comando — trocando a economia pela
  // pausa entre etiquetas, que é a queixa de origem.
  const i = main.indexOf('imprimirZpl(comPreparo,');
  const j = main.indexOf('confirmarPreparo(colado.chave)');
  assert.ok(i > 0 && j > 0, 'não achei as duas pontas');
  assert.ok(i < j, 'o confirmar está ANTES do envio');
});

teste('🚨 o bidirecional NÃO é esperado (void), e roda DEPOIS da etiqueta', () => {
  const i = main.indexOf('imprimirZpl(comPreparo,');
  const j = main.indexOf('desligarBidiDepois(');
  assert.ok(i > 0 && j > 0, 'não achei as duas pontas');
  assert.ok(i < j, 'o bidi voltou para antes da impressão (11,6 s na RDF)');
  assert.ok(
    /void preparoDeImpressora\.desligarBidiDepois\(/.test(main),
    'o bidi voltou a ser esperado — a etiqueta paga o WMI de novo',
  );
});

teste('🚨 o CUPS confere a fila DEPOIS de entregar (o ACK que mentia)', () => {
  // 5 ondas `success` com a fila pausada e nenhuma etiqueta no papel.
  assert.ok(
    main.includes('filaEstaPausada(saida.toString())'),
    'o cliente voltou a confiar no "aceito" do lp',
  );
  assert.ok(
    /está pausada no sistema/.test(main),
    'sem a mensagem, o operador não sabe que precisa retomar a impressora',
  );
});

teste('⚠️ os DOIS caminhos do CUPS informam a impressora (senão não há o que conferir)', () => {
  assert.ok(/argumentosDePdf\([\s\S]{0,160}\n\s*printerName,/.test(main), 'o caminho PDF não informa a fila');
  assert.ok(/argumentosDeZplRaw\([^)]*\}\), printerName\)/.test(main), 'o caminho ZPL não informa a fila');
});

teste('🚨 a conferência da fila falha ABERTA (lpstat ruim não acusa nada)', () => {
  // Marcar erro por não entender a saída faria etiqueta boa virar pendência.
  const i = main.indexOf("execFileSync('lpstat'");
  assert.ok(i > 0, 'não achei a consulta');
  const trecho = main.slice(i, i + 400);
  assert.ok(/catch \(_\) \{[\s\S]{0,160}return/.test(trecho), 'falha do lpstat tem de voltar sem acusar');
});

for (const [nome, fn] of casos) {
  try { fn(); passaram++; console.log(`  ✓ ${nome}`); }
  catch (erro) { console.error(`  ✗ ${nome}\n    ${erro.message}`); process.exitCode = 1; }
}
console.log(`\n${passaram}/${casos.length} casos`);
