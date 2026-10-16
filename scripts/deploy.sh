#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="kubescale-demo"
IMAGE="kubescale-demo:1.0.0"

"$ROOT_DIR/scripts/setup.sh"
cd "$ROOT_DIR"
printf 'Building %s with Docker...\n' "$IMAGE"
docker build --platform linux/arm64 -t "$IMAGE" .
printf 'Loading image into Minikube...\n'
minikube image load "$IMAGE" --profile "$PROFILE"
printf 'Applying Kubernetes resources...\n'
kubectl apply -f k8s/
kubectl rollout status deployment/kubescale-app --timeout=120s
kubectl rollout status deployment/kubescale-nginx --timeout=120s
printf '\nDeployment ready.\n'
kubectl get pods -o wide
kubectl get svc
printf '\nOpen the app with:\n  minikube service kubescale-nginx --url --profile %s\n' "$PROFILE"
