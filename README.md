# KubeScale Demo

A local, beginner-friendly demonstration of NGINX load balancing and Kubernetes self-healing. The browser connects only to NGINX. NGINX forwards to the internal Kubernetes Service, and the Service sends traffic to ready Express replicas.

## Architecture

```text
Browser -> NodePort Service (kubescale-nginx:30080)
             -> NGINX pod
             -> ClusterIP Service (kubescale-app:3000)
             -> ready Express pods (3 replicas)
```

A **Pod IP** belongs to one replaceable pod and can change. A **Service IP** is a stable virtual IP and DNS name that selects pods by label. The application **container port** is the port inside each pod (`3000`); the Service maps its port `3000` to that named target port. The NodePort exposes NGINX locally on port `30080`.

NGINX uses the Kubernetes Service DNS name in its upstream. Kubernetes Service networking supplies access to healthy endpoints; NGINX controls the proxy hop and upstream behavior. With one NGINX proxy and Kubernetes Service routing, request patterns are not a promise of strict one-request-per-pod round robin. Use the returned hostname and logs as observations, not fabricated guarantees.

The default NGINX route opens a new upstream connection per request, so the Service can choose a pod for each request. `/api/keepalive/info` deliberately reuses upstream connections to show that Kubernetes balances *connections*: reused connections stay on one pod.

## Frontend scenario lab

The page polls NGINX (`/nginx-health`, `/nginx-status`) and the cluster (`/api/cluster`) every two seconds and shows live replicas, pod status, restarts, Service endpoints and recent Kubernetes events. Every case below is one click:

| Case | What you see |
| --- | --- |
| N1 Load balancing | 10 requests spread across ready pods |
| N2 Keep-alive pinning | fresh connections spread out; a reused connection sticks to one pod |
| N3 App error passthrough | app's 500/503/404/418 forwarded unchanged (source: app) |
| N4 Gateway timeout | 2 s → 200; 8 s → NGINX's own 504 (5 s `proxy_read_timeout`) |
| N5 Rate limiting | `/api/limited` (2 r/s, burst 3) → mix of 200 and NGINX 429 |
| N6 Who answered? | `/nginx-health` answered by NGINX alone vs. app 404 for an unknown API path |
| N7 No ready endpoints | all pods unready for 20 s → NGINX 502, then automatic recovery |
| K1 Readiness failure | one pod unready for 30 s: still running, removed from endpoints |
| K2 Container crash | process exits → kubelet restarts it, RESTARTS +1, same pod name |
| K3 Liveness failure | liveness fails → kubelet restarts the container after ~30 s |
| K4 Pod deleted | ReplicaSet creates a replacement with a new name |
| K5 Scaling | 1–8 replicas |
| K6 Rolling update | rollout restart while traffic keeps succeeding (the `preStop` sleep prevents dropped requests) |

NGINX-generated errors (429, 502, 504) are JSON with `"source":"nginx"`, so the page can tell them apart from application errors. Responses carry `X-Proxy-Host`, `X-Request-ID`, `X-Upstream-Addr` and `X-Upstream-Status` headers. NGINX probes use `/nginx-health`, so NGINX stays ready even when every app pod is down.

The cluster view and the K4–K6 and N7 buttons use the `kubescale-app` ServiceAccount (`k8s/app-account.yaml`): a namespace-scoped Role that can list pods, events and EndpointSlices, delete pods, and get/patch only the `kubescale-app` Deployment. All mutating endpoints return `404` unless `ENABLE_TEST_CONTROLS=true`. The page also lists terminal-only cases (NGINX pod deleted, bad image, never-ready release, insufficient capacity) and shows their effects live.

## Prerequisites (macOS Apple Silicon)

Install and start Docker Desktop, then install `kubectl` and Minikube. The scripts use the Docker driver, which works with Docker Desktop on Apple Silicon. The Node and NGINX images used here publish multi-architecture variants; the application build explicitly targets `linux/arm64`.

Check without changing anything:

```bash
docker info
kubectl version --client
minikube version
```

If Docker is unavailable, start Docker Desktop. If Minikube is stuck, try `minikube delete --profile kubescale-demo` only for this project profile, then rerun setup.

## Start the project

From this directory:

```bash
chmod +x scripts/*.sh
./scripts/setup.sh
./scripts/deploy.sh
```

`deploy.sh` builds `kubescale-demo:1.0.0` with Docker, loads that image into the named Minikube profile, applies every manifest in `k8s/`, and waits for both Deployments. It does not delete or modify unrelated images or Kubernetes resources.

Get a browser URL:

```bash
minikube service kubescale-nginx --url --profile kubescale-demo
```

Open the printed URL. The NodePort is `30080`, but `minikube service --url` is the reliable macOS-compatible access method.

## Practical demonstrations

### A. Initial deployment

```bash
kubectl get deployment kubescale-app
kubectl get pods -l app.kubernetes.io/name=kubescale-app -o wide
kubectl get svc kubescale-app kubescale-nginx
kubectl rollout status deployment/kubescale-app
```

Expected: three application pods become `Running` and `READY 1/1`; the NGINX pod is also ready. The application Service is `ClusterIP`, so it is not a browser endpoint.

### B. Load balancing

Click **Request once** or **Send 10 requests** in the page. The hostname and version appear in the response history.

```bash
URL="$(minikube service kubescale-nginx --url --profile kubescale-demo)"
for i in {1..10}; do curl -s "$URL/api/info"; echo; done
kubectl logs deployment/kubescale-nginx --tail=30
```

The access log proves requests reached NGINX. The response hostname shows which application container replied. Seeing one hostname repeatedly is possible because Service routing and connection reuse do not guarantee strict round robin.

### C. Self-healing

```bash
POD="$(kubectl get pods -l app.kubernetes.io/name=kubescale-app -o jsonpath='{.items[0].metadata.name}')"
kubectl delete pod "$POD"
kubectl get pods -l app.kubernetes.io/name=kubescale-app -w
```

Stop watching with `Ctrl-C`. The Deployment controller creates a replacement to restore three replicas. Existing healthy pods continue serving through the Service.

Kubernetes replaces a failed pod; it does not repair faulty application code. A broken image or deterministic bug will be reproduced in replacement pods.

### D. Scaling

```bash
kubectl scale deployment/kubescale-app --replicas=5
kubectl get pods -l app.kubernetes.io/name=kubescale-app
kubectl get deployment kubescale-app
curl -s "$URL/api/info"

kubectl scale deployment/kubescale-app --replicas=3
kubectl rollout status deployment/kubescale-app
```

Expected: the Deployment reports five replicas, then returns to three, while the stable NGINX URL remains reachable.

### E. Readiness

The app ConfigMap enables test controls only for this local demonstration. Find a pod, then make that pod unready:

```bash
POD="$(kubectl get pods -l app.kubernetes.io/name=kubescale-app -o jsonpath='{.items[0].metadata.name}')"
kubectl port-forward "pod/$POD" 3000:3000
```

In another terminal:

```bash
curl -X POST http://127.0.0.1:3000/api/test/unready
kubectl get pods -l app.kubernetes.io/name=kubescale-app
kubectl get endpoints kubescale-app -o wide
```

The pod stays alive because liveness is still healthy, but its readiness probe returns `503`, so it is removed from normal Service endpoints. Restore it:

```bash
curl -X POST http://127.0.0.1:3000/api/test/ready
kubectl get endpoints kubescale-app -w
```

The controls return `404` unless `ENABLE_TEST_CONTROLS=true`. Setting `HEALTH_MODE: unhealthy` in the ConfigMap and restarting the Deployment does *not* take every pod down: new pods never become ready, so the rolling update stalls after replacing one pod (`maxUnavailable: 1`) and the old ready pods keep serving. Restore `healthy` and restart again afterward. For a true zero-endpoint outage, use the N7 button. This is intentionally a test mechanism, not a permanent production health behavior.

### F. Cleanup

```bash
./scripts/cleanup.sh
```

This deletes only resources described by this project's `k8s/` manifests. It does not delete the Minikube profile, Docker images, or unrelated resources.

## Observability and troubleshooting

```bash
kubectl get pods -o wide
kubectl get svc
kubectl get endpoints kubescale-app
kubectl logs deployment/kubescale-app --all-containers=true --tail=50
kubectl logs deployment/kubescale-nginx --tail=50
kubectl rollout status deployment/kubescale-app
kubectl describe pod <pod-name>
```

If the app image is `ImagePullBackOff`, rerun `docker build -t kubescale-demo:1.0.0 .` and `minikube image load kubescale-demo:1.0.0 --profile kubescale-demo`; confirm the Deployment uses `imagePullPolicy: Never`. If NGINX is not ready, inspect its logs and ConfigMap mount:

```bash
kubectl logs deployment/kubescale-nginx
kubectl get configmap kubescale-nginx-config -o yaml
```

The deployed configuration can be checked in the NGINX container, where the Kubernetes Service DNS name exists:

```bash
kubectl exec deployment/kubescale-nginx -- nginx -t
```

After changing `nginx/nginx.conf`, update the matching ConfigMap content in `k8s/nginx-configmap.yaml`, apply it, and restart NGINX because a mounted `subPath` file does not trigger a live reload:

```bash
kubectl apply -f k8s/nginx-configmap.yaml
kubectl rollout restart deployment/kubescale-nginx
kubectl rollout status deployment/kubescale-nginx
```

The project is designed for a local Minikube environment. The full runtime demonstrations require Docker Desktop, Minikube, and kubectl to be installed and running; static validation can still be performed on a machine without those tools.
