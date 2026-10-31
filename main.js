'use strict'

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell, Notification } = require('electron')

Menu.setApplicationMenu(null)
const path   = require('path')
const os     = require('os')
const { v4: uuidv4 } = require('uuid')

// electron-store v8 é ESM — usar dynamic import
let Store
let store
let mqtt
let axios
let pdfPrint

// ─── Constantes ──────────────────────────────────────────────────────────────

const HUB_API   = process.env.HUB_API_URL   || 'https://api.maximushub.com.br/api/v1'
const HUB_MQTT  = process.env.HUB_MQTT_URL  || 'wss://api.maximushub.com.br/mqtt'
const APP_VERSION = require('./package.json').version

// ─── Estado global ───────────────────────────────────────────────────────────

let tray            = null
let loginWin        = null
let setupWin        = null
let mqttClient      = null
let trayStatus      = 'desconectado'
let updateDownloaded = false
let autoUpdater     = null

// ─── Instância única ─────────────────────────────────────────────────────────
//
// ══════════════════════════════════════════════════════════════════════════
// 🚨 DUAS INSTÂNCIAS BRIGAM PELO MESMO clientId — E A BRIGA APAGA IMPRESSORA
// ══════════════════════════════════════════════════════════════════════════
// A janela fecha para a bandeja (`window-all-closed` é prevenido) e o app
// abre sozinho no login do Windows (`openAtLogin`). Quem clica no atalho
// porque "não está aberto" sobe uma SEGUNDA instância — com o mesmo
// `agent_uuid` do electron-store e o mesmo usuário.
//
// O clientId do MQTT é `agent_<uid>_<uuid>`: duas conexões com o mesmo id
// fazem o broker derrubar uma toda vez que a outra entra, e o derrubado volta
// em 5 s (`reconnectPeriod`). Medido em 30/10/2026 no agente 33 (`vaio77`):
// ~20 takeovers entre 11:24:49 e 11:26:35 UTC.
//
// Cada reconexão disparava um sync de impressoras, e um deles chegou ao
// servidor com a lista VAZIA — apagando as 4 impressoras do agente, que
// voltaram sem tipo, sem compartilhamento e sem `shared_with_account`.
//
// ⚠️ O lock tem de vir ANTES do `whenReady`: pedir depois deixa a segunda
// instância subir, conectar no MQTT e só então sair.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Clicou no atalho de novo: em vez de abrir outro app, traz a janela.
  app.on('second-instance', () => {
    if (setupWin) {
      if (setupWin.isMinimized()) setupWin.restore()
      setupWin.focus()
    } else if (store && store.get('token')) {
      abrirSetup()
    } else {
      abrirLogin()
    }
  })
}

// ─── Boot ────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Imports dinâmicos (electron-store v8 é ESM puro)
  const { default: ElectronStore } = await import('electron-store')
  Store = ElectronStore
  store = new Store({
    name: 'maximushub-print-client',
    encryptionKey: 'mhub-prt-2024',
  })

  axios = require('axios')
  mqtt  = require('mqtt')

  // pdf-to-printer carrega em qualquer sistema e só recusa na hora de
  // imprimir. No Mac esse require "dava certo" e o `lp` nunca era chamado.
  if (process.platform === 'win32') {
    try { pdfPrint = require('pdf-to-printer') } catch (_) { pdfPrint = null }
  }

  app.setLoginItemSettings({ openAtLogin: true })

  criarTray()
  setupAutoUpdater()

  const token = store.get('token')
  if (!token) {
    abrirLogin()
  } else {
    registrarAgente(token).then(() => conectarMqtt(token))
    // Verifica atualização na inicialização e a cada 5 min
    verificarAtualizacao()
    setInterval(verificarAtualizacao, 5 * 60 * 1000)
  }
})

app.on('window-all-closed', (e) => e.preventDefault()) // mantém rodando no tray

// ─── Tray ────────────────────────────────────────────────────────────────────

function criarTray () {
  const iconPath = path.join(__dirname, 'assets', 'icon-tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('MaximusHub Print Client')
  tray.on('double-click', abrirSetup)
  atualizarTray('desconectado')
}

function atualizarTray (status) {
  if (!tray) return
  trayStatus = status

  const labels = {
    conectado:    '● Conectado ao MaximusHub',
    desconectado: '○ Desconectado',
    conectando:   '◌ Conectando...',
  }

  const items = [
    { label: labels[status] || labels.desconectado, enabled: false },
    { type: 'separator' },
    { label: 'Gerenciar Impressoras', click: abrirSetup },
  ]

  if (status !== 'conectado') {
    items.push({ label: 'Reconectar', click: reconectar })
  }

  if (updateDownloaded) {
    items.push({ type: 'separator' })
    items.push({
      label: '⬆ Instalar atualização agora',
      click: () => {
        if (autoUpdater) autoUpdater.quitAndInstall(true, true)
      },
    })
  }

  items.push({ type: 'separator' })
  // Para quem está na expedição conseguir mandar o log sem mexer em pasta.
  items.push({
    label: 'Abrir log de impressão',
    click: () => shell.openPath(caminhoDoLog()),
  })
  items.push({ label: `Sair (v${APP_VERSION})`, click: () => app.quit() })

  tray.setContextMenu(Menu.buildFromTemplate(items))
}

// ─── Janela de Login ─────────────────────────────────────────────────────────

function abrirLogin () {
  if (loginWin) { loginWin.focus(); return }

  loginWin = new BrowserWindow({
    width: 420, height: 520,
    resizable: false, center: true,
    title: 'MaximusHub Print Client',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })

  loginWin.loadFile(path.join(__dirname, 'src', 'login.html'))
  loginWin.on('closed', () => { loginWin = null })
}

// ─── Janela de Setup (gerenciar impressoras) ──────────────────────────────────

function abrirSetup () {
  if (setupWin) { setupWin.focus(); return }

  setupWin = new BrowserWindow({
    width: 680, height: 560,
    resizable: true, center: true,
    title: 'Impressoras — MaximusHub',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })

  setupWin.loadFile(path.join(__dirname, 'src', 'setup.html'))
  setupWin.on('closed', () => { setupWin = null })
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────

function conectarMqtt (token) {
  const agentUuid = garantirAgentUuid()
  const userId    = store.get('user_id')
  if (!userId) { abrirLogin(); return }

  atualizarTray('conectando')

  if (mqttClient) {
    mqttClient.end(true)
    mqttClient = null
  }

  mqttClient = mqtt.connect(HUB_MQTT, {
    clientId:           `agent_${userId}_${agentUuid}`,
    username:           token,
    password:           '',
    reconnectPeriod:    5000,
    connectTimeout:     15000,
    keepalive:          30,
    /*
     * ══════════════════════════════════════════════════════════════════════
     * ⚠️ `clean: true` É DECISÃO MEDIDA — e o buraco que ela abre tem tampa
     * ══════════════════════════════════════════════════════════════════════
     * Sessão limpa significa que o que o Hub publica enquanto este cliente
     * está fora NÃO é guardado por ninguém: o broker descarta (sessão limpa)
     * e o Redis pub/sub não tem durabilidade. Em 30/10/2026 o agente
     * `vaio77` ficou 32 segundos desconectado — das 12:12:09 às 12:12:41
     * UTC — e **73 etiquetas publicadas nesse intervalo evaporaram**.
     * Ficaram `sent` para sempre e o operador só percebeu contando o papel.
     * Nos 14 dias anteriores foram 720 assim, em três computadores.
     *
     * `clean: false` parece a correção óbvia, e foi escrita e revertida no
     * mesmo dia: a sessão do aedes vive na MEMÓRIA do broker e não tem teto
     * por cliente. Uma etiqueta pesa ~50 KB; um agente esquecido ligado num
     * balcão fechado acumularia centenas de megabytes de mensagens que
     * ninguém quer mais — e derrubar o broker tira a impressão de TODO
     * mundo, para salvar a de um.
     *
     * A tampa ficou no servidor, onde dá para impor limite: quando um agente
     * reconecta, o Hub reentrega o que ficou sem ACK — com janela de 30 min,
     * teto por reconexão e uma única reentrega por etiqueta. Ver
     * `backend-novo/src/impressao/reenvio-de-jobs-sem-ack.ts`. Isso também
     * vale para o parque inteiro HOJE, sem esperar o auto-update máquina a
     * máquina.
     *
     * ⚠️ O `clientId` continua tendo de ser estável (`agent_<uid>_<uuid>`) —
     * é por ele que o servidor sabe quem voltou.
     */
    clean:              true,
    protocolVersion:    4,
  })

  mqttClient.on('connect', async () => {
    atualizarTray('conectado')
    mqttClient.subscribe(`hub/print/${userId}/${agentUuid}`, { qos: 1 })
    notificar('MaximusHub', 'Print Client conectado e pronto.')
    await sincronizarImpressoras(token, agentUuid)
    /*
     * ⚠️ CONTINUIDADE: ao voltar, a primeira coisa é perguntar o que ficou
     * sem confirmação e reconfirmar o que já saiu no papel. Era exatamente
     * aqui que a etiqueta se perdia — o que o Hub publicou enquanto este
     * cliente estava fora não existe em lugar nenhum, e só o pull o traz de
     * volta. Ver `puxarPendentes`.
     *
     * ⚠️ Os ACKs vão PRIMEIRO: se o Hub ainda não sabe o que já imprimimos,
     * ele oferece esses jobs de novo e o pull teria de descartá-los um por
     * um. Confirmar antes encurta a lista na origem.
     */
    await enviarAcksPendentes()
    await puxarPendentes()
    ligarRotinasDeContinuidade()
  })

  mqttClient.on('message', (topic, payload) => {
    try {
      const job = JSON.parse(payload.toString())
      // ⚠️ NÃO imprime aqui — enfileira. Ver `enfileirar` e o cabeçalho da
      // seção de impressão: imprimir direto no handler fazia uma chamada ao
      // SumatraPDF por etiqueta, e era isso que criava a pausa entre uma e
      // outra. Também não havia fila: dois `await` em voo podiam disputar a
      // mesma impressora e inverter a ordem do papel.
      enfileirar(job, userId)
    } catch (err) {
      console.error('[MQTT] Erro ao ler job:', err.message)
    }
  })

  mqttClient.on('error', (err) => {
    console.error('[MQTT] Erro:', err.message)
    atualizarTray('desconectado')
  })

  mqttClient.on('offline', () => atualizarTray('desconectado'))
  mqttClient.on('reconnect', () => atualizarTray('conectando'))
}

function reconectar () {
  const token = store.get('token')
  if (token) conectarMqtt(token)
  else abrirLogin()
}

// ─── Impressão ────────────────────────────────────────────────────────────────
//
// ══════════════════════════════════════════════════════════════════════════
// ⚠️ POR QUE EXISTE UMA FILA, E POR QUE ELA AGRUPA (09/10/2026)
// ══════════════════════════════════════════════════════════════════════════
// Reclamação: "a cada etiqueta que sai tem uma pequena pausa pra iniciar a
// próxima, não é contínuo".
//
// Medido no Hub: **99% dos jobs são de UMA etiqueta** (8.606 de 8.676 num dia)
// e o servidor publica a cada ~0,5 s. Ou seja, o gargalo não era o envio — era
// o que este arquivo fazia com cada job: reescrever o PDF, gravar um arquivo
// temporário e **chamar o SumatraPDF**. Criar esse processo, carregar o PDF,
// falar com o spooler e fechar custa centenas de milissegundos — por etiqueta.
// É exatamente a pausa que a expedição vê entre uma e outra.
//
// A correção não é "deixar mais rápido": é **parar de fazer N vezes o que
// pode ser feito uma vez**. As etiquetas de uma rajada viram UM PDF de N
// páginas e UMA chamada à impressora; o papel sai contínuo, que é como a
// térmica trabalha melhor.
//
// ⚠️ **Sem janela de espera, de propósito.** O agrupamento é oportunista: a
// fila ociosa dispara NA HORA com o que tiver (uma etiqueta avulsa continua
// instantânea, sem nenhum atraso novo); as que chegam ENQUANTO o lote
// imprime se acumulam e saem juntas no ciclo seguinte. Quanto maior a
// rajada, maior o lote — sem nenhum temporizador para calibrar, e sem
// penalizar o clique único, que é o caso mais comum fora da onda.
//
// ⚠️ **Uma fila por DESTINO** (impressora + tipo + escala). Misturar
// impressoras numa fila só serializaria duas que podiam imprimir em paralelo;
// misturar escalas num PDF só é impossível — a escala é do documento inteiro.
//
// ⚠️ **Lote que falha é refeito UM A UM.** Um PDF corrompido no meio não pode
// derrubar as outras 24 etiquetas: o erro vira ACK só para quem falhou.

/**
 * ⚠️ **O LOG EM ARQUIVO** (09/10/2026). Três versões seguidas tentaram tirar
 * a pausa entre etiquetas e nenhuma pôde ser verificada: o `console.log` de
 * um app de bandeja não vai a lugar nenhum, e a máquina está a 400 km. O
 * diagnóstico virou palpite — e dois palpites erraram.
 *
 * Agora toda decisão de impressão fica em `print.log`, ao lado da
 * configuração, e o menu da bandeja abre o arquivo. É o que permite
 * responder "o comando chegou na impressora?" sem adivinhar.
 *
 * ⚠️ Rotação simples por tamanho: um log que cresce sem limite num
 * computador de expedição vira um problema pior que o que ele resolve.
 */
const LIMITE_DO_LOG = 2 * 1024 * 1024

function caminhoDoLog () {
  return path.join(app.getPath('userData'), 'print.log')
}

/** O registro do que já foi impresso (ver `src/registro-de-impressao.js`). */
function caminhoDoRegistro () {
  return path.join(app.getPath('userData'), 'impressos.json')
}

function registrar (mensagem) {
  const linha = `${new Date().toISOString()} ${mensagem}`
  console.log(linha)
  try {
    const fs = require('fs')
    const arquivo = caminhoDoLog()
    try {
      if (fs.statSync(arquivo).size > LIMITE_DO_LOG) {
        fs.renameSync(arquivo, `${arquivo}.1`)
      }
    } catch (_) { /* ainda não existe */ }
    fs.appendFileSync(arquivo, linha + '\n')
  } catch (_) { /* log nunca pode derrubar impressão */ }
}

// ⚠️ O require vem ANTES do uso: `const` tem TDZ, e chamar
// `criarRegistroDeImpressao` acima desta linha é ReferenceError em runtime —
// que o `node --check` NÃO acusa, porque ele só vê sintaxe. O caso que trava
// isso está em `src/registro-de-impressao.test.js`.
const { criarRegistroDeImpressao } = require('./src/registro-de-impressao')
const { interpretarLogin, metodosQuePrecisamEnvio, mensagemDeConfiguracao } = require('./src/resposta-de-login')
const { decidirSobreJob, aplicarDecisaoDoJob } = require('./src/decisao-do-job')
const {
  decidirReinicio,
  explicarReinicio,
  INTERVALO_DE_TENTATIVA_MS,
} = require('./src/atualizacao-critica')

/**
 * O REGISTRO do que já saiu no papel — `src/registro-de-impressao.js`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 ELE É O QUE TORNA O PULL SEGURO (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * O Hub passou a OFERECER os jobs que publicou e não teve ACK, e o cliente
 * passou a puxá-los ao conectar. Sem memória em disco isso reimprimiria o
 * que já saiu — o job volta na lista justamente porque o ACK se perdeu, e o
 * ACK se perde DEPOIS de a etiqueta sair da impressora.
 *
 * ⚠️ Gravação ATÔMICA (arquivo temporário + rename): o processo pode ser
 * fechado no meio de um lote, e um JSON truncado seria lido como "nunca
 * imprimi nada" — o pior estado possível aqui.
 */
const registroDeImpressao = criarRegistroDeImpressao({
  ler: () => {
    const fs = require('fs')
    return JSON.parse(fs.readFileSync(caminhoDoRegistro(), 'utf8'))
  },
  gravar: (dados) => {
    const fs = require('fs')
    const destino = caminhoDoRegistro()
    const temporario = `${destino}.tmp`
    fs.writeFileSync(temporario, JSON.stringify(dados))
    fs.renameSync(temporario, destino)
  },
})

const { criarFilaDeImpressao } = require('./src/fila-impressao')
const { scriptPowerShell, comandoPowerShell, argumentosPowerShell, tetoDoEnvioRaw } = require('./src/envio-raw-windows')
const { criarPreparoDeImpressora, comandoDesligarBidi, colarNaEtiqueta } = require('./src/preparo-impressora')
const {
  canalDePdf,
  canalDeZpl,
  argumentosDePdf,
  argumentosDeZplRaw,
  interpretarLpstat,
  argumentosDeEstadoDaFila,
  filaEstaPausada,
} = require('./src/impressao-cups')

/**
 * O preparo da impressora — `src/preparo-impressora.js`.
 *
 * ⚠️ Roda ANTES do lote, não antes de cada etiqueta: `~JSO` é configuração
 * PERSISTENTE na impressora, e repetir só enfileira trabalho no spooler.
 * Nunca lança: preparo é otimização, e uma falha aqui não pode impedir a
 * etiqueta de sair.
 */
const preparoDeImpressora = criarPreparoDeImpressora({
  // ⚠️ O destino vem do PREPARO, que o recebe do job: comando de configuração
  // tem de ir pelo mesmo caminho da etiqueta (ver `preparo-impressora.js`).
  enviarZpl: (nome, texto, destino = {}) =>
    imprimirZpl(Buffer.from(texto, 'ascii'), destino.zplHost || null, destino.zplPort || null, nome),
  /**
   * Desliga o suporte BIDIRECIONAL da fila do Windows — a correção que a
   * própria Zebra indica para "long delay between print jobs" em impressora
   * USB. É configuração do SPOOLER, não da impressora, e por isso dá para
   * aplicar daqui sem ninguém abrir tela.
   */
  desligarBidi: async (nome) => {
    /*
     * ⚠️ ASSÍNCRONO pelo mesmo motivo do envio RAW (ver `imprimirZpl`): isto
     * roda ANTES DE CADA LOTE, no caminho crítico. Com `execSync` eram até
     * 15 s de event loop parado por lote, somados aos do envio — e é assim
     * que o keepalive de 30 s do MQTT estoura e o broker derruba o cliente,
     * levando com ele as etiquetas publicadas no intervalo.
     */
    const { execFile } = require('child_process')
    if (process.platform !== 'win32') return 'ignorado_fora_do_windows'
    const ps = comandoDesligarBidi(nome)
    const saida = await new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { timeout: 15000, windowsHide: true },
        (erro, stdout, stderr) => {
          if (erro) {
            if (stderr) erro.stderr = stderr
            return reject(erro)
          }
          resolve(stdout)
        },
      )
    })
    return String(saida).trim() || 'sem_retorno'
  },
  registrar: (m) => registrar(`[preparo] ${m}`),
})

/**
 * A fila — a regra mora em `src/fila-impressao.js` (pura, com teste). Aqui
 * ficam só as PONTAS: falar com a impressora e publicar o ACK no MQTT.
 */
const filaDeImpressao = criarFilaDeImpressao({
  imprimir: async (lote) => {
    const { job } = lote[0]
    /*
     * ══════════════════════════════════════════════════════════════════════
     * 🚨 O REGISTRO VEM ANTES DOS BYTES (30/10/2026)
     * ══════════════════════════════════════════════════════════════════════
     * Medido byte a byte no teste da queda: o job 223216 foi entregue no
     * destino, o app foi fechado ANTES de o cliente anotar a entrega, e a
     * recuperação imprimiu de novo — duas etiquetas iguais no balcão.
     *
     * A janela entre "os bytes saíram" e "anotei que saíram" não desaparece;
     * a ordem só escolhe o lado do erro. Gravando `enviando` ANTES, o estado
     * passa a existir mesmo que o processo morra no meio — e o servidor
     * marca toda recuperação como REIMPRESSAO no papel, então o pior caso
     * vira uma etiqueta identificada, não um sósia.
     */
    for (const item of lote) registroDeImpressao.marcarEnviando(item.job.job_uuid)
    const buffers = lote.map((i) => Buffer.from(i.job.data, 'base64'))
    // ⚠️ Antes do lote: desliga o backfeed na Zebra, que é o "recalibrar"
    // entre uma etiqueta e outra. Só vale para impressora que fala ZPL e por
    // isso a detecção é pelo nome — ver `preparo-impressora.js`.
    //
    // ⚠️ `linguagem` vem do JOB: num lote ZPL a impressora já trocou de modo
    // ao ver o `^XA`, e o comando certo é o `~JSO`, mesmo que o driver
    // instalado no Windows seja o EPL.
    const opcoesDePreparo = {
      ...obterPreparo(job.printer_system_name),
      ...(job.type === 'zpl' ? { linguagem: 'zpl' } : {}),
      // Mesmo destino do job: socket quando a Zebra tem IP, spooler quando não.
      zplHost: job.zpl_host || null,
      zplPort: job.zpl_port || null,
    }

    /*
     * ══════════════════════════════════════════════════════════════════════
     * 🚨 O PREPARO VAI COLADO NA ETIQUETA, NÃO NUMA CHAMADA PRÓPRIA
     * ══════════════════════════════════════════════════════════════════════
     * Medido no `print.log` da RDF em 31/10/2026 (16 filas instaladas):
     *   os 5 bytes do `~JSA` sozinhos .... 16.182 ms
     *   41 KB (1 etiqueta) .............. 2.425 ms
     *   335 KB (9 etiquetas) ............ 2.687 ms
     * O custo é ABRIR a impressora no spooler, não o volume. Duas chamadas
     * custavam duas aberturas; colado, abre uma — e some o maior pedaço dos
     * 31 s que a primeira etiqueta de cada lote levava naquela máquina.
     *
     * ⚠️ `comandoColado` devolve `null` em tudo que não for seguro colar
     * (PDF, impressora que não fala ZPL, linguagem do job diferente da do
     * driver, preparo recente). Nesses casos o caminho ANTIGO roda igual, e
     * o comportamento é o de hoje — é o que garante que nada piora onde já
     * estava bom.
     *
     * ⚠️ O preparo só é CONTADO depois do envio dar certo: se a etiqueta
     * falhar, a impressora não recebeu o comando e a próxima tem de tentar
     * de novo.
     */
    const colado =
      job.type === 'zpl'
        ? preparoDeImpressora.comandoColado(job.printer_system_name, opcoesDePreparo)
        : null
    if (!colado) await preparoDeImpressora.preparar(job.printer_system_name, opcoesDePreparo)

    if (job.type === 'zpl') {
      // ⚠️ ZPL é um fluxo de comandos (`^XA`…`^XZ` por etiqueta): concatenar
      // é o formato nativo de mandar várias. Um socket, não N.
      const corpo = Buffer.concat(buffers)
      const comPreparo = colarNaEtiqueta(colado && colado.texto, corpo)
      await imprimirZpl(comPreparo, job.zpl_host, job.zpl_port || 9100, job.printer_system_name, buffers.length)
      if (colado) {
        preparoDeImpressora.confirmarPreparo(colado.chave)
        registrar(`[preparo] ${job.printer_system_name}: comando foi COLADO na etiqueta (uma abertura só)`)
      }
    } else {
      await imprimirPdf(buffers, job.printer_system_name, job.escala)
    }

    /*
     * ⚠️ O BIDIRECIONAL SAI DO CAMINHO CRÍTICO (31/10/2026).
     * Medido na RDF: 11.610 ms de consulta WMI ANTES da primeira etiqueta.
     * Ele é otimização para as etiquetas SEGUINTES (tira a pausa entre
     * elas), então esperar por ele antes do papel começar a sair é pagar o
     * custo na hora errada. Agora roda depois, e sem `await`.
     *
     * ⚠️ `void` + `.catch` de propósito: falha aqui nunca pode derrubar uma
     * impressão que já deu certo — era assim antes e continua.
     */
    if (colado && preparoDeImpressora.desligarBidiDepois) {
      void preparoDeImpressora.desligarBidiDepois(job.printer_system_name, opcoesDePreparo)
    }
  },
  /**
   * O ACK — e ele passou a ter GARANTIA (30/10/2026).
   *
   * ══════════════════════════════════════════════════════════════════════
   * 🚨 O ACK SE PERDIA EXATAMENTE QUANDO IMPORTAVA
   * ══════════════════════════════════════════════════════════════════════
   * Publicar no MQTT era a única notícia que o Hub recebia — e o cliente
   * publica na conexão que acabou de cair. Com `clean: true`, a confirmação
   * evapora junto: a etiqueta saiu no papel e o Hub segue achando que não,
   * o que faz o operador reimprimir e a tela mentir. Em 7 dias foram 1.298
   * jobs nesse estado (os números estão em `registro-de-impressao.js`).
   *
   * Agora são três passos, nesta ordem:
   *  1. **gravar no registro local** que a etiqueta saiu — ANTES de
   *     qualquer rede. É o que impede o pull de reimprimir;
   *  2. publicar no MQTT **com callback de QoS 1**: o callback só é chamado
   *     quando o PUBACK chega, ou seja, quando o broker confirmou que
   *     recebeu. Sem PUBACK, o ACK continua pendente no registro;
   *  3. o que ficar pendente vai por **HTTP** na varredura (ver
   *     `enviarAcksPendentes`), que é o caminho que não depende da sessão
   *     que caiu.
   *
   * ⚠️ `mqttClient` ausente NÃO é mais um `return` cego: antes, imprimir
   * offline significava papel na mão e nenhum registro em lugar nenhum.
   */
  confirmar: (item, status, erro) => {
    registroDeImpressao.marcarImpresso(item.job.job_uuid, status, erro)
    /*
     * ⚠️ SÍNCRONO, não agendado. O debounce de 1 s não sobrevive a um
     * fechamento que aconteça no intervalo — e foi exatamente nesse
     * intervalo que a duplicata de 30/10/2026 nasceu. O custo é uma
     * gravação de poucos KB por etiqueta; o da alternativa é papel duplo.
     */
    registroDeImpressao.salvar()
    if (!mqttClient || !mqttClient.connected) {
      // Fica pendente de propósito: o HTTP resolve.
      registrar(`[ack] ${item.job.job_uuid}: MQTT offline — fica pendente para o HTTP`)
      agendarAcksPendentes()
      return
    }
    mqttClient.publish(
      `hub/ack/${item.userId}/${item.job.job_uuid}`,
      JSON.stringify({ job_uuid: item.job.job_uuid, status, error: erro }),
      { qos: 1 },
      (erroDoPublish) => {
        if (erroDoPublish) {
          /*
           * ⚠️ LOGADO (31/10/2026). Este caminho era MUDO, e isso custou
           * tempo: a sessão que operava a VM procurou no `print.log` o ACK
           * de 40 etiquetas e não achou nenhum — nem das 39 que o banco
           * provava confirmadas. Ausência de linha não distinguia "não
           * mandou" de "mandou e não logou", e sem isso não há como provar
           * o ACK pelo lado do cliente.
           */
          registrar(`[ack] ${item.job.job_uuid}: MQTT falhou (${erroDoPublish.message || erroDoPublish}) — vai por HTTP`)
          agendarAcksPendentes()
          return
        }
        // PUBACK recebido: o broker tem o ACK.
        registroDeImpressao.marcarConfirmado(item.job.job_uuid)
        registrar(`[ack] ${item.job.job_uuid} confirmado por MQTT (${status})`)
        agendarGravacaoDoRegistro()
      },
    )
  },
  registrar: (m) => registrar(`[fila] ${m}`),
})

// ─── Continuidade: o cliente PUXA o que falta e GARANTE o ACK ───────────────
/*
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 POR QUE O CLIENTE PASSOU A PUXAR (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * O desenho era PUSH e volátil: o Hub publicava no tópico e, se o agente não
 * estivesse no ar naquele segundo, a etiqueta morria (`clean: true` + Redis
 * pub/sub sem durabilidade). Em 7 dias, 1.298 jobs publicados no vácuo — 73%
 * de tudo que a RDF mandou em ZPL.
 *
 * A reentrega por reconexão, feita no servidor, foi o primeiro remendo e não
 * fecha: depende de um EVENTO acontecer, tem carência de 3 min, janela e
 * teto. No lote das 16:35 do dia 30/10 o agente perdeu 120 etiquetas e não
 * reconectou depois — nada as recuperou.
 *
 * Quem sabe o que falta é o CLIENTE: ele tem o registro em disco do que saiu
 * no papel. Então ele pergunta — ao conectar e a cada 2 minutos — e o
 * `enfileirar` descarta o que já imprimiu, reconfirmando em vez de gastar
 * papel. "Continuar de onde parou" deixa de ser recuperação de incidente e
 * passa a ser o comportamento normal.
 */

/** De quanto em quanto tempo perguntar ao Hub o que falta imprimir. */
const INTERVALO_DE_PULL_MS = 2 * 60 * 1000
/** De quanto em quanto tempo reenviar por HTTP o ACK que o MQTT não levou. */
const INTERVALO_DE_ACKS_MS = 30 * 1000

let temporizadorDeGravacao = null
let temporizadorDeAcks = null
let pullEmCurso = false

/**
 * Grava o registro em disco UMA vez por rajada.
 *
 * ⚠️ Debounce de propósito: gravar por etiqueta seria uma ida ao disco por
 * etiqueta num lote de 25. O atraso é aceitável porque o registro só precisa
 * sobreviver ao PRÓXIMO reinício, e o `salvar` também é chamado ao fechar.
 */
function agendarGravacaoDoRegistro () {
  if (temporizadorDeGravacao) return
  temporizadorDeGravacao = setTimeout(() => {
    temporizadorDeGravacao = null
    registroDeImpressao.salvar()
  }, 1000)
  if (temporizadorDeGravacao.unref) temporizadorDeGravacao.unref()
}

/** Dispara o envio dos ACKs pendentes, agrupando a rajada do lote. */
function agendarAcksPendentes () {
  if (temporizadorDeAcks) return
  temporizadorDeAcks = setTimeout(() => {
    temporizadorDeAcks = null
    void enviarAcksPendentes()
  }, 3000)
  if (temporizadorDeAcks.unref) temporizadorDeAcks.unref()
}

/**
 * Manda por HTTP o que o MQTT não conseguiu confirmar.
 *
 * ⚠️ NUNCA lança: é chamada de temporizador e de callback de rede.
 * ⚠️ Idempotente do outro lado (confirmar duas vezes escreve o mesmo
 * resultado), então reenviar é seguro — é o que permite insistir.
 */
async function enviarAcksPendentes () {
  const pendentes = registroDeImpressao.pendentesDeConfirmacao()
  if (!pendentes.length) return
  const token = store.get('token')
  if (!token) return
  const agentUuid = garantirAgentUuid()

  // Teto por requisição: um agente que ficou horas fora não manda 5 mil de
  // uma vez (o corpo iria a megabytes e o proxy do cliente pode recusar).
  const lote = pendentes.slice(0, 200)
  try {
    await axios.post(
      `${HUB_API}/print-agents/${agentUuid}/acks`,
      { acks: lote },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 },
    )
    for (const ack of lote) registroDeImpressao.marcarConfirmado(ack.job_uuid)
    registroDeImpressao.salvar()
    registrar(`[ack] ${lote.length} confirmação(ões) enviada(s) por HTTP`)
    // Sobrou? Continua na próxima volta do temporizador.
  } catch (erro) {
    const detalhe = erro && erro.response ? `HTTP ${erro.response.status}` : (erro && erro.message) || erro
    /*
     * ⚠️ 404 significa "este agente não é desta conta" — insistir não
     * resolve, mas também não se apaga o registro: ele é a prova de que o
     * papel saiu. Fica para a próxima sessão.
     */
    registrar(`[ack] falha ao confirmar por HTTP (${detalhe}) — ${lote.length} pendente(s)`)
  }
}

/**
 * Pergunta ao Hub o que ficou sem confirmação e enfileira o que falta.
 *
 * ⚠️ `pullEmCurso` evita duas varreduras ao mesmo tempo (o `connect` e o
 * temporizador podem coincidir): duas listas iguais em voo enfileirariam o
 * mesmo job duas vezes antes de qualquer impressão — o registro só barra
 * depois que a etiqueta saiu.
 * ⚠️ NUNCA lança.
 */
async function puxarPendentes () {
  if (pullEmCurso) return
  const token = store.get('token')
  const userId = store.get('user_id')
  if (!token || !userId) return
  const agentUuid = garantirAgentUuid()

  pullEmCurso = true
  try {
    /*
     * ⚠️ `suspeitos`: os job_uuid que FOMOS imprimir e cujo desfecho nunca
     * soubemos (estado `'enviando'`). Só eles levam marca no papel — ver o
     * cabeçalho de `registroDeImpressao.emEnviando`. Sem isto o Hub carimba
     * `REIMPRESSAO` em etiqueta inédita, e quem lê descarta trabalho bom.
     *
     * ⚠️ Na URL de propósito: é GET, a lista tem 1 a 3 itens na prática, e
     * assim a rota antiga continua respondendo a clientes que não informam.
     */
    const suspeitos = registroDeImpressao.emEnviando()
    const resposta = await axios.get(
      `${HUB_API}/print-agents/${agentUuid}/jobs/pendentes`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
        ...(suspeitos.length ? { params: { suspeitos: suspeitos.join(',') } } : {}),
      },
    )
    const jobs = (resposta.data && resposta.data.data) || []
    if (!jobs.length) return
    /*
     * ⚠️ O pull NÃO decide — ele pergunta ao `enfileirar`, que é o ponto
     * único. Até a 1.0.22 os dois decidiam, com regras diferentes, e a do
     * `enfileirar` ganhava: a etiqueta em dúvida nunca era impressa, em
     * silêncio. Ver `src/decisao-do-job.js`.
     */
    const contagem = { imprimir: 0, reimprimir: 0, ja_impresso: 0, esgotado: 0 }
    for (const job of jobs) {
      const decisao = enfileirar(job, userId)
      if (decisao in contagem) contagem[decisao] += 1
    }
    registrar(
      `[pull] ${jobs.length} pendente(s) no Hub: ${contagem.imprimir} para imprimir` +
        (contagem.reimprimir ? `, ${contagem.reimprimir} em DÚVIDA (reimprimindo)` : '') +
        `, ${contagem.ja_impresso} já impresso(s) (reconfirmando)` +
        (contagem.esgotado ? `, ${contagem.esgotado} para CONFERÊNCIA (limite de tentativas)` : ''),
    )
  } catch (erro) {
    const detalhe = erro && erro.response ? `HTTP ${erro.response.status}` : (erro && erro.message) || erro
    registrar(`[pull] falha ao consultar pendentes (${detalhe})`)
  } finally {
    pullEmCurso = false
  }
}

/** Liga as duas rotinas. Idempotente: chamar de novo não duplica timer. */
let rotinasLigadas = false
function ligarRotinasDeContinuidade () {
  if (rotinasLigadas) return
  rotinasLigadas = true
  const doPull = setInterval(() => void puxarPendentes(), INTERVALO_DE_PULL_MS)
  const dosAcks = setInterval(() => void enviarAcksPendentes(), INTERVALO_DE_ACKS_MS)
  if (doPull.unref) doPull.unref()
  if (dosAcks.unref) dosAcks.unref()
}

/**
 * Enfileira um job — e é o PONTO ÚNICO que decide o que fazer com ele.
 *
 * 🚨 O job pode chegar DUAS vezes: pelo MQTT e pelo pull de pendentes (ou
 * duas vezes pelo pull, se o ACK não tiver sido aceito ainda). Imprimir de
 * novo é colar etiqueta errada no pacote — então, se este `job_uuid` já saiu
 * no papel, o cliente **reconfirma** em vez de imprimir.
 *
 * 🚨 MAS "tem entrada no registro" NÃO é "já saiu no papel" — e confundir os
 * dois fazia a etiqueta em DÚVIDA nunca ser impressa, em silêncio. A regra,
 * a medição e o porquê de centralizar estão em `src/decisao-do-job.js`; leia
 * antes de mexer aqui.
 *
 * Devolve o que decidiu, para quem chamou poder contar sem repetir a regra.
 */
function enfileirar (job, userId) {
  const uuid = job && job.job_uuid
  if (!uuid) {
    filaDeImpressao.enfileirar(job, userId)
    return 'imprimir'
  }

  return aplicarDecisaoDoJob({
    job,
    userId,
    decisao: decidirSobreJob({
      estado: registroDeImpressao.estadoDe(uuid),
      podeReimprimir: registroDeImpressao.podeReimprimir(uuid),
    }),
    registro: registroDeImpressao,
    imprimir: (j, u) => filaDeImpressao.enfileirar(j, u),
    registrar,
    agendarAcks: agendarAcksPendentes,
  })
}

// Escala de impressão por impressora (local). Modos:
//   label   = RECOMENDADO. Reescreve o PDF via pdf-lib para EXATAMENTE
//             100×150mm (288×432pt) e imprime noscale. Determinístico:
//             não depende do driver nem da heurística do SumatraPDF.
//   custom  = reescreve o PDF aplicando % definida pelo usuário (50-300).
//   auto    = lê o MediaBox do PDF e escolhe fit ou noscale (legado 1.0.3)
//   noscale = tamanho real do MediaBox (= 100% do PDF, NÃO 100% do driver)
//   shrink  = encolhe só se o conteúdo não couber
//   fit     = SumatraPDF ajusta à página configurada NO DRIVER (se o driver
//             estiver com papel errado, sai errado — por isso `label` é melhor)
//
// Config por impressora no electron-store (`pdf_scale_by_printer`):
//   string ('auto'|'noscale'|...)        — formato legado
//   { mode: 'label'|'custom'|..., pct }  — formato novo
const ESCALAS_PDF = ['label', 'custom', 'auto', 'noscale', 'shrink', 'fit']
/**
 * ⚠️ **A escala do SERVIDOR vence a configuração local** (08/10/2026).
 *
 * Etiqueta de marketplace é 100×150 mm por definição — não é preferência de
 * cada máquina. Enquanto a decisão era só local, o operador de SP estava com
 * `noscale` e a etiqueta saía pequena, sem nada errado no servidor: o PDF que
 * chegava já era 100×150 (medido payload contra payload, Adonis e porte
 * idênticos). O que faltava era o Hub DIZER como imprimir.
 *
 * ⚠️ A config local continua valendo quando o servidor não manda nada — é o
 * que mantém o client velho funcionando e permite a exceção pontual (papel
 * diferente numa máquina específica).
 */
function obterConfigEscala (printerName, escalaDoServidor) {
  if (typeof escalaDoServidor === 'string' && ESCALAS_PDF.includes(escalaDoServidor)) {
    return { mode: escalaDoServidor, pct: 100, origem: 'servidor' }
  }
  const map = store.get('pdf_scale_by_printer') || {}
  const v = map[printerName]
  if (typeof v === 'string' && ESCALAS_PDF.includes(v)) return { mode: v, pct: 100, origem: 'local' }
  if (v && typeof v === 'object' && ESCALAS_PDF.includes(v.mode)) {
    return { mode: v.mode, pct: Math.min(300, Math.max(50, parseInt(v.pct) || 100)), origem: 'local' }
  }
  return { mode: 'label', pct: 100, origem: 'default' } // default novo: determinístico
}

/**
 * A configuração do preparo, por impressora (local, como a da escala).
 *
 * ⚠️ **Ligado por padrão, e desligável sem release.** O backfeed é o sintoma
 * que a expedição relatou; desligá-lo é o conserto. Mas é a única coisa que o
 * Print Client escreve na CONFIGURAÇÃO de um equipamento, então precisa de
 * freio de mão sem depender de atualização.
 *
 * ⚠️ `velocidade` nasce NULA de propósito. `^PR` exige um `^XA…^XZ`, e um
 * formato sem campo imprimível **não deveria** produzir etiqueta — mas isso
 * depende do firmware, e uma etiqueta em branco por lote é desperdício
 * visível. Quem quiser testar liga numa máquina e confere o papel; o `~JSO`,
 * que é o que resolve, não tem essa dúvida e por isso vai sempre.
 */
function obterPreparo (printerName) {
  const map = store.get('zpl_prep_by_printer') || {}
  const v = map[printerName]
  if (v && typeof v === 'object') {
    return {
      ligado: v.ligado !== false,
      velocidade: Number.isFinite(Number(v.velocidade)) && Number(v.velocidade) > 0
        ? Math.min(14, Math.max(1, parseInt(v.velocidade, 10)))
        : null,
    }
  }
  if (v === false) return { ligado: false }
  return { ligado: true, velocidade: null }
}

/**
 * Lê o MediaBox da primeira página de um PDF sem dependência externa.
 * Funciona em ~95% dos PDFs (não funciona se o MediaBox vive em xref-stream
 * comprimido, raro em etiquetas geradas por marketplaces).
 *
 * @returns {{ widthPts:number, heightPts:number } | null}
 */
function lerMediaBoxPdf (filePath) {
  try {
    const fs = require('fs')
    const fd = fs.openSync(filePath, 'r')
    // 128KB cobre praticamente todos os PDFs simples
    const buf = Buffer.alloc(128 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const text = buf.slice(0, n).toString('latin1')
    const m = text.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/)
    if (!m) return null
    const [x1, y1, x2, y2] = m.slice(1, 5).map(parseFloat)
    return { widthPts: Math.abs(x2 - x1), heightPts: Math.abs(y2 - y1) }
  } catch (_) {
    return null
  }
}

/**
 * Decide a escala efetiva no modo 'auto'.
 *
 * Heurística: compara o MediaBox do PDF (em pontos, 1pt = 1/72 polegada) com o
 * tamanho-alvo de uma etiqueta 4×6" (288×432 pt). Se alguma dimensão do PDF é
 * <85% do alvo, considera PDF "menor que a etiqueta" e aplica `fit` (escala
 * proporcional para preencher). Caso contrário, `noscale` mantém fidelidade.
 *
 * Sem leitura do MediaBox → `fit` por segurança (etiqueta cheia > etiqueta no
 * canto do papel).
 */
function decidirEscalaAuto (filePath) {
  const mb = lerMediaBoxPdf(filePath)
  if (!mb) return 'fit'
  const ALVO_W = 288 // 4 pol em pontos
  const ALVO_H = 432 // 6 pol em pontos
  const menor   = Math.min(mb.widthPts, mb.heightPts)
  const maior   = Math.max(mb.widthPts, mb.heightPts)
  // Considera PDF "no tamanho da etiqueta" se as duas dimensões batem ≥85%
  // do alvo, independente de portrait/landscape.
  const cabeNoTamanho = (menor >= ALVO_W * 0.85) && (maior >= ALVO_H * 0.85)
  return cabeNoTamanho ? 'noscale' : 'fit'
}

// O tamanho-alvo, a reescrita do PDF e a junção de etiquetas moram em
// `src/pdf-etiqueta.js` — puros, com teste (`src/pdf-etiqueta.test.js`).
const { transformarPdf, normalizarEJuntar, juntarPdfs } = require('./src/pdf-etiqueta')

async function imprimirPdf (buffers, printerName, escalaDoServidor) {
  const fs   = require('fs')
  const tmp  = require('os').tmpdir()
  const lista = Array.isArray(buffers) ? buffers : [buffers]

  const cfg = obterConfigEscala(printerName, escalaDoServidor)
  let bufferFinal = lista[0]
  let escalaSumatra = 'noscale'

  if (cfg.mode === 'label' || cfg.mode === 'custom') {
    // Pré-processa o PDF — escala determinística independente do driver.
    try {
      bufferFinal = await normalizarEJuntar(lista, cfg.mode, cfg.pct)
      escalaSumatra = 'noscale'
      registrar(`[pdf] ${printerName} mode=${cfg.mode} (${cfg.origem})${cfg.mode === 'custom' ? ` pct=${cfg.pct}` : ''} → ${lista.length} PDF(s) reescrito(s) + noscale`)
    } catch (e) {
      // ⚠️ RELANÇA quando é lote: `imprimirLote` refaz uma a uma e cada uma
      // cai no seu próprio fallback. Engolir aqui imprimiria o lote inteiro
      // com a escala errada.
      if (lista.length > 1) throw e
      registrar(`[pdf] transformarPdf falhou (${e.message}) — fallback fit`)
      bufferFinal = lista[0]
      escalaSumatra = 'fit'
    }
  } else if (cfg.mode === 'auto') {
    // Heurística legada — mantida por compat. Decide pelo PRIMEIRO PDF: no
    // lote todos vêm da mesma origem e do mesmo formato.
    const probe = path.join(tmp, `mhub_probe_${Date.now()}.pdf`)
    fs.writeFileSync(probe, lista[0])
    escalaSumatra = decidirEscalaAuto(probe)
    try { fs.unlinkSync(probe) } catch (_) {}
    if (lista.length > 1) bufferFinal = await juntarPdfs(lista)
  } else {
    escalaSumatra = cfg.mode // noscale | shrink | fit diretos
    if (lista.length > 1) bufferFinal = await juntarPdfs(lista)
  }

  const file = path.join(tmp, `mhub_${Date.now()}.pdf`)
  fs.writeFileSync(file, bufferFinal)

  const comecou = Date.now()
  try {
    if (canalDePdf(process.platform) === 'sumatra' && pdfPrint) {
      await pdfPrint.print(file, { printer: printerName, silent: true, scale: escalaSumatra })
    } else {
      // macOS/Linux: CUPS. O nome da fila vai como argumento, nunca dentro
      // de uma string de shell — aspas no nome quebrariam o comando.
      entregarAoCups(
        argumentosDePdf({ impressora: printerName, arquivo: file, escala: escalaSumatra }),
        printerName,
      )
    }
    /*
     * ⚠️ Este número é o que separa "o software está lento" de "a
     * impressora está lenta". Ele mede até o SPOOLER aceitar — o papel sai
     * depois, no ritmo do equipamento. Sem ele, as duas coisas viram a
     * mesma queixa.
     */
    registrar(`[pdf] ${printerName}: ${lista.length} documento(s) entregues ao spooler em ${Date.now() - comecou} ms (escala ${escalaSumatra})`)
  } finally {
    try { require('fs').unlinkSync(file) } catch (_) {}
  }
}

function entregarAoCups (args, impressora = null) {
  const { execFileSync } = require('child_process')
  try {
    execFileSync('lp', args, { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const detalhe = (e.stderr && e.stderr.toString().trim()) || e.message
    throw new Error(`CUPS recusou o trabalho (${args.join(' ')}): ${detalhe.slice(0, 300)}`)
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   * 🚨 "ACEITO" NÃO É "VAI SAIR": A FILA PODE ESTAR PAUSADA (31/10/2026)
   * ══════════════════════════════════════════════════════════════════════
   * O `lp` enfileira e volta na hora, e o ACK era dado sobre isso. Caso real
   * medido no Hub: 5 ondas de 21 etiquetas, todas `success` com ACK em
   * 0-1 s, e nenhuma saiu — a fila do CUPS estava pausada. O macOS pausa a
   * fila inteira quando um trabalho falha no backend, e tudo que chega
   * depois espera, inclusive etiqueta boa. O Hub mostrava verde enquanto a
   * operadora olhava a impressora parada; só um clique em "retomar" liberou.
   *
   * Conferir o estado DEPOIS de entregar transforma isso em erro visível: a
   * etiqueta aparece na tela como não confirmada e alguém age, em vez de
   * alguém descobrir contando papel.
   *
   * ⚠️ **Falha ABERTA.** Se o `lpstat` não rodar, demorar ou devolver frase
   * que não reconhecemos, não se acusa nada — o comportamento volta a ser o
   * de hoje. "Não sei" nunca pode virar pendência para o operador.
   */
  if (!impressora) return
  let pausada = false
  try {
    const saida = execFileSync('lpstat', argumentosDeEstadoDaFila(impressora), {
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    pausada = filaEstaPausada(saida.toString())
  } catch (_) {
    // Falha do próprio `lpstat` não acusa nada (falha ABERTA).
    return
  }
  if (pausada) {
    registrar(`[cups] ${impressora}: a FILA ESTÁ PAUSADA — o trabalho entrou mas não vai sair`)
    throw new Error(
      `A fila de impressão "${impressora}" está pausada no sistema: o trabalho foi aceito ` +
        'mas não será impresso. Retome a impressora e mande de novo.',
    )
  }
}

/**
 * Gera uma etiqueta de TESTE com moldura nas bordas exatas, diagonais e
 * texto explicativo. Gerada propositalmente em ~80×130mm (tamanho típico de
 * PDF Shopee) pra validar o pipeline de escala no caso real.
 *
 * Como validar no papel: a moldura tracejada deve encostar nas bordas da
 * etiqueta física. Se sobrar margem grande ou cortar, ajustar o modo/% e
 * imprimir teste de novo.
 */
async function gerarPdfTeste () {
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib')
  const doc = await PDFDocument.create()
  // 80×130mm = 226.8×368.5pt — simula PDF Shopee menor que a etiqueta
  const W = 226.8, H = 368.5
  const page = doc.addPage([W, H])
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontN = await doc.embedFont(StandardFonts.Helvetica)

  // Moldura na borda exata
  page.drawRectangle({ x: 1, y: 1, width: W - 2, height: H - 2, borderColor: rgb(0, 0, 0), borderWidth: 2 })
  // Diagonais
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: W, y: H }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
  page.drawLine({ start: { x: 0, y: H }, end: { x: W, y: 0 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })

  const cx = W / 2
  page.drawText('TESTE DE ESCALA', { x: cx - 62, y: H / 2 + 40, size: 14, font })
  page.drawText('MaximusHub Print Client', { x: cx - 60, y: H / 2 + 22, size: 10, font: fontN })
  page.drawText('A moldura deve encostar', { x: cx - 56, y: H / 2 - 4, size: 9, font: fontN })
  page.drawText('nas bordas da etiqueta.', { x: cx - 52, y: H / 2 - 16, size: 9, font: fontN })
  page.drawText('Se nao encostar: ajuste o', { x: cx - 56, y: H / 2 - 34, size: 9, font: fontN })
  page.drawText('modo de escala e teste de novo.', { x: cx - 68, y: H / 2 - 46, size: 9, font: fontN })

  return Buffer.from(await doc.save())
}

async function imprimirZpl (buffer, zplHost, zplPort, printerName, etiquetas = 1) {
  if (zplHost) {
    // Impressora de rede: TCP direto na porta 9100
    /*
     * ⚠️ O TETO AQUI TAMBÉM É PROPORCIONAL AO LOTE (30/10/2026).
     *
     * Este caminho tinha `10000` fixo — a MESMA incoerência que acabou de ser
     * corrigida no envio por winspool, e pela mesma razão: `socket.write` só
     * completa quando o buffer do SO drena, e numa térmica lenta isso espera
     * a impressão. Um lote de 25 etiquetas gráficas é 1,2 MB; de 100, quase 5
     * MB. Teto fixo transforma lote grande em erro, e erro aqui é a etiqueta
     * voltando para a fila sem necessidade.
     *
     * ⚠️ Nenhuma das 184 impressoras cadastradas usa `zpl_host` hoje (medido),
     * então este caminho nunca foi exercitado em volume — motivo de sobra
     * para ele não carregar um limite que já se mostrou errado do outro lado.
     *
     * ⚠️ O temporizador é CANCELADO no fim: antes ele continuava pendurado
     * mesmo após o sucesso, e num lote isso deixava um timer vivo por
     * impressão, cada um com um `socket.destroy()` agendado.
     */
    const comecouSocket = Date.now()
    await new Promise((resolve, reject) => {
      const net = require('net')
      let relogio = null
      const encerrar = (fn, arg) => {
        if (relogio) { clearTimeout(relogio); relogio = null }
        fn(arg)
      }
      const socket = net.createConnection({ host: zplHost, port: zplPort }, () => {
        socket.write(buffer)
        socket.end()
      })
      socket.on('close', () => {
        /*
         * ⚠️ O socket NÃO registrava nada (30/10/2026): o winspool ganhou a
         * linha de tempo e este ramo ficou mudo, então 174 envios seguidos
         * não deixaram UMA linha no log. "Está lento" por aqui era
         * inauditável.
         */
        registrar(
          `[zpl] ${printerName} via ${zplHost}:${zplPort}: ${etiquetas} etiqueta(s), ` +
            `${(buffer.length / 1024).toFixed(0)} KB em ${Date.now() - comecouSocket} ms`,
        )
        encerrar(resolve)
      })
      socket.on('error', (erro) => {
        registrar(
          `[zpl] ${printerName} via ${zplHost}:${zplPort}: FALHA após ` +
            `${Date.now() - comecouSocket} ms — ${erro && erro.message}`,
        )
        encerrar(reject, erro)
      })
      relogio = setTimeout(() => {
        socket.destroy()
        encerrar(reject, new Error(`Timeout TCP ZPL (${etiquetas} etiqueta(s), teto ${tetoDoEnvioRaw(etiquetas)} ms)`))
      }, tetoDoEnvioRaw(etiquetas))
    })
  } else if (canalDeZpl(process.platform, null) === 'winspool') {
    // Driver Windows: envio RAW pelo spooler (winspool).
    //
    // ══════════════════════════════════════════════════════════════════════
    // ⚠️ ESTE CAMINHO ESTAVA QUEBRADO, E EM SILÊNCIO (09/10/2026)
    // ══════════════════════════════════════════════════════════════════════
    // A versão anterior declarava `StartDocPrinter(IntPtr, int, int[])` e
    // passava `New-Object int[] 3` como DOC_INFO_1. A estrutura são TRÊS
    // PONTEIROS — 24 bytes em x64 — e o array tem 12: o spooler lia 12 bytes
    // de lixo além do buffer. Pior, `$di[0]=1` punha o valor 1 em `pDocName`,
    // que é um ponteiro: endereço inválido.
    //
    // E **nada conferia retorno** (`|Out-Null` em tudo). Quando
    // `StartDocPrinter` falhava, o `WritePrinter` seguia e não escrevia nada
    // — o comando simplesmente não chegava à impressora, sem erro nenhum.
    //
    // Foi o que aconteceu com o preparo das versões 1.0.5 e 1.0.6: o `~JSO`
    // e o `JB` eram montados certos e provavelmente nunca saíram daqui. Como
    // ninguém imprimia ZPL por driver em produção (100% dos jobs são PDF via
    // SumatraPDF), o defeito nunca tinha aparecido.
    //
    // ⚠️ **E a 1.0.7/1.0.8 AINDA não funcionavam, por um terceiro motivo**
    // (provado pelo log da expedição em 09/10/2026):
    //
    //     $ErrorActionPreference='Stop' Add-Type -TypeDefinition @" ...
    //                                   ~~~~~~~~
    //     Token 'Add-Type' inesperado na expressao ou instrucao.
    //     No linha:1 caractere:32
    //
    // "linha 1" entrega o diagnóstico: um `.replace(/\n\s+/g, ' ')` colapsava
    // o script INTEIRO numa linha só para caber em `-Command`. Isso quebra
    // duas coisas de uma vez — os comandos ficam sem `;` entre eles, e o
    // **here-string** `@"…"@` do PowerShell EXIGE quebra de linha depois do
    // `@"` e o `"@` no começo da linha. Nenhuma quantidade de escape de aspas
    // conserta isso.
    //
    // ⚠️ Por isso o script vai num **arquivo `.ps1`** e os dados vão como
    // ARGUMENTO (`param(...)`), nunca interpolados no código: nome de
    // impressora com aspas deixa de ser um problema de escape.
    //
    // ⚠️ **`pDatatype = "RAW"` é obrigatório.** Sem ele o spooler usa o
    // padrão do driver, que para o ZDesigner pode ser o formato gráfico — e
    // aí os bytes do comando seriam IMPRESSOS como texto numa etiqueta, em
    // vez de interpretados.
    /*
     * ══════════════════════════════════════════════════════════════════════
     * 🚨 ASSÍNCRONO, E ISSO NÃO É DETALHE DE ESTILO (30/10/2026)
     * ══════════════════════════════════════════════════════════════════════
     * Até a 1.0.17 aqui havia `execSync`, que **para o event loop do Node**
     * até o PowerShell terminar. Enquanto o lote saía na Zebra, este
     * processo não respondia ao keepalive de 30 s do MQTT: o broker
     * derrubava a conexão e, com `clean: true`, TUDO o que o Hub publicava
     * no intervalo evaporava — etiqueta que fica `sent` para sempre e só é
     * descoberta contando o papel.
     *
     * Medido na RDF, no mesmo dia, em DUAS máquinas e DUAS versões:
     * 87 etiquetas e queda no segundo do 81º job (agente 35, 1.0.14);
     * 79 e queda com 173 publicadas no vácuo (agente 39, 1.0.17). O mesmo
     * cliente ficou 5 h 13 min no ar imprimindo 645 etiquetas em PDF — e o
     * PDF sempre usou `await`. As três quedas do dia foram em lote ZPL.
     *
     * ⚠️ `execFile` com LISTA de argumentos, não string: sem shell, nome de
     * impressora com aspas ou `&` deixa de ser problema de escape.
     * ⚠️ O timeout continua: PowerShell pendurado tem de virar erro, e a
     * fila refaz a etiqueta uma a uma. O que mudou é que esperar não
     * bloqueia mais a conexão.
     */
    const { execFile } = require('child_process')
    const fs   = require('fs')
    const base = path.join(os.tmpdir(), `mhub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    const file = `${base}.bin`
    const script = `${base}.ps1`
    fs.writeFileSync(file, buffer)
    const ps = scriptPowerShell()
    fs.writeFileSync(script, ps, 'ascii')
    try {
      // ⚠️ `stdio: pipe` para a mensagem de erro do PowerShell chegar aqui: a
      // versão anterior engolia qualquer falha junto com o `Out-Null`.
      const comecou = Date.now()
      await new Promise((resolve, reject) => {
        execFile(
          'powershell',
          argumentosPowerShell(script, printerName, file),
          /*
           * ⚠️ Teto de 60 s, não 15: o lote de 25 etiquetas gráficas é o
           * caso NORMAL e a Zebra de entrada leva mais de 15 s para
           * engoli-lo. Com `execSync` esse teto não podia crescer — cada
           * segundo a mais era um segundo de conexão derrubada; agora
           * esperar é de graça, e matar o PowerShell no meio de um lote que
           * ia dar certo custa 25 reimpressões.
           */
          { timeout: tetoDoEnvioRaw(etiquetas), windowsHide: true, maxBuffer: 1024 * 1024 },
          (erro, _saida, erroPadrao) => {
            if (!erro) return resolve()
            if (erroPadrao) erro.stderr = erroPadrao
            reject(erro)
          },
        )
      })
      /*
       * ⚠️ ESTE NÚMERO É O QUE FALTAVA EM 30/10/2026. O PDF já registrava o
       * tempo de entrega ao spooler; o ZPL não registrava nada, e por isso
       * os 205 s por lote da RDF tiveram de ser reconstruídos pelo intervalo
       * entre o `sent` e o ACK no banco do servidor — que mede outra coisa
       * (inclui fila e desconexão). Com a linha abaixo, "está lento" passa a
       * ter resposta no log da própria máquina: quanto o winspool levou,
       * quantas etiquetas e qual era o teto.
       */
      registrar(
        `[zpl] ${printerName}: ${etiquetas} etiqueta(s), ${(buffer.length / 1024).toFixed(0)} KB ` +
          `aceitos pelo winspool em ${Date.now() - comecou} ms (teto ${tetoDoEnvioRaw(etiquetas)} ms) ` +
            `— ACEITO não é IMPRESSO: o spooler ainda pode recusar o job depois`,
      )
    } catch (e) {
      const detalhe = (e.stderr && e.stderr.toString().trim()) || e.message
      /*
       * ⚠️ O tempo entra na mensagem de erro de propósito: é ele que separa
       * "o PowerShell falhou" de "o teto estourou" — e foi a confusão entre
       * os dois que escondeu o fallback um-a-um por semanas.
       */
      registrar(
        `[zpl] ${printerName}: FALHOU após ${Date.now() - comecou} ms ` +
          `(${etiquetas} etiqueta(s), teto ${tetoDoEnvioRaw(etiquetas)} ms) — ${detalhe.slice(0, 200)}`,
      )
      throw new Error(`Envio RAW para "${printerName}" falhou: ${detalhe.slice(0, 300)}`)
    } finally {
      try { fs.unlinkSync(file) } catch (_) {}
      try { fs.unlinkSync(script) } catch (_) {}
    }
  } else {
    // Fila local no macOS: o mesmo RAW, pelo CUPS. Sem `-o raw` o driver
    // desenha o ZPL como texto.
    const fs = require('fs')
    const file = path.join(os.tmpdir(), `mhub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.zpl`)
    fs.writeFileSync(file, buffer)
    try {
      entregarAoCups(argumentosDeZplRaw({ impressora: printerName, arquivo: file }), printerName)
    } finally {
      try { fs.unlinkSync(file) } catch (_) {}
    }
  }
}

// ─── Registro do agente ───────────────────────────────────────────────────────

async function registrarAgente (token) {
  const agentUuid = garantirAgentUuid()
  try {
    await axios.post(
      `${HUB_API}/print-agents/register`,
      {
        agent_uuid: agentUuid,
        name:       `${os.hostname()} (${os.platform()})`,
        hostname:   os.hostname(),
        platform:   os.platform(),
        version:    APP_VERSION,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    )
  } catch (err) {
    console.error('[REGISTER] Erro ao registrar agente:', err.response?.data?.message || err.message)
  }
}

// ─── Descoberta de impressoras ────────────────────────────────────────────────

/**
 * Lista as impressoras do SO — ou `null` quando NÃO FOI POSSÍVEL perguntar.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 `[]` SIGNIFICA "ESTE PC NÃO TEM IMPRESSORA", NÃO "DEU ERRO"
 * ══════════════════════════════════════════════════════════════════════════
 * A versão anterior devolvia `[]` em qualquer falha — timeout de 10 s do
 * `powershell Get-Printer`, spooler ainda subindo logo depois do boot, saída
 * que não faz `JSON.parse`. O servidor lê lista vazia como ordem de apagar
 * todas as impressoras do agente, então um erro transitório AQUI virava
 * perda permanente de configuração LÁ (incidente de 30/10/2026).
 *
 * Quem chama decide: o sync não envia nada quando isto devolve `null`; a
 * tela mostra a lista que conseguir.
 */
/**
 * Quanto esperar pelo `Get-Printer`.
 *
 * ⚠️ 10 s era pouco: UMA fila problemática (rede fora do ar, driver de classe
 * IPP apontando para destino que não responde) segura a enumeração inteira, e
 * aí a descoberta falha e **todas** as impressoras do PC deixam de ser
 * publicadas. O custo de esperar mais é adiar o sync; o de esperar menos é a
 * Zebra sumir do Hub por causa de uma impressora que ninguém usa.
 */
const TETO_DA_DESCOBERTA_MS = 45000

async function descobrirImpressoras () {
  const comecouDescoberta = Date.now()
  try {
    if (process.platform === 'win32') {
      /*
       * ⚠️ Assíncrono: a descoberta roda em laço (a cada sync) e o
       * `Get-Printer` pendura quando há fila de rede fora do ar. Com
       * `execSync` esse tempo saía do event loop — o mesmo mecanismo que
       * derrubava a conexão MQTT durante a impressão (ver `imprimirZpl`).
       */
      const { execFile } = require('child_process')
      const raw = await new Promise((resolve, reject) => {
        execFile(
          'powershell',
          ['-NoProfile', '-Command', 'Get-Printer | Select-Object Name | ConvertTo-Json'],
          { timeout: TETO_DA_DESCOBERTA_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
          (erro, stdout) => (erro ? reject(erro) : resolve(String(stdout))),
        )
      })
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      // ⚠️ O número entra no log: "não puxou impressora" e "o PC não tem
      // impressora" são coisas diferentes, e sem este registro elas chegam
      // iguais em quem vai investigar.
      registrar(`[impressoras] ${list.length} encontrada(s) em ${Date.now() - comecouDescoberta} ms`)
      return list.map(p => ({
        system_name:  p.Name,
        display_name: p.Name,
        type:         detectarTipoImpressora(p.Name),
      }))
    } else {
      const { execFileSync } = require('child_process')
      let raw = ''
      try {
        raw = execFileSync('lpstat', ['-a'], { timeout: 5000, encoding: 'utf8' })
      } catch (e) {
        // Sem nenhuma fila o lpstat sai com código 1 e a frase no stderr.
        // stdout vazio é lista vazia — não é falha da descoberta.
        raw = e.stdout ? String(e.stdout) : ''
      }
      return interpretarLpstat(raw).map(name => ({
        system_name:  name,
        display_name: name,
        type:         detectarTipoImpressora(name),
      }))
    }
  } catch (err) {
    /*
     * ⚠️ `null`, nunca `[]` — ver o cabeçalho desta função.
     *
     * 🚨 E o motivo vai para o LOG, não só para o `console.error`
     * (30/10/2026). O console de um app de bandeja não é lido por ninguém: na
     * primeira vez que esta descoberta falhou em produção, "não puxou nenhuma
     * impressora" não tinha NENHUM rastro na máquina, e a causa só apareceu
     * cruzando duas colunas do banco do servidor. Todo `catch` de borda que
     * devolve genérico tem de dizer o motivo onde alguém vai procurar.
     */
    const detalhe = err && err.killed ? `timeout de ${err.timeout || 'N'} ms` : (err && err.message) || String(err)
    registrar(`[impressoras] FALHA ao descobrir: ${detalhe} — a lista NÃO será publicada (protege as já cadastradas)`)
    console.error('[PRINTERS] Erro ao descobrir impressoras:', err && err.message)
    return null
  }
}

function detectarTipoImpressora (name) {
  const n = (name || '').toLowerCase()
  if (n.includes('zpl') || n.includes('zebra') || n.includes('datamax') || n.includes('tsc ')) return 'zpl'
  if (n.includes('pdf') || n.includes('virtual') || n.includes('microsoft print')) return 'pdf'
  return 'auto'
}

/** Instante do último sync que REALMENTE foi ao servidor. */
let ultimoSyncEm = 0
// A regra mora em `src/decisao-de-sync.js`, com teste — não duplicar aqui.
const { listaPodeSerPublicada, podeSincronizarAgora } = require('./src/decisao-de-sync')

/**
 * Manda ao Hub a lista de impressoras deste PC.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ DUAS RECUSAS, E AS DUAS EXISTEM POR CAUSA DO INCIDENTE DE 30/10/2026
 * ══════════════════════════════════════════════════════════════════════════
 *  1. **Descoberta que falhou não vira POST.** `descobrirImpressoras`
 *     devolve `null` quando não conseguiu perguntar ao SO; mandar isso como
 *     `[]` fazia o servidor apagar todas as impressoras do agente.
 *  2. **Reconexão de rede não sincroniza.** O sync roda no `connect` do
 *     MQTT, que acontece a cada 5 s enquanto houver instabilidade (ou briga
 *     de clientId). A lista de impressoras de um PC não muda nesse ritmo —
 *     `forcar: true` é para o clique do "Salvar", onde a pessoa espera que
 *     o que ela acabou de instalar apareça.
 */
async function sincronizarImpressoras (token, agentUuid, { forcar = false } = {}) {
  const agora = Date.now()
  if (!podeSincronizarAgora({ agora, ultimoSyncEm, forcar })) return null

  try {
    const printers = await descobrirImpressoras()
    if (!listaPodeSerPublicada(printers)) {
      /*
       * 🚨 Este caminho era INVISÍVEL (30/10/2026). "Instalei, loguei e não
       * puxou nenhuma impressora" não deixava rastro algum na máquina:
       * `console.error` num app de bandeja não é lido por ninguém, e a
       * investigação teve de ser feita cruzando colunas do banco do SERVIDOR.
       * Toda saída silenciosa daqui passa a dizer o que aconteceu.
       */
      registrar('[sync] descoberta falhou — POST NÃO enviado (lista vazia apagaria as impressoras do Hub)')
      return null
    }
    const res = await axios.post(
      `${HUB_API}/print-agents/${agentUuid}/printers`,
      { printers },
      { headers: { Authorization: `Bearer ${token}` } }
    )
    ultimoSyncEm = agora
    registrar(`[sync] ${printers.length} impressora(s) publicada(s) no Hub`)
    return res.data
  } catch (err) {
    // ⚠️ O status HTTP entra no log: 401 (token), 404 (agente de outra conta)
    // e erro de rede pedem ações diferentes, e sem ele os três chegam como
    // "não puxou impressora".
    const status = err.response ? `HTTP ${err.response.status}` : 'sem resposta'
    registrar(`[sync] FALHA ao publicar (${status}): ${err.response?.data?.message || err.message}`)
    return null
  }
}

// ─── IPC — comunicação com páginas HTML ──────────────────────────────────────

/**
 * Conclui o login: guarda a sessão, registra o agente e conecta.
 *
 * ⚠️ Ponto ÚNICO de "entrei": o login direto e o login com segundo fator
 * terminam aqui. Duas cópias disso significariam um caminho que esquece de
 * registrar o agente ou de ligar as rotinas de continuidade — e o sintoma
 * seria o cliente conectado que nunca imprime.
 */
async function concluirLogin (sessao) {
  store.set('token',   sessao.token)
  store.set('user_id', sessao.usuario.id)
  store.set('user_name', sessao.usuario.name || sessao.usuario.email)
  /*
   * ⚠️ O aparelho CONFIÁVEL é o que faz o 2FA ser pedido uma vez e não toda
   * semana. O Hub devolve este token quando o cliente pede para confiar, e
   * ele volta no cabeçalho `x-trusted-device` do próximo login — que então
   * pula o código. Guardar é o ponto inteiro do recurso.
   */
  if (sessao.dispositivoConfiavel) store.set('trusted_device', sessao.dispositivoConfiavel)

  await registrarAgente(sessao.token)
  conectarMqtt(sessao.token)

  if (loginWin) { loginWin.close(); loginWin = null }
  abrirSetup()

  verificarAtualizacao()
  setInterval(verificarAtualizacao, 5 * 60 * 1000)
}

/** O desafio de 2FA em curso — vive só entre a senha e o código. */
let desafioEmCurso = null

ipcMain.handle('login', async (_, { email, password }) => {
  try {
    /*
     * ══════════════════════════════════════════════════════════════════════
     * 🚨 O HUB TEM TRÊS RESPOSTAS PARA O LOGIN (30/10/2026)
     * ══════════════════════════════════════════════════════════════════════
     * Este handler lia `res.data.data.token.token` direto, e a tela mostrava
     * "Cannot read properties of undefined (reading 'token')" para qualquer
     * conta de pessoa — porque desde o 2FA o login também responde
     * `mfa_required` e `mfa_setup_required`, que não têm `token`. O Hub
     * ACEITAVA a credencial; quem recusava era o nosso código, por não saber
     * ler a resposta. A regra de leitura está em `src/resposta-de-login.js`,
     * com teste.
     */
    const confiavel = store.get('trusted_device')
    const res = await axios.post(
      `${HUB_API}/auth/login`,
      { email, password },
      // O cabeçalho é o que faz o aparelho já conhecido pular o código.
      confiavel ? { headers: { 'x-trusted-device': confiavel } } : undefined,
    )
    const r = interpretarLogin(res.data && res.data.data)

    if (r.tipo === 'sessao') {
      await concluirLogin(r)
      return { success: true }
    }

    if (r.tipo === 'codigo') {
      desafioEmCurso = { desafio: r.desafio, email }
      registrar(`[login] 2FA pedido para ${email} (${r.metodos.length} método(s))`)
      return {
        success: false,
        precisaCodigo: true,
        expiraEmMin: r.expiraEmMin,
        backupDisponiveis: r.backupDisponiveis,
        // Só os que dependem de envio viram botão na tela.
        metodosParaEnviar: metodosQuePrecisamEnvio(r.metodos).map((m) => ({
          id: m.id,
          rotulo: m.label || m.rotulo || m.destino || m.type || m.tipo,
        })),
      }
    }

    if (r.tipo === 'configurar') {
      /*
       * ⚠️ O Print Client NÃO configura 2FA, de propósito: é app de balcão,
       * a máquina costuma ser compartilhada, e o segredo de autenticação de
       * uma pessoa não tem onde ficar guardado com segurança aqui. O que ele
       * faz é dizer para onde ir.
       */
      registrar(`[login] conta ${email} precisa configurar 2FA no Hub`)
      return { success: false, message: mensagemDeConfiguracao(r) }
    }

    registrar('[login] resposta do Hub em formato desconhecido')
    return { success: false, message: 'Não foi possível entrar: resposta inesperada do servidor.' }
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    return { success: false, message: msg }
  }
})

/**
 * Conclui o login com o código do segundo fator.
 *
 * ⚠️ `confiar_dispositivo: true` SEMPRE. Esta é uma máquina de balcão que
 * imprime o dia inteiro: pedir o código a cada login transformaria a
 * verificação em obstáculo diário e levaria alguém a deixar a senha colada no
 * monitor. O Hub devolve um token de aparelho confiável, que guardamos e
 * reapresentamos no próximo login.
 *
 * ⚠️ O MESMO campo aceita o número do app, o código enviado por e-mail ou
 * WhatsApp e o código de recuperação — é o servidor que descobre o que é.
 * Separar em três campos obrigaria quem está no balcão a saber qual tem.
 */
ipcMain.handle('login-codigo', async (_, { codigo }) => {
  if (!desafioEmCurso) {
    return { success: false, message: 'A verificação expirou. Entre com e-mail e senha de novo.' }
  }
  try {
    const res = await axios.post(`${HUB_API}/auth/mfa/verify`, {
      challenge: desafioEmCurso.desafio,
      codigo: String(codigo || '').trim(),
      confiar_dispositivo: true,
    })
    const r = interpretarLogin(res.data && res.data.data)
    if (r.tipo !== 'sessao') {
      return { success: false, message: 'Não foi possível concluir a verificação.' }
    }
    desafioEmCurso = null
    await concluirLogin(r)
    registrar(`[login] 2FA concluído${r.dispositivoConfiavel ? ' — aparelho lembrado' : ''}`)
    return { success: true }
  } catch (err) {
    /*
     * ⚠️ Nenhuma rota do fluxo responde 401 (decisão do backend): código
     * errado é 400, excesso é 429 e desafio morto é 400 com `expirado`. Por
     * isso dá para mostrar a mensagem do servidor direto — ela é feita para
     * quem está tentando entrar.
     */
    const dados = err.response?.data
    const expirou = dados?.expirado === true
    if (expirou) desafioEmCurso = null
    return {
      success: false,
      expirou,
      message: dados?.message || err.message,
      tentativasRestantes: dados?.tentativas_restantes,
    }
  }
})

/** Reenvia o código por e-mail/WhatsApp (o do app não precisa). */
ipcMain.handle('login-reenviar-codigo', async (_, { methodId } = {}) => {
  if (!desafioEmCurso) {
    return { success: false, message: 'A verificação expirou. Entre com e-mail e senha de novo.' }
  }
  try {
    const res = await axios.post(`${HUB_API}/auth/mfa/challenge/send`, {
      challenge: desafioEmCurso.desafio,
      ...(methodId ? { method_id: methodId } : {}),
    })
    return { success: true, message: res.data?.message || 'Código enviado.' }
  } catch (err) {
    return { success: false, message: err.response?.data?.message || err.message }
  }
})


ipcMain.handle('get-printers', async () => {
  // A tela só EXIBE: aqui `null` vira lista vazia e aparece o "Nenhuma
  // impressora encontrada". Nada é apagado por este caminho.
  return (await descobrirImpressoras()) || []
})

ipcMain.handle('get-hub-printers', async () => {
  const token    = store.get('token')
  const agentUuid = garantirAgentUuid()
  try {
    const res = await axios.get(
      `${HUB_API}/print-agents/${agentUuid}/printers`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return res.data.data || []
  } catch (_) { return [] }
})

ipcMain.handle('update-printer', async (_, { agentUuid, printerId, data }) => {
  const token = store.get('token')
  try {
    const res = await axios.put(
      `${HUB_API}/print-agents/${agentUuid}/printers/${printerId}`,
      data,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return res.data
  } catch (err) {
    return { success: false, message: err.response?.data?.message || err.message }
  }
})

ipcMain.handle('sync-printers', async () => {
  const token     = store.get('token')
  const agentUuid = garantirAgentUuid()
  if (!token) return { success: false, data: [], message: 'Não autenticado' }
  try {
    await registrarAgente(token)
    // `forcar`: é clique de gente no "Salvar", não reconexão de rede.
    const resposta = await sincronizarImpressoras(token, agentUuid, { forcar: true })
    if (!resposta) {
      return {
        success: false,
        data: [],
        message: 'Não foi possível ler as impressoras deste computador agora. '
               + 'Tente de novo em instantes — nada foi alterado no Hub.',
      }
    }
    return { success: true, data: resposta.data || [] }
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    return { success: false, data: [], message: msg }
  }
})

ipcMain.handle('get-store', (_, key) => store.get(key))

// Escala de impressão PDF por impressora (armazenada localmente neste PC)
ipcMain.handle('get-pdf-scale-map', () => store.get('pdf_scale_by_printer') || {})

// Aceita formato legado ({printer, scale}) e novo ({printer, scale, pct}).
ipcMain.handle('set-pdf-scale', (_, { printer, scale, pct }) => {
  const map = store.get('pdf_scale_by_printer') || {}
  if (ESCALAS_PDF.includes(scale)) {
    map[printer] = scale === 'custom'
      ? { mode: 'custom', pct: Math.min(300, Math.max(50, parseInt(pct) || 100)) }
      : { mode: scale, pct: 100 }
  }
  store.set('pdf_scale_by_printer', map)
  return map
})

// Imprime etiqueta de TESTE com a config de escala atual da impressora.
// Usuário valida no papel físico e ajusta o modo/% até a moldura encostar
// nas bordas — aí TODAS as impressões reais saem certas.
ipcMain.handle('print-test-label', async (_, { printer }) => {
  try {
    const buffer = await gerarPdfTeste()
    await imprimirPdf(buffer, printer)
    return { success: true }
  } catch (e) {
    return { success: false, message: e.message }
  }
})

ipcMain.handle('logout', () => {
  store.clear()
  // ⚠️ O registro é a prova de que o papel saiu: gravar ANTES de fechar, e
  // de forma síncrona (o `salvar` é síncrono de propósito).
  try { registroDeImpressao.salvar() } catch (_) {}
  if (mqttClient) { mqttClient.end(true); mqttClient = null }
  atualizarTray('desconectado')
  abrirLogin()
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

function garantirAgentUuid () {
  let uuid = store.get('agent_uuid')
  if (!uuid) {
    uuid = uuidv4()
    store.set('agent_uuid', uuid)
  }
  return uuid
}

function notificar (title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
}

// ─── Auto-update ─────────────────────────────────────────────────────────────

function setupAutoUpdater () {
  if (!app.isPackaged) return // sem update em desenvolvimento

  try {
    autoUpdater = require('electron-updater').autoUpdater
    autoUpdater.autoDownload         = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger               = null

    autoUpdater.on('update-available', () => {
      notificar('MaximusHub Print Client', 'Nova versão disponível. Baixando automaticamente...')
    })

    autoUpdater.on('update-downloaded', () => {
      updateDownloaded = true
      notificar('MaximusHub Print Client', 'Atualização pronta! Clique no ícone da bandeja para instalar.')
      atualizarTray(trayStatus)
      // Versão CRÍTICA se instala sozinha quando a máquina estiver ociosa.
      void tentarReinicioAutomatico()
    })

    autoUpdater.on('error', (err) => {
      console.error('[UPDATE] electron-updater error:', err.message)
    })
  } catch (err) {
    console.error('[UPDATE] Falha ao carregar electron-updater:', err.message)
  }
}

/** A versão declarada pelo Hub é obrigatória? (lido em `verificarAtualizacao`) */
let atualizacaoObrigatoria = false
/** Evita dois laços de tentativa rodando ao mesmo tempo. */
let tentativaDeReinicio = null

/**
 * Instala a atualização CRÍTICA sozinho — quando for seguro.
 *
 * A regra de "é seguro" é pura e mora em `src/atualizacao-critica.js`, com
 * as duas guardas e o porquê de cada uma. Aqui ficam só as PONTAS: perguntar
 * à fila se há impressão, ao registro quantos ACKs faltam, e chamar o
 * `quitAndInstall`.
 *
 * ⚠️ **Reavalia enquanto estiver ocupado**, em vez de desistir: a máquina da
 * expedição passa o dia imprimindo em rajadas, e a janela ociosa chega. Quem
 * desiste na primeira tentativa não atualiza nunca.
 *
 * ⚠️ **Manda os ACKs pendentes ANTES.** Reiniciar com ACK na mão faria o Hub
 * achar que a etiqueta não saiu, e o pull a reimprimiria na volta — a mesma
 * duplicata que este dia inteiro foi gasto corrigindo.
 */
async function tentarReinicioAutomatico () {
  if (tentativaDeReinicio) return
  tentativaDeReinicio = setInterval(() => void avaliarReinicio(), INTERVALO_DE_TENTATIVA_MS)
  await avaliarReinicio()
}

async function avaliarReinicio () {
  const pendentesDeAck = registroDeImpressao.pendentesDeConfirmacao().length
  const { reiniciar, motivo } = decidirReinicio({
    baixado: updateDownloaded,
    obrigatoria: atualizacaoObrigatoria,
    imprimindo: filaDeImpressao.ocupada(),
    acksPendentes: pendentesDeAck,
  })

  if (!reiniciar) {
    registrar(`[update] ${explicarReinicio(motivo)}`)
    // Confirmação pendente é resolvível agora; impressão não.
    if (motivo === 'acks_pendentes') await enviarAcksPendentes()
    if (motivo === 'nao_obrigatoria' || motivo === 'sem_download') {
      clearInterval(tentativaDeReinicio)
      tentativaDeReinicio = null
    }
    return
  }

  registrar(`[update] ${explicarReinicio(motivo)}`)
  clearInterval(tentativaDeReinicio)
  tentativaDeReinicio = null
  registroDeImpressao.salvar()
  if (autoUpdater) autoUpdater.quitAndInstall(true, true)
}

async function verificarAtualizacao () {
  const token = store.get('token')
  if (!token) return

  try {
    const res    = await axios.get(`${HUB_API}/printer-client/version`)
    const latest = res.data?.data
    if (!latest) return

    const isNewer = compareVersions(latest.version, APP_VERSION) > 0
    if (!isNewer) return

    /*
     * ⚠️ Guardado para o `update-downloaded`: é lá que se decide reiniciar
     * sozinho, e naquele momento a resposta do Hub já passou. Sem isto, uma
     * versão crítica ficaria esperando alguém clicar na bandeja — que foi o
     * que deixou a RDF 5 dias numa versão com defeito conhecido.
     */
    atualizacaoObrigatoria = Boolean(latest.is_required)

    if (latest.is_required) {
      const { response } = await dialog.showMessageBox({
        type:      'warning',
        title:     'Atualização obrigatória',
        message:   `Versão ${latest.version} disponível (obrigatória)`,
        detail:    latest.release_notes
          || 'Esta versão contém correções críticas. Por favor, atualize agora.',
        buttons:   ['Instalar automaticamente', 'Baixar manualmente'],
        defaultId: 0,
      })

      if (response === 0 && autoUpdater) {
        autoUpdater.checkForUpdatesAndNotify()
      } else {
        shell.openExternal(
          process.platform === 'darwin'
            ? 'https://github.com/Maximus-Hub-BR/maximus-printer-client/releases/latest'
            : (latest.download_url ||
              'https://github.com/Maximus-Hub-BR/maximus-printer-client/releases/latest')
        )
      }
    } else {
      // Não-obrigatória: dispara o updater silenciosamente
      if (autoUpdater) {
        autoUpdater.checkForUpdates()
      }
    }
  } catch (err) {
    console.error('[UPDATE] Erro ao verificar versão:', err.message)
  }
}

function compareVersions (a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
