#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '%s\n' "$*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

docker_ready() {
  need_cmd docker && docker info >/dev/null 2>&1
}

if docker_ready; then
  log "Docker is already installed and running."
  exit 0
fi

os="$(uname -s)"

case "$os" in
  Darwin)
    if ! need_cmd brew; then
      log "Homebrew is required to install Docker Desktop on macOS."
      log "Install Homebrew from https://brew.sh, then run: bun run setup"
      exit 1
    fi

    if ! need_cmd docker; then
      log "Installing Docker Desktop with Homebrew..."
      brew install --cask docker
    fi

    log "Docker Desktop is installed. Start it from /Applications/Docker.app, then rerun: bun run setup"
    open -a Docker >/dev/null 2>&1 || true
    exit 0
    ;;

  Linux)
    if ! need_cmd docker; then
      if need_cmd apt-get; then
        log "Installing Docker with apt..."
        sudo apt-get update
        sudo apt-get install -y docker.io
      elif need_cmd dnf; then
        log "Installing Docker with dnf..."
        sudo dnf install -y docker
      elif need_cmd yum; then
        log "Installing Docker with yum..."
        sudo yum install -y docker
      elif need_cmd pacman; then
        log "Installing Docker with pacman..."
        sudo pacman -Sy --noconfirm docker
      elif need_cmd zypper; then
        log "Installing Docker with zypper..."
        sudo zypper --non-interactive install docker
      else
        log "No supported Linux package manager found."
        log "Install Docker manually from https://docs.docker.com/engine/install/"
        exit 1
      fi
    fi

    if need_cmd systemctl; then
      log "Starting Docker service..."
      sudo systemctl enable --now docker
    elif need_cmd service; then
      log "Starting Docker service..."
      sudo service docker start
    fi

    if docker_ready; then
      log "Docker is installed and running."
      exit 0
    fi

    log "Docker was installed but is not usable by the current user."
    log "You may need to log out and back in, or add your user to the docker group:"
    log "  sudo usermod -aG docker \"$USER\""
    exit 1
    ;;

  *)
    log "Unsupported OS: $os"
    log "Install Docker manually from https://docs.docker.com/get-docker/"
    exit 1
    ;;
esac
