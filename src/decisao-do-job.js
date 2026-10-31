'use strict';

/**
 * O que fazer com um job de impressão que chegou — regra PURA.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 POR QUE ISTO EXISTE: DOIS GUARDS, A MESMA PERGUNTA, RESPOSTAS OPOSTAS
 * ══════════════════════════════════════════════════════════════════════════
 * Até a 1.0.22 a decisão estava em DOIS lugares, e eles discordavam:
 *
 *   `puxarPendentes` (certo):  estado `enviando` é DÚVIDA ⇒ reimprime, com
 *                              teto de tentativas; esgotado, vira erro
 *                              visível para a pessoa conferir o papel.
 *   `enfileirar`     (errado): `if (jaImprimiu(uuid))` ⇒ "já foi impresso,
 *                              reconfirmando, sem imprimir de novo".
 *
 * E `jaImprimiu` é `Boolean(dados[uuid])` — **qualquer** entrada, inclusive
 * `enviando`, que por definição significa "fui ao papel e NÃO SEI se saiu".
 * Como o pull chama o `enfileirar`, o guard errado ganhava sempre.
 *
 * Medido em 31/10/2026, dois ciclos de pull seguidos, com a etiqueta
 * ENSAIO-45-01 (job 4c339e15) parada em `enviando`:
 *
 *   11:18:29.722 [fila] 4c339e15 já foi impresso — reconfirmando, sem imprimir
 *   11:18:29.736 [pull] 40 pendente(s): 40 para imprimir   → saíram 39
 *   11:20:29.977 [fila] 4c339e15 já foi impresso — reconfirmando, sem imprimir
 *   11:20:29.983 [pull] 1 pendente(s): 1 para imprimir     → saiu 0
 *
 * 🚨 E o círculo se fechava: o `precisaReconfirmar` daquele ramo devolve
 * `true` sem mudar nada (a entrada já está `confirmado: false`), e
 * `pendentesDeConfirmacao` EXCLUI `enviando` de propósito — então nem ACK
 * saía. A etiqueta não era impressa **e** o Hub nunca sabia: ela voltava a
 * cada 2 minutos, para sempre, e nunca saía no papel.
 *
 * É a perda por DÚVIDA. A perda por QUEDA foi corrigida na 1.0.21 (o pull);
 * esta ficou em pé, e é candidata direta às taxas que não baixaram no parque
 * (MALU 26,3%, Afonso Pena 25,4% em 7 dias).
 *
 * ⚠️ A correção é CENTRALIZAR, não remendar o guard: enquanto a regra viver
 * em dois lugares, a próxima mudança num deles reabre a divergência.
 */

/**
 * @param {object} situacao
 * @param {string|null} situacao.estado          `'impresso'`, `'enviando'` ou nulo
 *   (nulo = nunca vimos este job). ⚠️ Entrada legada sem o campo `estado` é
 *   lida como `'impresso'` pelo registro — são as 209 linhas gravadas pela
 *   1.0.19, e tratá-las como dúvida reimprimiria o passado inteiro.
 * @param {boolean} situacao.podeReimprimir      o teto de tentativas permite?
 * @returns {'imprimir'|'reimprimir'|'ja_impresso'|'esgotado'}
 */
function decidirSobreJob ({ estado, podeReimprimir } = {}) {
  // Nunca vimos: é trabalho novo.
  if (!estado) return 'imprimir';

  // Teve desfecho (saiu, ou falhou de forma conhecida). Reimprimir aqui seria
  // colar etiqueta errada no pacote; o que falta é o Hub saber, não papel.
  if (estado === 'impresso') return 'ja_impresso';

  /*
   * Daqui para baixo é DÚVIDA: `enviando`, ou um estado que esta versão não
   * conhece. Estado desconhecido cai aqui de propósito — tratá-lo como
   * `'imprimir'` ignoraria o teto de tentativas, e como `'ja_impresso'`
   * repetiria o defeito que este arquivo conserta. Na dúvida, o caminho é o
   * que tem freio E desfecho visível.
   */
  return podeReimprimir ? 'reimprimir' : 'esgotado';
}

/**
 * APLICA a decisão. Separado de `decidirSobreJob` por um motivo medido:
 *
 * ⚠️ Em 31/10/2026 eu reintroduzi o defeito de propósito, para verificar os
 * testes, e os **29 casos estruturais do `main.js` passaram** — eles conferem
 * a presença de trechos de código, não o que acontece. Só a regra pura ficou
 * vermelha. Teste estrutural prova que a peça está no lugar; não prova que
 * ela funciona.
 *
 * Com a aplicação aqui, e as dependências entrando como PORTAS, dá para
 * exercitar o comportamento com duplos: "a etiqueta em dúvida FOI para a
 * fila?" é uma asserção sobre o efeito, e essa o defeito não atravessa.
 *
 * @param {object} p
 * @param {object} p.job                  o job como chegou (MQTT ou pull)
 * @param {number|string} p.userId
 * @param {string} p.decisao              o veredito de `decidirSobreJob`
 * @param {object} p.registro             o registro de impressão
 * @param {function} p.imprimir           manda para a fila de verdade
 * @param {function} p.registrar          log
 * @param {function} p.agendarAcks        agenda o envio de ACKs
 * @returns {string} a mesma decisão, para quem chamou contar
 */
function aplicarDecisaoDoJob ({ job, userId, decisao, registro, imprimir, registrar, agendarAcks }) {
  const uuid = job && job.job_uuid;

  if (decisao === 'ja_impresso') {
    // Chegou de novo ⇒ o Hub não tem o nosso ACK. Falta notícia, não papel.
    registro.precisaReconfirmar(uuid);
    registrar(`[fila] ${uuid} já saiu no papel — reconfirmando, sem imprimir de novo`);
    agendarAcks();
    return decisao;
  }

  if (decisao === 'esgotado') {
    /*
     * 🚨 O desfecho é ERRO, nunca "sucesso". Confirmar como impressa uma
     * etiqueta que talvez não tenha saído a faria SUMIR da tela, e aí a
     * perda volta a ser silenciosa. Como erro, ela aparece para a pessoa
     * conferir o papel — a única coisa honesta quando o sistema não sabe.
     */
    registro.marcarImpresso(
      uuid,
      'error',
      'o app foi encerrado durante o envio e o limite de tentativas acabou — confira o papel',
    );
    registro.salvar();
    registrar(`[fila] ${uuid}: limite de tentativas atingido — marcado para conferência`);
    agendarAcks();
    return decisao;
  }

  if (decisao === 'reimprimir') {
    registrar(`[fila] ${uuid} estava em DÚVIDA (envio sem desfecho) — imprimindo de novo`);
  }
  imprimir(job, userId);
  return decisao;
}

module.exports = { decidirSobreJob, aplicarDecisaoDoJob };
