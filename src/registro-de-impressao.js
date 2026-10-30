/**
 * O REGISTRO LOCAL do que já saiu no papel — puro, sem Electron e sem disco.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 POR QUE ELE EXISTE (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Até aqui a fila do Print Client era 100% em MEMÓRIA e a única prova de
 * impressão era um ACK publicado por MQTT. As duas coisas falham no mesmo
 * instante: a conexão cai no meio do lote, o ACK não sai, e nem o cliente nem
 * o Hub sabem o que foi para o papel. Medido em 7 dias, por caminho:
 *
 *   LAPTOP-KO8NI12G (RDF)      ZPL   700 jobs   511 sem ACK   73,0%
 *   LAPTOP-KO8NI12G (a MESMA)  PDF  4.160 jobs   13 sem ACK    0,3%
 *   vaio77 (Afonso Pena)       ZPL   287 jobs    73 sem ACK   25,4%
 *   DESKTOP-8FHQOL3            ZPL  7.107 jobs  320 sem ACK    4,5%
 *   MacBook de madu            PDF 17.185 jobs   29 sem ACK    0,2%
 *
 * Com o Hub passando a OFERECER os pendentes (o cliente puxa, ver
 * `backend-novo/src/impressao/pendentes-do-agente.ts`), surge um risco novo e
 * pior que o anterior: **reimprimir o que já saiu**. O job volta na lista de
 * pendentes justamente porque o ACK se perdeu — e o ACK se perde DEPOIS de a
 * etiqueta sair. Sem memória em disco, o cliente imprimiria de novo e a
 * expedição colaria duas etiquetas.
 *
 * Então este registro responde duas perguntas, e só elas:
 *
 *   1. "já imprimi este job?"        → impede a duplicata do pull;
 *   2. "quais ACKs ainda não foram aceitos?" → permite reconfirmar por HTTP.
 *
 * ── Três decisões, e o que cada uma impede ────────────────────────────────
 *
 * 1. **Guarda o UUID, nunca o payload.** Uma etiqueta pesa ~50 KB; 300
 *    pendentes seriam 15 MB reescritos a cada lote. E o payload não é
 *    necessário: quem o tem é o Hub, e o cliente o pede de volta. O registro
 *    é de algumas centenas de bytes por job.
 *
 * 2. **Impresso é impresso, mesmo com erro.** Um job que falhou também entra:
 *    o que não pode acontecer é tentar de novo em silêncio por causa do pull.
 *    Quem decide reimprimir é a pessoa, na tela.
 *
 * 3. **Poda por idade, com folga sobre a janela do servidor.** O Hub só
 *    oferece pendente das últimas 2 horas; o registro guarda 24 h. Podar
 *    antes da janela devolveria o job ao estado "nunca impresso" — e aí a
 *    duplicata volta pela porta que fechamos.
 */

/** Por quanto tempo lembrar de um job. Folga de 12× sobre a janela do Hub. */
const HORAS_DE_MEMORIA = 24;

/** Quantos jobs no máximo — teto de tamanho do arquivo, nunca de verdade. */
const MAXIMO_DE_ENTRADAS = 5000;

/**
 * Cria o registro.
 *
 * @param {object} portas
 * @param {() => object} portas.ler      devolve o conteúdo gravado (ou {})
 * @param {(dados: object) => void} portas.gravar
 * @param {() => number} [portas.agora]  injetável para teste
 */
function criarRegistroDeImpressao({ ler, gravar, agora = () => Date.now() }) {
  /** @type {Record<string, {em: number, status: string, erro: string|null, confirmado: boolean}>} */
  let dados = {};

  try {
    const lido = ler();
    if (lido && typeof lido === 'object') dados = lido;
  } catch (_) {
    // ⚠️ Arquivo corrompido NÃO pode impedir a impressão: começa vazio. O
    // pior caso é reimprimir o que o Hub ainda oferece (até 2 h); travar o
    // cliente seria pior.
    dados = {};
  }

  function podar() {
    const limite = agora() - HORAS_DE_MEMORIA * 3600000;
    for (const [uuid, item] of Object.entries(dados)) {
      // ⚠️ Nunca poda o que ainda não foi confirmado: aquele ACK é a única
      // notícia que o Hub vai receber.
      if (item.confirmado && item.em < limite) delete dados[uuid];
    }
    const chaves = Object.keys(dados);
    if (chaves.length > MAXIMO_DE_ENTRADAS) {
      // Sai o mais antigo JÁ CONFIRMADO primeiro.
      chaves
        .filter((k) => dados[k].confirmado)
        .sort((a, b) => dados[a].em - dados[b].em)
        .slice(0, chaves.length - MAXIMO_DE_ENTRADAS)
        .forEach((k) => delete dados[k]);
    }
  }

  function salvar() {
    podar();
    try {
      gravar(dados);
    } catch (_) {
      // Disco cheio ou permissão: a impressão continua. O custo é perder a
      // memória entre reinícios, não parar a expedição.
    }
  }

  return {
    /** Este job já foi para a impressora (com sucesso ou com erro)? */
    jaImprimiu: (jobUuid) => Boolean(jobUuid && dados[jobUuid]),

    /**
     * Registra que o job foi entregue à impressora. Idempotente: não
     * sobrescreve o instante original, que é o que a poda usa.
     */
    marcarImpresso(jobUuid, status, erro) {
      if (!jobUuid) return;
      if (!dados[jobUuid]) {
        dados[jobUuid] = {
          em: agora(),
          status: status === 'error' ? 'error' : 'success',
          erro: erro || null,
          confirmado: false,
        };
      }
    },

    /** O Hub aceitou o ACK deste job. */
    marcarConfirmado(jobUuid) {
      if (dados[jobUuid]) dados[jobUuid].confirmado = true;
    },

    /** Os ACKs que o Hub ainda não aceitou — o que vai por HTTP. */
    pendentesDeConfirmacao() {
      return Object.entries(dados)
        .filter(([, item]) => !item.confirmado)
        .sort((a, b) => a[1].em - b[1].em)
        .map(([job_uuid, item]) => ({ job_uuid, status: item.status, error: item.erro }));
    },

    /** Grava em disco (com poda). Chamado UMA vez por lote, não por etiqueta. */
    salvar,

    /** Só para diagnóstico. */
    tamanho: () => Object.keys(dados).length,
  };
}

module.exports = { criarRegistroDeImpressao, HORAS_DE_MEMORIA, MAXIMO_DE_ENTRADAS };
