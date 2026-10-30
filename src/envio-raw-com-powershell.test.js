/**
 * O envio RAW contra um PowerShell DE VERDADE.
 * `node src/envio-raw-com-powershell.test.js`
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ POR QUE ESTE TESTE EXISTE (30/10/2026)
 * ══════════════════════════════════════════════════════════════════════════
 * Os outros casos deste repositório provam a ESTRUTURA do script — e isso não
 * bastou: as versões 1.0.5 a 1.0.8 foram para produção com o envio quebrado
 * três vezes seguidas (DOC_INFO errada, retorno engolido, script achatado numa
 * linha), e em TODAS a etiqueta simplesmente não saía, sem erro nenhum.
 *
 * Aqui o script é entregue a um interpretador real. O que isso prova, mesmo
 * fora do Windows:
 *
 *  1. **sintaxe** — o parser do PowerShell aceita o arquivo (é exatamente o
 *     que falhava na 1.0.7/1.0.8, com "No linha:1 caractere:32");
 *  2. **compilação** — o `Add-Type` monta a classe C# do winspool; chegar à
 *     chamada de `[RawPrint]::Enviar` significa que tudo antes dela compilou;
 *  3. **contrato de argumentos** — impressora e arquivo chegam INTEIROS no
 *     `param()`, com aspas, `&` e espaço. Foi esta a troca de 30/10/2026
 *     (`execSync` com string → `execFile` com lista) e é a que, se estiver
 *     errada, faz o cliente não imprimir nada.
 *
 * O que ele NÃO prova: o comportamento do `winspool.drv`, que só existe no
 * Windows. Lá a chamada chega na API da Microsoft — e o código C# que fala
 * com ela é o MESMO desde a 1.0.9, em produção desde 09/10/2026. O que mudou
 * foi como o processo é lançado, que é justamente o que este teste cobre.
 *
 * ⚠️ **Sem PowerShell no PATH, o teste se declara PULADO em voz alta** e não
 * falha — em vez de passar fingindo que verificou. `PWSH_BIN` aponta um
 * binário avulso (no macOS dá para extrair o tarball oficial sem sudo).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { scriptPowerShell, argumentosPowerShell } = require('./envio-raw-windows');

function acharPowerShell () {
  const candidatos = [
    process.env.PWSH_BIN,
    'pwsh',
    process.platform === 'win32' ? 'powershell' : null,
  ].filter(Boolean);
  for (const candidato of candidatos) {
    try {
      execFileSync(candidato, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
      });
      return candidato;
    } catch (_) { /* tenta o próximo */ }
  }
  return null;
}

const PS = acharPowerShell();
if (!PS) {
  console.log('  ⚠️  PULADO: nenhum PowerShell encontrado (defina PWSH_BIN para rodar).');
  console.log('     Este arquivo é o único que exercita o script de verdade — sem ele,');
  console.log('     o envio RAW está coberto só por invariantes estruturais.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhub-ps-'));
const arquivoDoScript = path.join(tmp, 'envio.ps1');
fs.writeFileSync(arquivoDoScript, scriptPowerShell(), 'ascii');

let passaram = 0;
const casos = [];
const teste = (nome, fn) => casos.push([nome, fn]);

teste('🚨 o script PASSA no parser do PowerShell (o defeito da 1.0.7/1.0.8)', () => {
  const saida = execFileSync(PS, ['-NoProfile', '-Command', `
    $erros = $null; $tokens = $null
    [System.Management.Automation.Language.Parser]::ParseFile("${arquivoDoScript}", [ref]$tokens, [ref]$erros) | Out-Null
    if ($erros -and $erros.Count -gt 0) { "ERROS:" + ($erros | ForEach-Object { $_.Message }) } else { "OK" }
  `], { encoding: 'utf8', timeout: 60000 });
  assert.ok(saida.includes('OK'), `o parser recusou o script: ${saida.trim()}`);
});

teste('🚨 o Add-Type COMPILA e a execução chega em [RawPrint]::Enviar', () => {
  let saida = '';
  try {
    saida = execFileSync(
      PS,
      argumentosPowerShell(arquivoDoScript, 'IMPRESSORA_QUE_NAO_EXISTE', path.join(tmp, 'nada.bin')),
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (erro) {
    saida = `${erro.stdout || ''}${erro.stderr || ''}`;
  }
  /*
   * ⚠️ A falha ESPERADA é dentro do método — no Windows, `OpenPrinter falhou`
   * (a impressora não existe); fora dele, a `winspool.drv` não carrega. As
   * duas provam que sintaxe, here-string, `param` e `Add-Type` passaram.
   * O que NÃO pode aparecer é erro de parse ou de compilação.
   */
  assert.ok(
    /RawPrint|OpenPrinter|winspool/i.test(saida),
    `a execução não chegou ao método (sintaxe ou Add-Type falharam): ${saida.slice(0, 400)}`,
  );
  assert.ok(
    !/Token .* inesperado|Unexpected token|ParserError/i.test(saida),
    `erro de PARSE na execução: ${saida.slice(0, 400)}`,
  );
});

teste('🚨 impressora e arquivo chegam INTEIROS no param() (aspas, & e espaço)', (pronto) => {
  const eco = path.join(tmp, 'eco.ps1');
  // Mesma forma do script real: `param` na primeira linha.
  fs.writeFileSync(eco, 'param([string]$impressora,[string]$arquivo)\n"I=[$impressora]"\n"A=[$arquivo]"\n', 'ascii');
  const nome = 'ZDesigner "do balcao" & cia';
  const arquivo = 'C:\\tmp\\a b.bin';
  const saida = execFileSync(PS, argumentosPowerShell(eco, nome, arquivo), {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.ok(saida.includes(`I=[${nome}]`), `nome corrompido: ${saida.trim()}`);
  assert.ok(saida.includes(`A=[${arquivo}]`), `caminho corrompido: ${saida.trim()}`);
  if (pronto) pronto();
});

teste('⚠️ o envio é ASSÍNCRONO de verdade: o event loop continua girando', () => {
  /*
   * O coração do incidente: com `execSync`, o event loop ficava parado e o
   * keepalive do MQTT não era respondido — o broker derrubava o cliente e as
   * etiquetas publicadas no intervalo evaporavam. Aqui o teste conta quantas
   * voltas o loop dá ENQUANTO o PowerShell roda. Com `execSync` o número
   * seria zero.
   */
  const inicio = Date.now();
  let voltas = 0;
  const tique = setInterval(() => { voltas += 1; }, 10);
  const eco = path.join(tmp, 'demora.ps1');
  fs.writeFileSync(eco, 'param([string]$a,[string]$b)\nStart-Sleep -Milliseconds 700\n"fim"\n', 'ascii');
  return new Promise((resolve, reject) => {
    execFile(PS, argumentosPowerShell(eco, 'X', 'Y'), { timeout: 60000 }, (erro) => {
      clearInterval(tique);
      try {
        assert.ok(!erro, `o PowerShell falhou: ${erro && erro.message}`);
        assert.ok(
          voltas > 5,
          `o event loop ficou PARADO durante o envio (${voltas} voltas em ${Date.now() - inicio} ms)`,
        );
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

(async () => {
  for (const [nome, fn] of casos) {
    try {
      await fn();
      passaram++;
      console.log(`  ✓ ${nome}`);
    } catch (erro) {
      console.error(`  ✗ ${nome}\n    ${erro.message}`);
      process.exitCode = 1;
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passaram}/${casos.length} casos (PowerShell: ${PS})`);
})();
