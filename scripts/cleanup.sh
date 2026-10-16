#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="kubescale-demo"

kubectl delete -f "$ROOT_DIR/k8s/" --ignore-not-found
printf 'KubeScale Kubernetes resources removed. The Minikube profile and unrelated resources were left untouched.\n'
