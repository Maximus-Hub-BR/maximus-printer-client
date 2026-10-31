/**
 * ENVIO RAW PARA O SPOOLER DO WINDOWS — a montagem do script PowerShell.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ POR QUE ISTO VIVE NUM MÓDULO PRÓPRIO, COM TESTE
 * ══════════════════════════════════════════════════════════════════════════
 * Este pedaço de código **falhou em silêncio três vezes**, e nenhuma delas
 * apareceu como erro de impressão — a etiqueta saía pelo caminho do PDF e o
 * comando simplesmente nunca chegava à impressora:
 *
 *  1. até 1.0.6: `DOC_INFO_1` declarada como `int[3]` (12 bytes) onde são
 *     TRÊS PONTEIROS (24 bytes em x64), e `|Out-Null` engolindo todo retorno;
 *  2. 1.0.7/1.0.8: o script inteiro era colapsado numa linha só por um
 *     `.replace(/\n\s+/g, ' ')`, para caber em `powershell -Command`. O log da
 *     expedição em 09/10/2026 mostrou o resultado:
 *
 *         $ErrorActionPreference='Stop' Add-Type -TypeDefinition @" ...
 *                                       ~~~~~~~~
 *         Token 'Add-Type' inesperado na expressao ou instrucao.
 *         No linha:1 caractere:32
 *
 *     "linha 1" é o diagnóstico inteiro. Numa linha só, os comandos ficam sem
 *     `;` entre eles **e** o here-string `@"…"@` deixa de ser válido — ele
 *     exige quebra de linha logo depois do `@"` e o `"@` começando a linha.
 *
 * A lição: **o script não cabe numa linha de comando.** Ele vai para um
 * arquivo `.ps1`, e os dados vão como ARGUMENTO (`param(...)`), nunca
 * interpolados no código — assim nome de impressora com aspas deixa de ser um
 * problema de escape.
 *
 * ⚠️ `pDatatype = "RAW"` é obrigatório. Sem ele o spooler usa o padrão do
 * driver, que no ZDesigner pode ser gráfico — e aí os bytes do ZPL saem
 * IMPRESSOS como texto na etiqueta, em vez de interpretados.
 */

/**
 * O script, pronto para ser gravado em `.ps1`.
 *
 * ⚠️ Nenhum dado entra aqui: impressora e arquivo chegam por `param`. A função
 * não recebe argumento NENHUM de propósito — é a garantia estrutural de que
 * não há interpolação a escapar.
 */
function scriptPowerShell() {
  return `param([string]$impressora,[string]$arquivo)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.IO;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDatatype; }
public class RawPrint {
  [DllImport("winspool.drv",EntryPoint="OpenPrinterW",SetLastError=true,CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string printerName,out IntPtr hPrinter,IntPtr pd);
  [DllImport("winspool.drv",EntryPoint="ClosePrinter",SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv",EntryPoint="StartDocPrinterW",SetLastError=true,CharSet=CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr hPrinter,int level,ref DOCINFO di);
  [DllImport("winspool.drv",EntryPoint="EndDocPrinter",SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv",EntryPoint="StartPagePrinter",SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv",EntryPoint="EndPagePrinter",SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv",EntryPoint="WritePrinter",SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter,byte[] pBytes,int dwCount,out int dwWritten);
  public static void Enviar(string impressora,string arquivo){
    IntPtr h;
    if(!OpenPrinter(impressora, out h, IntPtr.Zero))
      throw new Exception("OpenPrinter falhou: "+Marshal.GetLastWin32Error());
    try{
      DOCINFO di=new DOCINFO();
      di.pDocName="MaximusHub RAW"; di.pDatatype="RAW";
      if(StartDocPrinter(h,1,ref di)==0)
        throw new Exception("StartDocPrinter falhou: "+Marshal.GetLastWin32Error());
      try{
        if(!StartPagePrinter(h))
          throw new Exception("StartPagePrinter falhou: "+Marshal.GetLastWin32Error());
        byte[] b=File.ReadAllBytes(arquivo); int escritos=0;
        if(!WritePrinter(h,b,b.Length,out escritos))
          throw new Exception("WritePrinter falhou: "+Marshal.GetLastWin32Error());
        if(escritos!=b.Length)
          throw new Exception("WritePrinter escreveu "+escritos+" de "+b.Length+" bytes");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
[RawPrint]::Enviar($impressora,$arquivo)
`;
}

/**
 * A linha de comando.
 *
 * ⚠️ `-File`, nunca `-Command`: é `-Command` que obriga a achatar o script e
 * foi o que quebrou a 1.0.7/1.0.8.
 *
 * ⚠️ Mantida para quem ainda monta string de shell; o caminho de impressão
 * usa `argumentosPowerShell` (abaixo), que não passa por shell nenhum.
 */
function comandoPowerShell(caminhoDoScript, nomeDaImpressora, caminhoDoArquivo) {
  return (
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${caminhoDoScript}" ` +
    `"${nomeDaImpressora}" "${caminhoDoArquivo}"`
  );
}

/**
 * Os MESMOS argumentos, em forma de lista — para `execFile`, sem shell.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 POR QUE ESTA FORMA EXISTE (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * O envio RAW era feito com `execSync`, que **bloqueia o event loop do
 * Node** até o PowerShell terminar. Enquanto o lote ia para a Zebra, o
 * cliente não respondia ao keepalive de 30 s do MQTT e o broker o
 * derrubava — e, com `clean: true`, tudo o que o Hub publicava nesse
 * intervalo EVAPORAVA (ver `reenvio-de-jobs-sem-ack.ts` no backend).
 *
 * Medido na RDF em 30/10/2026, nas duas máquinas e em duas versões
 * diferentes do cliente (1.0.14 e 1.0.17):
 *
 *   agente 35:  87 etiquetas com ACK, queda às 15:28:55 — o 81º job do lote
 *               foi publicado às 15:28:56, o segundo seguinte à queda;
 *   agente 39:  79 com ACK, queda logo após as 16:17:05, 173 publicadas no
 *               vácuo;
 *   o MESMO cliente ficou 5 h 13 min conectado sem cair imprimindo 645
 *   etiquetas em **PDF** — que usa `await`. As três quedas do dia foram
 *   todas dentro de lote ZPL.
 *
 * ⚠️ Pior no caminho de erro: quando o lote estourava o timeout, a fila
 * refazia as 25 etiquetas **uma a uma**, cada uma com um PowerShell novo
 * compilando C# (`Add-Type`) — um bloqueio de quase um minuto seguido, que
 * garantia a queda.
 *
 * ⚠️ `execFile` com LISTA também elimina o shell: nome de impressora com
 * aspas ou `&` deixa de depender de escape (o `comandoPowerShell` embutia
 * os três valores numa string de comando).
 */
function argumentosPowerShell(caminhoDoScript, nomeDaImpressora, caminhoDoArquivo) {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    caminhoDoScript,
    nomeDaImpressora,
    caminhoDoArquivo,
  ];
}

/**
 * O teto de espera do envio RAW, em ms — PROPORCIONAL ao lote.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🚨 TETO FIXO É O DEFEITO, NÃO O VALOR DO TETO (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Até a 1.0.17 era `timeout: 15000`, fixo, e foi ele que produziu os dois
 * sintomas da RDF no mesmo dia. `WritePrinter` só retorna quando o destino
 * consome os bytes: num lote de 25 etiquetas gráficas (1,2 MB) a GC420t
 * devolveu em 10 s — cabia —, e a ZD220 passou dos 15 s. Passar do teto não
 * é "um pouco mais devagar": o PowerShell é MORTO, a fila considera o lote
 * falho e **refaz as 25 uma a uma**, um processo por etiqueta. Medido:
 * 8,2 s por etiqueta contra 0,36 s na máquina que cabia no teto (20×), e
 * ~3 min de event loop parado, que é o que derrubava o MQTT.
 *
 * Trocar 15 s por outro número fixo só move a fronteira: com 60 s, um lote
 * de 100 etiquetas (ou uma térmica mais lenta) estoura igual e o fallback
 * volta. O teto tem de crescer com o trabalho pedido.
 *
 * ⚠️ A base cobre o custo FIXO (criar o processo e compilar o `Add-Type`,
 * ~2 s medidos) e a parcela por etiqueta é generosa de propósito: 6 s cobre
 * com folga uma 10x15 a 203 dpi na velocidade mais baixa. Errar para o lado
 * curto custa o fallback inteiro; para o lado longo, custa esperar um
 * PowerShell travado — e, desde que o envio é assíncrono, esperar não
 * derruba mais a conexão.
 * ⚠️ O teto do teto existe para que um travamento de verdade ainda vire
 * erro, e a etiqueta volte para a fila em vez de ficar pendurada.
 */
function tetoDoEnvioRaw(etiquetas) {
  const BASE_MS = 20000
  const POR_ETIQUETA_MS = 6000
  const MAXIMO_MS = 10 * 60 * 1000
  const n = Number.isFinite(etiquetas) && etiquetas > 0 ? etiquetas : 1
  return Math.min(BASE_MS + n * POR_ETIQUETA_MS, MAXIMO_MS)
}

module.exports = { scriptPowerShell, comandoPowerShell, argumentosPowerShell, tetoDoEnvioRaw };
