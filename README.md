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

The controls return `404` unless `ENABLE_TEST_CONTROLS=true`. To demonstrate a deployment-wide unready state instead, edit the ConfigMap value to `HEALTH_MODE: unhealthy`, apply it, and restart the Deployment; restore `healthy` afterward. This is intentionally a test mechanism, not a permanent production health behavior.

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
