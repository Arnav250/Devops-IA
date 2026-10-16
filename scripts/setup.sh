#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null || { echo 'Docker CLI not found. Install Docker Desktop.' >&2; exit 1; }
command -v kubectl >/dev/null || { echo 'kubectl not found. Install kubectl.' >&2; exit 1; }
command -v minikube >/dev/null || { echo 'Minikube not found. Install Minikube.' >&2; exit 1; }

docker info >/dev/null || { echo 'Docker daemon is unavailable. Start Docker Desktop, then retry.' >&2; exit 1; }
minikube status --profile kubescale-demo >/dev/null 2>&1 || minikube start --profile kubescale-demo --driver=docker
kubectl config use-context kubescale-demo >/dev/null
printf 'Prerequisites ready. Minikube profile: kubescale-demo\n'
