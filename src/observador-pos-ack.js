/**
 * O OBSERVADOR PÓS-ACK — a janela curta de desconfiança depois do sucesso.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ POR QUE ELE EXISTE (15/11/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * A bancada provou QUATRO vezes que o ACK de sucesso convive com papel que
 * não saiu: Zebra pausada com o lote inteiro no buffer (Mac e Windows),
 * trabalho ainda no CUPS com a fila "saudável", e spool do Windows marcando
 * PRINTED com zero páginas (JOB_INFO_2 sem TrueEndOfJob). A confirmação
 * OPERACIONAL do Hub marca o pedido por esse ACK — é decisão de negócio,
 * explícita — e ESTA é a contrapartida: o cliente continua olhando a fila por
 * alguns segundos e, se encontrar prova CONTRÁRIA, manda o DESMENTIDO. Quem
 * desfaz a marcação é o BACKEND (`ControleImpressaoService.desmentir`); aqui
 * só se observa e se relata, que é o papel do cliente nesta casa.
 *
 * ── As decisões, e o que cada uma impede ──────────────────────────────────
 *
 * 1. **Falha ABERTA, sempre.** Consulta que não roda, resposta que não se
 *    entende, plataforma sem leitura → NADA é relatado. O desmentido é rede
 *    de segurança: perdê-lo devolve o comportamento de hoje; inventá-lo
 *    mandaria lote bom de volta para conferência.
 * 2. **Duas olhadas, e acabou.** Prazos curtos e fixos; não é monitoramento
 *    contínuo nem laço. O que a segunda olhada não viu, a conferência humana
 *    e o histórico cobrem.
 * 3. **Um desmentido por job, no máximo.** QoS 1 reentrega, timer repete —
 *    o backend é idempotente, mas não se gasta rede repetindo o mesmo aviso.
 * 4. **A evidência é da FILA, não do job.** Sem id do trabalho no destino, o
 *    que dá para afirmar é "a fila deste destino está pausada/em erro com
 *    trabalho preso". Pode ser o trabalho de outro? Pode — e aí o lote volta
 *    para conferência e o operador confirma à mão. O erro nessa direção
 *    custa um clique; na direção oposta custa etiqueta marcada sem papel.
 * 5. **Nunca toca o diário** (`registro-de-impressao`). O registro de que o
 *    lote foi ENVIADO continua intacto — é ele que impede o pull de
 *    reimprimir. Desmentir a marcação não é esquecer o envio.
 */

/** Momentos das olhadas, a partir do ACK. */
const PRAZOS_PADRAO_MS = [12000, 45000]

/** Quantos jobs lembrados para não repetir desmentido (teto de memória). */
const MAX_LEMBRADOS = 500

/**
 * Cria o observador.
 *
 * @param {object} portas
 * @param {(destino: object) => Promise<{evidencia: string|null}>} portas.consultar
 *        olha o DESTINO (fila/impressora) e devolve `evidencia` com o motivo
 *        quando há prova CONTRÁRIA ao sucesso, ou `null` quando está tudo
 *        certo ou quando não se sabe. Lançar = não se sabe (falha aberta).
 * @param {(jobUuid: string, userId: number|string, motivo: string) => void} portas.relatar
 *        publica o desmentido no Hub. Nunca deve lançar.
 * @param {(mensagem: string) => void} [portas.registrar]
 * @param {number[]} [portas.prazosMs]  para teste.
 * @param {(fn: Function, ms: number) => object} [portas.agendar]  para teste.
 */
function criarObservadorPosAck ({ consultar, relatar, registrar = () => {}, prazosMs = PRAZOS_PADRAO_MS, agendar = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t } }) {
  /** job_uuid → true depois que o desmentido daquele job saiu. */
  const relatados = new Set()
  /** jobs com observação em curso — a segunda olhada não nasce se a primeira relatou. */
  const emObservacao = new Map()

  function lembrar (uuid) {
    relatados.add(uuid)
    if (relatados.size > MAX_LEMBRADOS) {
      const primeiro = relatados.values().next().value
      relatados.delete(primeiro)
    }
  }

  /**
   * Agenda as olhadas de um job confirmado com sucesso.
   *
   * @param {object} p
   * @param {string} p.jobUuid
   * @param {number|string} p.userId
   * @param {object} p.destino  o que `consultar` precisa (impressora, tipo…).
   */
  function observar ({ jobUuid, userId, destino }) {
    if (!jobUuid || relatados.has(jobUuid) || emObservacao.has(jobUuid)) return
    emObservacao.set(jobUuid, true)
    let pendentes = prazosMs.length
    for (const prazo of prazosMs) {
      agendar(async () => {
        pendentes -= 1
        if (pendentes <= 0) emObservacao.delete(jobUuid)
        if (relatados.has(jobUuid)) return
        let resultado = null
        try {
          resultado = await consultar(destino)
        } catch (erro) {
          // Não sei ≠ falhou: o comportamento volta a ser o de hoje.
          registrar(`observação de ${jobUuid} não concluiu (${erro && erro.message ? erro.message : erro}) — seguindo`)
          return
        }
        const evidencia = resultado && resultado.evidencia
        if (!evidencia) return
        lembrar(jobUuid)
        registrar(`${jobUuid}: prova contrária após o ACK (${evidencia}) — desmentindo`)
        try {
          relatar(jobUuid, userId, evidencia)
        } catch (_) {
          /* relatar nunca deveria lançar; se lançar, não derruba o timer */
        }
      }, prazo)
    }
  }

  return {
    observar,
    /** Só para teste e diagnóstico. */
    relatados: () => new Set(relatados),
  }
}

/**
 * Interpreta a leitura do DESTINO e decide se há prova contrária.
 *
 * Pura e compartilhada entre plataformas: cada uma coleta do seu jeito
 * (lpstat no macOS, Get-Printer/Get-PrintJob no Windows) e entrega os três
 * fatos; a régua do que é "contrário" mora num lugar só.
 *
 * @param {object} leitura
 * @param {boolean|null} leitura.pausada     a fila está pausada? null = não sei.
 * @param {boolean|null} leitura.comProblema a impressora/fila reporta erro? null = não sei.
 * @param {boolean|null} leitura.comTrabalho há trabalho preso na fila? null = não sei.
 * @returns {string|null} o motivo, ou null quando não há prova.
 */
function evidenciaContraria ({ pausada, comProblema, comTrabalho }) {
  // Sem trabalho preso não há o que desmentir: fila vazia depois do ACK é o
  // desfecho NORMAL (o trabalho foi consumido). Pausa com fila vazia idem —
  // pode ter pausado depois do nosso papel sair.
  if (comTrabalho !== true) return null
  if (pausada === true) return 'fila pausada com trabalho preso apos o ACK'
  if (comProblema === true) return 'impressora reportando erro com trabalho preso apos o ACK'
  return null
}

/**
 * Interpreta a linha `status|quantidade|jobStatus;jobStatus` que o
 * PowerShell devolve no Windows (ver `consultarDestinoWindows` no main).
 *
 * ⚠️ Frase desconhecida vira "não sei" nos campos de estado — mas a
 * QUANTIDADE é um número e decide `comTrabalho` sozinha. `Deleting`/`Deleted`
 * não entram como problema: cancelamento entre duas olhadas é invisível
 * mesmo, e tratar "sumiu da fila" como erro desmentiria lote impresso.
 */
function interpretarLeituraWindows (linha) {
  const partes = String(linha || '').trim().split('|')
  if (partes.length < 2) return { pausada: null, comProblema: null, comTrabalho: null }
  const statusImpressora = partes[0] || ''
  const quantidade = Number(partes[1])
  const statusJobs = partes.slice(2).join('|') || ''
  const tudo = `${statusImpressora};${statusJobs}`
  return {
    pausada: /paused/i.test(tudo),
    comProblema: /error|offline|paperout|paperproblem|dooropen|userintervention|notavailable|blocked/i.test(tudo),
    comTrabalho: Number.isFinite(quantidade) ? quantidade > 0 : null,
  }
}

module.exports = { criarObservadorPosAck, evidenciaContraria, interpretarLeituraWindows, PRAZOS_PADRAO_MS }
