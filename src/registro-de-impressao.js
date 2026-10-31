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
 * Quantas vezes uma MESMA etiqueta pode ir para a impressora por recuperação.
 *
 * ⚠️ Duas, não uma: a primeira tentativa pode ter morrido antes de o papel
 * sair, e aí a segunda é a impressão de verdade. A terceira já seria teimosia
 * — se duas saídas não resolveram, o problema não é falta de tentativa.
 */
const MAXIMO_DE_TENTATIVAS = 2;

/**
 * Por quantas horas uma dúvida ainda é dúvida.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ DÚVIDA TEM PRAZO, E ÓRFÃO EM `enviando` NÃO EXPIRAVA (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * A poda só removia entrada `confirmado`, e `'enviando'` nasce com
 * `confirmado: false` — então um job que morreu no meio do envio e nunca
 * mais foi oferecido pelo Hub ficava no registro **para sempre**: ia em
 * `?suspeitos=` de todo pull, contava para o teto de entradas e impedia a
 * própria poda de liberar espaço. Numa máquina instável o arquivo cresce
 * sem teto e a lista de suspeitos vira lixo que sinaliza o que não é.
 *
 * 6 horas é folgado de propósito: o pull do Hub só olha as últimas 2 h
 * (`JANELA_DE_PENDENTES_H`), então uma dúvida de 6 h já não pode voltar
 * pelo pull. Passado isso ela não informa mais nada — e marca o papel por
 * engano se o job reaparecer por outro caminho.
 *
 * ⚠️ Podar `'enviando'` NÃO perde notícia para o Hub: `pendentesDeConfirmacao`
 * nunca manda esse estado como ACK, justamente porque não há desfecho a
 * contar. A regra "não poda o que não foi confirmado" vale para quem TEM
 * desfecho e não conseguiu entregá-lo.
 */
const HORAS_DE_DUVIDA = 6;

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
    const limiteDaDuvida = agora() - HORAS_DE_DUVIDA * 3600000;
    for (const [uuid, item] of Object.entries(dados)) {
      // ⚠️ Nunca poda o que ainda não foi confirmado: aquele ACK é a única
      // notícia que o Hub vai receber.
      if (item.confirmado && item.em < limite) { delete dados[uuid]; continue; }
      // ⚠️ Exceção: `'enviando'` velho. Ele não tem ACK a entregar (ver
      // `HORAS_DE_DUVIDA`) e, sem isto, nunca saía do registro.
      if (item.estado === 'enviando' && item.em < limiteDaDuvida) delete dados[uuid];
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
     * O que sabemos deste job: `'enviando'`, `'impresso'` ou `null`.
     *
     * ⚠️ `'enviando'` existe por causa da duplicata medida em 30/10/2026: o
     * cliente entregou a etiqueta no destino, o app foi fechado ANTES de
     * registrar a entrega, e a recuperação imprimiu de novo. A janela entre
     * "os bytes saíram" e "anotei que saíram" é real, e nenhuma ordem de
     * gravação a elimina — ela só escolhe o lado do erro:
     *
     *   gravar DEPOIS  → risco de DUPLICAR (o que acontecia)
     *   gravar ANTES   → risco de PERDER (pior para etiqueta)
     *
     * Gravando os dois momentos, o estado `'enviando'` sem `'impresso'` vira
     * informação: "pode ter saído". Quem decide o que fazer com isso é o
     * chamador — e hoje a decisão é imprimir de novo, porque o servidor
     * marca a recuperação como REIMPRESSAO no papel.
     */
    estadoDe: (jobUuid) => (jobUuid && dados[jobUuid] ? dados[jobUuid].estado || 'impresso' : null),

    /**
     * Registra que o job está SAINDO agora — antes de qualquer byte.
     *
     * ⚠️ Grava em disco na hora (sem debounce): o ponto inteiro é sobreviver
     * a um fechamento que aconteça nos próximos milissegundos.
     */
    marcarEnviando(jobUuid) {
      if (!jobUuid) return;
      const anterior = dados[jobUuid];
      // Job que já teve desfecho não volta para `enviando`.
      if (anterior && anterior.estado !== 'enviando') return;
      dados[jobUuid] = {
        em: anterior ? anterior.em : agora(),
        estado: 'enviando',
        status: null,
        erro: null,
        confirmado: false,
        /*
         * ⚠️ O CONTADOR é o que impede a avalanche de papel. Achado pelo
         * ensaio de caos: um job que morre SEMPRE depois do envio (o papel
         * saiu, o registro não soube) é reoferecido pelo pull e reimpresso
         * de novo, e de novo — foram 4 saídas da mesma etiqueta numa das
         * sementes. Sem teto, uma máquina instável vira uma pilha de
         * duplicatas.
         */
        tentativas: (anterior && anterior.tentativas ? anterior.tentativas : 0) + 1,
      };
      salvar();
    },

    /**
     * O Hub reofereceu um job que já imprimimos — então ele NÃO recebeu o
     * nosso ACK, por mais que o MQTT tenha confirmado a entrega ao broker.
     *
     * ⚠️ Sem isto o job volta em TODO pull, para sempre: medido em
     * 30/10/2026, dois jobs ficaram nesse laço (23:03, 23:05, 23:07, 23:08,
     * 23:12…). O cliente os tinha como confirmados e nunca os reenviava; o
     * Hub nunca soube. Na tela, "enviada e não confirmada" que não some.
     */
    precisaReconfirmar(jobUuid) {
      if (!jobUuid || !dados[jobUuid]) return false;
      if (!dados[jobUuid].confirmado) return true;
      dados[jobUuid].confirmado = false;
      return true;
    },

    /**
     * Registra que o job foi entregue à impressora. Idempotente: não
     * sobrescreve o instante original, que é o que a poda usa.
     */
    marcarImpresso(jobUuid, status, erro) {
      if (!jobUuid) return;
      const anterior = dados[jobUuid];
      /*
       * ⚠️ O PRIMEIRO desfecho é o que vale: um job já `'impresso'` não é
       * reescrito por uma segunda chamada (foi assim desde sempre, e o caso
       * que trava isso está no teste). O que mudou é que o estado
       * `'enviando'` AVANÇA — senão o `marcarEnviando` deixaria todo job
       * preso no intermediário e `pendentesDeConfirmacao` nunca o veria.
       */
      if (anterior && anterior.estado !== 'enviando') return;
      dados[jobUuid] = {
        em: anterior ? anterior.em : agora(),
        estado: 'impresso',
        status: status === 'error' ? 'error' : 'success',
        erro: erro || null,
        confirmado: anterior ? Boolean(anterior.confirmado) : false,
      };
    },

    /** O Hub aceitou o ACK deste job. */
    marcarConfirmado(jobUuid) {
      if (dados[jobUuid]) dados[jobUuid].confirmado = true;
    },

    /**
     * Pode mandar este job para a impressora de novo?
     *
     * ⚠️ `false` NÃO é "esqueça": é "pare de reimprimir sozinho". O job fica
     * no Hub como não confirmado e aparece na tela como "enviada e não
     * confirmada" — e aí **uma pessoa** decide, olhando o papel que tem na
     * mão. Entre uma pilha de duplicatas automáticas e uma linha na tela
     * pedindo conferência, a segunda é sempre melhor.
     */
    podeReimprimir(jobUuid, maximo = MAXIMO_DE_TENTATIVAS) {
      const item = jobUuid && dados[jobUuid];
      if (!item) return true;
      if (item.estado !== 'enviando') return false;
      return (item.tentativas || 1) < maximo;
    },

    /** Os ACKs que o Hub ainda não aceitou — o que vai por HTTP. */
    pendentesDeConfirmacao() {
      return Object.entries(dados)
        // ⚠️ `'enviando'` ainda não tem desfecho: confirmar agora diria ao
        // Hub que saiu uma etiqueta que talvez não tenha saído.
        .filter(([, item]) => !item.confirmado && item.estado !== 'enviando')
        .sort((a, b) => a[1].em - b[1].em)
        .map(([job_uuid, item]) => ({ job_uuid, status: item.status, error: item.erro }));
    },

    /**
     * Os jobs em `'enviando'`: fomos ao papel e nunca soubemos o desfecho.
     *
     * ══════════════════════════════════════════════════════════════════════
     * 🚨 ESTA É A ÚNICA DÚVIDA REAL, E É O HUB QUE PRECISA SABER (30/10/2026)
     * ══════════════════════════════════════════════════════════════════════
     * O pull do Hub carimbava `REIMPRESSAO` em tudo que ele reentregava,
     * porque do lado dele a única informação é "entreguei e não recebi ACK".
     * Medido em dois ensaios de queda com identidade por etiqueta: das 19
     * recuperadas em cada leva, **19 eram inéditas** — 38 etiquetas marcadas
     * como 2ª via sem nunca ter saído. E quem lê "REIMPRESSAO" **descarta**:
     * é perda de trabalho silenciosa, pior que a duplicata que a marca
     * tentava evitar.
     *
     * Quem sabe é este registro. Três situações, e só uma é dúvida:
     *   sem entrada        nunca vimos o job        ⇒ inédita
     *   `'impresso'`       saiu                     ⇒ nem reimprime
     *   `'enviando'`       morreu ENTRE o envio e
     *                      o registro do desfecho  ⇒ PODE ter saído
     *
     * O pull manda esta lista, e só ela recebe marca no papel. Na prática
     * são 1 a 3 itens: `'enviando'` só sobrevive a um desastre.
     *
     * ⚠️ Ordenado do mais recente para o mais antigo e com teto: a lista vai
     * na URL do pull, e o servidor descarta lista absurda INTEIRA (ver
     * `rotulo-da-recuperacao.ts` no backend). Mandar os mais recentes é o
     * que preserva a marca justamente no job da queda que acabou de
     * acontecer.
     */
    emEnviando(maximo = 20) {
      const limite = agora() - HORAS_DE_DUVIDA * 3600000;
      return Object.entries(dados)
        // ⚠️ Dúvida vencida não é dúvida: ver `HORAS_DE_DUVIDA`. Sem este
        // recorte, órfão antigo marcaria papel por engano.
        .filter(([, item]) => item.estado === 'enviando' && (item.em || 0) >= limite)
        .sort((a, b) => (b[1].em || 0) - (a[1].em || 0))
        .slice(0, maximo)
        .map(([job_uuid]) => job_uuid);
    },

    /** Grava em disco (com poda). Chamado UMA vez por lote, não por etiqueta. */
    salvar,

    /** Só para diagnóstico. */
    tamanho: () => Object.keys(dados).length,
  };
}

module.exports = {
  criarRegistroDeImpressao,
  HORAS_DE_DUVIDA,
  HORAS_DE_MEMORIA,
  MAXIMO_DE_ENTRADAS,
  MAXIMO_DE_TENTATIVAS,
};
