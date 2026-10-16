#!/usr/bin/env bash
set -euo pipefail

PROFILE="kubescale-demo"
APP_DEPLOYMENT="kubescale-app"
NGINX_SERVICE="kubescale-nginx"

printf '%s\n' '=== KubeScale Demo status ==='
kubectl get deployment,pods,svc,endpoints
printf '\n=== Rollout status ===\n'
kubectl rollout status deployment/"$APP_DEPLOYMENT" --timeout=30s
printf '\n=== NGINX URL ===\n'
minikube service "$NGINX_SERVICE" --url --profile "$PROFILE"
printf '\n=== Useful live commands ===\n'
printf 'kubectl logs deployment/%s -f\n' "$APP_DEPLOYMENT"
printf 'kubectl logs deployment/kubescale-nginx -f\n'
printf 'kubectl get endpoints kubescale-app -w\n'
