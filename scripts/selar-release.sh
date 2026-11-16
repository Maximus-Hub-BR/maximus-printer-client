#!/bin/bash
# Sela uma release publicada: cria as CÓPIAS DE NOME FIXO que os links
# públicos servem e prova que elas abrem.
#
# 🚨 POR QUE ISTO EXISTE (07/11/2026)
#
# `maximushub.com.br/print-client.dmg` e `.exe` são 302 para
# `releases/latest/download/MHubPrintClient-Setup.{dmg,exe}` — nome FIXO, sem
# versão, que é a única forma de o link na mão de alguém continuar valendo. O
# `artifactName` do package.json põe a versão no nome, então essas cópias são
# um ato separado da publicação.
#
# Isso já quebrou DUAS vezes, pelos dois caminhos possíveis:
#   31/10/2026 — a cópia era subida à mão e existia só na 1.0.21; publicar a
#                1.0.22 moveu o `latest` e os dois links deram 404.
#   05/11/2026 — a 1.0.31 foi publicada à MÃO (fora do Actions, que é o único
#                caminho que criava a cópia do `.exe`) e os dois links
#                voltaram a dar 404, por dois dias, sem nada avisar.
#
# A lição das duas: **a cópia de nome fixo não pode depender de quem publicou.**
# Este script roda sobre a release JÁ PUBLICADA, por qualquer caminho, e é o
# último passo de toda publicação.
#
# E ele FALHA FECHADO: se o DMG não estiver notarizado, não publica cópia
# nenhuma. Um link 404 é um transtorno; um link que entrega um DMG que o
# Gatekeeper chama de "danificado" é um atendimento de suporte.
#
# Uso:  scripts/selar-release.sh 1.0.31
set -euo pipefail

REPO="Maximus-Hub-BR/maximus-printer-client"
versao="${1:-}"
if [ -z "$versao" ]; then
  echo "uso: $0 <versao>   (ex.: $0 1.0.31)" >&2; exit 1
fi
tag="v${versao}"

# ⚠️ Os links públicos apontam para `releases/latest/download/...`, então a
# cópia de nome fixo só tem efeito na release que É a `latest`. Selar uma
# antiga publicaria uma cópia que ninguém baixa e faria a prova dos links
# comparar com a versão errada.
atual=$(gh release view --repo "$REPO" --json tagName -q .tagName)
if [ "$atual" != "$tag" ]; then
  echo "ERRO: a release 'latest' e $atual, nao $tag." >&2
  echo "Os links publicos servem sempre a 'latest' - selar $tag nao teria efeito." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

echo "== baixando os instaladores de $tag"
gh release download "$tag" --repo "$REPO" \
  -p "MHubPrintClient-Setup-${versao}.dmg" \
  -p "MHubPrintClient-Setup-${versao}.exe"

# ⚠️ `curl -o`/download com build falho grava a PÁGINA DE ERRO, e ela tem
# cara de arquivo. Guarda de tamanho + `file` antes de distribuir binário.
for par in "dmg:zlib" "exe:PE32"; do
  ext="${par%%:*}"; esperado="${par##*:}"
  arq="MHubPrintClient-Setup-${versao}.${ext}"
  bytes=$(stat -f "%z" "$arq")
  tipo=$(file -b "$arq")
  if [ "$bytes" -lt 10000000 ]; then
    echo "ERRO: $arq tem só $bytes bytes — não é um instalador" >&2; exit 1
  fi
  case "$tipo" in
    *"$esperado"*) : ;;
    *) echo "ERRO: $arq não parece $ext ($tipo)" >&2; exit 1 ;;
  esac
  echo "   $arq  $bytes bytes  [$tipo]"
done

# 🚨 A guarda que falha fechado. O DMG do Actions é gerado com
# `CSC_IDENTITY_AUTO_DISCOVERY: false` (o runner não tem o Developer ID da
# VCZ), e um DMG só assinado, sem o ticket grampeado, o Gatekeeper rejeita.
# Quem publica a versão que abre em qualquer Mac é este Mac, com
# `notarytool` + `stapler` — e só depois disso a cópia pode subir.
echo "== conferindo a notarização do DMG"
dmg="MHubPrintClient-Setup-${versao}.dmg"
# ⚠️ `spctl` sozinho NÃO prova grampeamento: sem ticket no arquivo ele
# consulta a Apple pela rede e responde `accepted` de qualquer forma. Medido
# em 07/11/2026. A máquina da expedição pode estar sem internet ou atrás de
# firewall, e aí só vale o ticket GRAMPEADO — que é o que `stapler validate`
# mede. Os dois juntos, porque medem coisas diferentes.
grampeado=$(xcrun stapler validate "$dmg" 2>&1 | tail -1 || true)
veredito=$(spctl -a -vvv -t open --context context:primary-signature "$dmg" 2>&1 || true)
echo "   stapler: $grampeado"
echo "$veredito" | sed 's/^/   /'
if ! grep -q "validate action worked" <<<"$grampeado" \
   || ! grep -q "Notarized Developer ID" <<<"$veredito"; then
  echo "" >&2
  echo "ERRO: o DMG de $tag NÃO está notarizado — nada foi publicado." >&2
  echo "Notarize e republique antes de selar:" >&2
  echo "  xcrun notarytool submit $dmg --key ~/keystores/AuthKey_tecworks.p8 \\" >&2
  echo "    --key-id <ascKeyId> --issuer <ascIssuerId> --wait" >&2
  echo "  xcrun stapler staple $dmg" >&2
  echo "  # grampear MUDA o hash: recalcule a entrada do .dmg no latest-mac.yml" >&2
  exit 1
fi

echo "== publicando as cópias de nome fixo"
# ⚠️ É CÓPIA, não renomeação: o `latest.yml`/`latest-mac.yml` que o
# electron-updater consulta aponta para o nome COM versão, e renomear aquele
# arquivo pararia o auto-update do parque.
cp "MHubPrintClient-Setup-${versao}.dmg" MHubPrintClient-Setup.dmg
cp "MHubPrintClient-Setup-${versao}.exe" MHubPrintClient-Setup.exe
gh release upload "$tag" MHubPrintClient-Setup.dmg MHubPrintClient-Setup.exe \
  --clobber --repo "$REPO"

echo "== provando os links PÚBLICOS (é o que a pessoa clica)"
falhou=0
for par in "print-client.dmg:MHubPrintClient-Setup-${versao}.dmg" \
           "print-client.exe:MHubPrintClient-Setup-${versao}.exe"; do
  link="${par%%:*}"; local_arq="${par##*:}"
  esperado=$(stat -f "%z" "$local_arq")
  # o status e o tamanho do ÚLTIMO salto da cadeia de redirects
  servido=$(curl -sIL -A "Mozilla/5.0" "https://maximushub.com.br/${link}" \
            | awk 'BEGIN{IGNORECASE=1} /^HTTP/{s=$2} /^content-length:/{c=$2} END{gsub(/\r/,"",s); gsub(/\r/,"",c); print s" "c}')
  status="${servido%% *}"; bytes="${servido##* }"
  if [ "$status" = "200" ] && [ "$bytes" = "$esperado" ]; then
    echo "   OK  $link -> 200, $bytes bytes"
  else
    echo "   FALHOU  $link -> status=$status bytes=$bytes (esperado 200 / $esperado)" >&2
    falhou=1
  fi
done
[ "$falhou" -eq 0 ] || { echo "os links não conferem" >&2; exit 1; }

echo ""
echo "release $tag selada: os dois links públicos servem a $versao."
