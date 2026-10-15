#!/bin/sh
# Sincroniza o maximushub-brain no início de cada sessão.
#
# Clona na primeira vez, atualiza nas seguintes. Falha em SILÊNCIO e nunca
# bloqueia a sessão: sem rede, ou sem acesso ao repositório, você continua
# trabalhando — só sem o contexto atualizado.
#
# Onde o brain fica (primeiro que existir vence):
#   $MAXIMUSHUB_BRAIN  →  ~/Sites/_maximushub-brain  →  ~/.maximushub-brain
#
# Para usar outro caminho, exporte MAXIMUSHUB_BRAIN no seu shell.

REPO="git@github.com:Maximus-Hub-BR/maximushub-brain.git"

if [ -n "${MAXIMUSHUB_BRAIN-}" ]; then
  BRAIN="$MAXIMUSHUB_BRAIN"
elif [ -d "$HOME/Sites/_maximushub-brain/.git" ]; then
  BRAIN="$HOME/Sites/_maximushub-brain"
else
  BRAIN="$HOME/.maximushub-brain"
fi

if [ -d "$BRAIN/.git" ]; then
  git -C "$BRAIN" pull --rebase --quiet >/dev/null 2>&1 || true
else
  git clone --quiet "$REPO" "$BRAIN" >/dev/null 2>&1 || true
fi

[ -f "$BRAIN/INDEX.md" ] && printf 'maximushub-brain em %s — leia o INDEX.md antes de começar.\n' "$BRAIN"
exit 0
