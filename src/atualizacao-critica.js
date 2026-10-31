'use strict';

/**
 * Quando o Print Client pode se reiniciar sozinho para instalar uma
 * atualização CRÍTICA — regra pura.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 POR QUE ISTO EXISTE: O UPDATE NÃO CHEGAVA (31/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * A cadeia do auto-update tinha quatro etapas e a última dependia de gente:
 *
 *   1. o Hub declara a versão ................ manual
 *   2. o cliente verifica (boot + 5 em 5 min)  automático
 *   3. baixa o instalador .................... automático
 *   4. INSTALA ............................... só ao FECHAR o app
 *
 * `autoInstallOnAppQuit` espera o fechamento, e PC de expedição fica semanas
 * aberto. Medido: o laptop da RDF ficou **5 dias na 1.0.14** com a 1.0.15
 * declarada e baixada. Marcar a versão como obrigatória não resolvia — o
 * `is_required` só troca a notificação por um diálogo; o que ele dispara
 * continua sendo o DOWNLOAD.
 *
 * Em 31/10/2026 isso passou a doer: uma correção de duplicata precisava
 * chegar a quatro máquinas e a única via era alguém instalar à mão em cada
 * uma.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ E POR QUE NÃO REINICIAR DE QUALQUER JEITO
 * ══════════════════════════════════════════════════════════════════════════
 * Reiniciar no meio de um lote troca uma atualização por etiquetas perdidas
 * — e papel não tem desfazer. Por isso a regra é **fechada**: na dúvida,
 * espera. Uma máquina que nunca fica ociosa simplesmente não se atualiza
 * sozinha, e isso é melhor que interromper a expedição.
 *
 * As duas guardas, nesta ordem:
 *  - **imprimindo**: qualquer job na fila (pendente OU em voo) adia;
 *  - **ACK pendente**: reiniciar antes de confirmar faria o Hub achar que a
 *    etiqueta não saiu, e o pull a reimprimiria na volta — exatamente a
 *    duplicata que este mesmo dia passou corrigindo.
 */

/**
 * @param {object} e  o estado agora
 * @param {boolean} e.baixado         o instalador já está pronto?
 * @param {boolean} e.obrigatoria     o Hub marcou a versão como crítica?
 * @param {boolean} e.imprimindo      há job na fila (pendente ou em voo)?
 * @param {number}  e.acksPendentes   quantos ACKs o Hub ainda não recebeu
 * @returns {{reiniciar: boolean, motivo: string}}
 */
function decidirReinicio({ baixado, obrigatoria, imprimindo, acksPendentes } = {}) {
  if (!baixado) return { reiniciar: false, motivo: 'sem_download' };
  // Versão normal continua como sempre: instala ao fechar, sem interromper.
  if (!obrigatoria) return { reiniciar: false, motivo: 'nao_obrigatoria' };
  if (imprimindo) return { reiniciar: false, motivo: 'imprimindo' };
  if (Number(acksPendentes) > 0) return { reiniciar: false, motivo: 'acks_pendentes' };
  return { reiniciar: true, motivo: 'pronto' };
}

/** Frase para o log — o motivo tem de ser legível por quem opera. */
function explicarReinicio(motivo) {
  const frases = {
    sem_download: 'atualização ainda não baixou',
    nao_obrigatoria: 'atualização não é obrigatória — instala ao fechar o programa',
    imprimindo: 'há impressão em andamento — adiando o reinício',
    acks_pendentes: 'há confirmações pendentes — enviando antes de reiniciar',
    pronto: 'ocioso e sem pendências — reiniciando para atualizar',
  };
  return frases[motivo] || motivo;
}

/** De quanto em quanto tempo reavaliar enquanto a máquina está ocupada. */
const INTERVALO_DE_TENTATIVA_MS = 60 * 1000;

module.exports = { decidirReinicio, explicarReinicio, INTERVALO_DE_TENTATIVA_MS };
