#!/bin/sh
# One-time setup of a fresh Ubuntu/Debian server for UBOCE. Run as root:
#   ssh root@SERVER 'sh -s' < deploy/vps/bootstrap.sh
set -eu

# Docker Engine + Compose plugin.
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Firewall: SSH, HTTP and HTTPS only. Services are reachable through Caddy alone.
if [ -f /etc/iptables/rules.v4 ] && grep -q REJECT /etc/iptables/rules.v4; then
  # Oracle Cloud's Ubuntu images ship iptables rules that reject everything but SSH,
  # and ufw must not be enabled on them. Open 80/443 before the final REJECT rule.
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
    # shellcheck disable=SC2086
    iptables -C INPUT -m state --state NEW $rule -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -m state --state NEW $rule -j ACCEPT
  done
  netfilter-persistent save
elif command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable
fi

# Swap as a safety margin for 22 Node processes on a small server.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p /opt/uboce/env /opt/uboce/secrets /opt/uboce/web
chmod 700 /opt/uboce/env /opt/uboce/secrets

echo
echo "Server ready. If the images on ghcr.io are private, log in once:"
echo "  echo <GitHub token with read:packages> | docker login ghcr.io -u <github user> --password-stdin"
