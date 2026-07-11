#!/bin/bash

set -e

echo "================================="
echo " Atualizando servidor"
echo "================================="

apt update -y
apt upgrade -y

apt install -y \
curl \
wget \
git \
nano \
unzip \
htop \
ufw \
ca-certificates \
software-properties-common

echo "================================="
echo " Instalando Docker"
echo "================================="

curl -fsSL https://get.docker.com | sh

systemctl enable docker
systemctl start docker

echo "================================="
echo " Instalando Docker Compose"
echo "================================="

mkdir -p ~/.docker/cli-plugins

curl -SL \
https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
-o ~/.docker/cli-plugins/docker-compose

chmod +x ~/.docker/cli-plugins/docker-compose

echo "================================="
echo " Configurando Firewall"
echo "================================="

ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8000/tcp

ufw --force enable

echo "================================="
echo " Instalando Coolify"
echo "================================="

curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

echo "================================="
echo " Instalando Ollama"
echo "================================="

curl -fsSL https://ollama.com/install.sh | sh

systemctl enable ollama
systemctl start ollama

echo "================================="
echo " Baixando modelo Qwen Coder"
echo "================================="

ollama pull qwen2.5-coder:7b

echo "================================="
echo " Instalando Code Server"
echo "================================="

curl -fsSL https://code-server.dev/install.sh | sh

systemctl enable code-server@$SUDO_USER || true

echo "================================="
echo " Criando diretório projetos"
echo "================================="

mkdir -p /opt/projetos

echo "================================="
echo " Instalação concluída"
echo "================================="

IP=$(curl -s ifconfig.me)

echo ""
echo "Coolify:"
echo "http://$IP:8000"
echo ""
echo "Configure OpenHands, PostgreSQL,"
echo "Redis, n8n e Evolution API pelo painel."
echo ""
