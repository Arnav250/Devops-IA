const express = require('express');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const appVersion = process.env.APP_VERSION || '1.0.0';
const healthMode = process.env.HEALTH_MODE || 'healthy';
const testControlsEnabled = process.env.ENABLE_TEST_CONTROLS === 'true';
const hostname = os.hostname();
const podIp = process.env.POD_IP || null;
const nodeName = process.env.NODE_NAME || null;
const startedAt = new Date().toISOString();

const serviceAccountDir = '/var/run/secrets/kubernetes.io/serviceaccount';
const kubeHost = process.env.KUBERNETES_SERVICE_HOST;
const kubePort = process.env.KUBERNETES_SERVICE_PORT || '443';
const namespace = (process.env.POD_NAMESPACE || readFileOrDefault(path.join(serviceAccountDir, 'namespace'), 'default')).trim();
const appName = 'kubescale-app';
const proxyName = 'kubescale-nginx';
const deploymentPath = `/apis/apps/v1/namespaces/${namespace}/deployments/${appName}`;
const maxReplicas = 8;

// Readiness is withdrawn until this timestamp; Infinity means until /api/test/ready is called.
let unreadyUntil = 0;
let livenessBroken = false;
let kubeCa = null;

function readFileOrDefault(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function isReady() {
  return healthMode !== 'unhealthy' && Date.now() >= unreadyUntil;
}

function identity() {
  return { hostname, podIp, nodeName, version: appVersion };
}

function kubeAvailable() {
  return Boolean(kubeHost) && fs.existsSync(path.join(serviceAccountDir, 'token'));
}

function kubeRequest(method, apiPath, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    kubeCa ??= fs.readFileSync(path.join(serviceAccountDir, 'ca.crt'));
    // Projected service account tokens rotate, so read the token for every call.
    const token = fs.readFileSync(path.join(serviceAccountDir, 'token'), 'utf8').trim();
    const request = https.request({
      host: kubeHost,
      port: kubePort,
      path: apiPath,
      method,
      ca: kubeCa,
      timeout: 3000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(payload && { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) })
      }
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = null; }
        if (response.statusCode >= 400) {
          const error = new Error(parsed?.message || `Kubernetes API returned ${response.statusCode}`);
          error.statusCode = response.statusCode;
          return reject(error);
        }
        return resolve(parsed);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Kubernetes API request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function listPods(name) {
  const selector = encodeURIComponent(`app.kubernetes.io/name=${name}`);
  const list = await kubeRequest('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}`);
  return list.items || [];
}

function podStatus(pod) {
  if (pod.metadata.deletionTimestamp) return 'Terminating';
  for (const container of pod.status.containerStatuses || []) {
    if (container.state?.waiting?.reason) return container.state.waiting.reason;
    if (container.state?.terminated?.reason) return container.state.terminated.reason;
  }
  const unschedulable = (pod.status.conditions || []).find((c) => c.type === 'PodScheduled' && c.status === 'False');
  if (unschedulable) return unschedulable.reason || 'Unschedulable';
  return pod.status.reason || pod.status.phase || 'Unknown';
}

function summarizePod(pod) {
  const containers = pod.status.containerStatuses || [];
  const lastTerminated = containers.find((c) => c.lastState?.terminated)?.lastState.terminated;
  return {
    name: pod.metadata.name,
    status: podStatus(pod),
    phase: pod.status.phase,
    ready: (pod.status.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True'),
    terminating: Boolean(pod.metadata.deletionTimestamp),
    restarts: containers.reduce((sum, c) => sum + (c.restartCount || 0), 0),
    lastExit: lastTerminated ? `${lastTerminated.reason || 'Exited'} (${lastTerminated.exitCode})` : null,
    ip: pod.status.podIP || null,
    node: pod.spec.nodeName || null,
    createdAt: pod.metadata.creationTimestamp,
    self: pod.metadata.name === hostname
  };
}

function summarizeDeployment(deployment) {
  const status = deployment.status || {};
  const desired = deployment.spec.replicas ?? 0;
  const summary = {
    desired,
    current: status.replicas ?? 0,
    ready: status.readyReplicas ?? 0,
    updated: status.updatedReplicas ?? 0,
    available: status.availableReplicas ?? 0,
    unavailable: status.unavailableReplicas ?? 0,
    maxSurge: deployment.spec.strategy?.rollingUpdate?.maxSurge ?? null,
    maxUnavailable: deployment.spec.strategy?.rollingUpdate?.maxUnavailable ?? null,
    conditions: (status.conditions || []).map(({ type, status: value, reason, message }) => ({ type, status: value, reason, message }))
  };
  summary.converged = (status.observedGeneration ?? 0) >= (deployment.metadata.generation ?? 0)
    && summary.updated === desired && summary.current === desired && summary.available === desired;
  return summary;
}

function summarizeEvents(events) {
  return (events.items || [])
    .filter((event) => event.involvedObject?.name?.startsWith('kubescale-'))
    .map((event) => ({
      type: event.type,
      reason: event.reason,
      object: `${event.involvedObject.kind}/${event.involvedObject.name}`,
      message: event.message,
      count: event.count || 1,
      time: event.lastTimestamp || event.eventTime || event.metadata.creationTimestamp
    }))
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 15);
}

function requireTestControls(req, res, next) {
  if (!testControlsEnabled) return res.status(404).json({ source: 'app', error: 'Test controls are disabled' });
  return next();
}

function requireKube(req, res, next) {
  if (!kubeAvailable()) return res.status(503).json({ source: 'app', error: 'This process is not running in a Kubernetes pod, so the cluster API is unavailable' });
  return next();
}

// Express 4 does not catch rejected promises from async handlers.
const handle = (fn) => (req, res) => fn(req, res).catch((error) => {
  console.error(`${req.method} ${req.path} failed: ${error.message}`);
  const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
  res.status(status).json({ source: 'app', error: error.message, hostname });
});

app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// /api/limited and /api/keepalive/info exist so NGINX can apply different proxy rules to the same payload.
app.get(['/api/info', '/api/limited', '/api/keepalive/info'], (req, res) => {
  res.json({
    application: 'KubeScale Demo',
    ...identity(),
    ready: isReady(),
    startedAt,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  if (req.query.check === 'liveness' && livenessBroken) {
    return res.status(500).json({ status: 'broken', hostname, version: appVersion });
  }

  if (req.query.check === 'readiness' && !isReady()) {
    return res.status(503).json({ status: 'unready', hostname, version: appVersion });
  }

  return res.json({ status: 'ok', hostname, version: appVersion });
});

app.post('/api/test/unready', requireTestControls, (req, res) => {
  const seconds = req.query.seconds === undefined ? null : clampInt(req.query.seconds, 30, 1, 300);
  unreadyUntil = seconds ? Date.now() + seconds * 1000 : Infinity;
  console.log(`Readiness withdrawn ${seconds ? `for ${seconds}s` : 'until restored'}`);
  res.json({ status: 'unready', ...identity(), seconds });
});

app.post('/api/test/ready', requireTestControls, (req, res) => {
  unreadyUntil = 0;
  res.json({ status: 'ready', ...identity() });
});

app.post('/api/test/break-liveness', requireTestControls, (req, res) => {
  livenessBroken = true;
  console.log('Liveness probe will now fail; kubelet should restart this container');
  res.json({ status: 'liveness-broken', ...identity() });
});

app.post('/api/test/crash', requireTestControls, (req, res) => {
  console.log('Crash requested; exiting with code 1');
  res.on('finish', () => setTimeout(() => process.exit(1), 100));
  res.json({ status: 'crashing', ...identity() });
});

// Withdraws readiness on every app pod by calling each pod IP directly, bypassing the Service.
app.post('/api/test/outage', requireTestControls, requireKube, handle(async (req, res) => {
  const seconds = clampInt(req.query.seconds, 20, 5, 60);
  const pods = (await listPods(appName)).filter((pod) => pod.status.podIP && !pod.metadata.deletionTimestamp);
  const results = await Promise.all(pods.map(async (pod) => {
    try {
      const response = await fetch(`http://${pod.status.podIP}:${port}/api/test/unready?seconds=${seconds}`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000)
      });
      return { pod: pod.metadata.name, status: response.status };
    } catch (error) {
      return { pod: pod.metadata.name, status: 0, error: error.message };
    }
  }));
  res.json({ seconds, results, hostname });
}));

app.get('/api/simulate-delay', async (req, res) => {
  const delayMs = clampInt(req.query.ms, 0, 0, 10000);

  await new Promise((resolve) => setTimeout(resolve, delayMs));
  res.json({ application: 'KubeScale Demo', ...identity(), delayMs, timestamp: new Date().toISOString() });
});

app.get('/api/simulate-error', (req, res) => {
  const status = clampInt(req.query.status, 500, 400, 599);
  res.status(status).json({ source: 'app', status, error: `Simulated ${status} returned by the application`, ...identity() });
});

app.get('/api/cluster', async (req, res) => {
  const base = { servedBy: identity(), namespace, testControls: testControlsEnabled, maxReplicas };
  if (!kubeAvailable()) {
    return res.json({ ...base, available: false, reason: 'The app is not running inside Kubernetes, so there is no cluster API to read.' });
  }

  try {
    const endpointSelector = encodeURIComponent(`kubernetes.io/service-name=${appName}`);
    const [deployment, appPods, proxyPods, slices, events] = await Promise.all([
      kubeRequest('GET', deploymentPath),
      listPods(appName),
      listPods(proxyName),
      kubeRequest('GET', `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices?labelSelector=${endpointSelector}`),
      kubeRequest('GET', `/api/v1/namespaces/${namespace}/events`).catch(() => ({ items: [] }))
    ]);
    const byAge = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

    return res.json({
      ...base,
      available: true,
      deployment: summarizeDeployment(deployment),
      pods: appPods.map(summarizePod).sort(byAge),
      proxyPods: proxyPods.map(summarizePod).sort(byAge),
      endpoints: (slices.items || []).flatMap((slice) => (slice.endpoints || []).map((endpoint) => ({
        ip: endpoint.addresses?.[0] || null,
        pod: endpoint.targetRef?.name || null,
        ready: endpoint.conditions?.ready !== false,
        serving: endpoint.conditions?.serving !== false,
        terminating: endpoint.conditions?.terminating === true
      }))),
      events: summarizeEvents(events)
    });
  } catch (error) {
    return res.json({ ...base, available: false, reason: `Kubernetes API request failed: ${error.message}` });
  }
});

app.post('/api/cluster/delete-pod', requireTestControls, requireKube, handle(async (req, res) => {
  const pods = (await listPods(appName)).filter((pod) => !pod.metadata.deletionTimestamp);
  const requested = req.body?.name;
  const target = requested
    ? pods.find((pod) => pod.metadata.name === requested)
    : pods[Math.floor(Math.random() * pods.length)];
  if (!target) {
    return res.status(404).json({ source: 'app', error: requested ? `No live ${appName} pod named ${requested}` : 'No pod available to delete' });
  }

  await kubeRequest('DELETE', `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(target.metadata.name)}`);
  return res.json({ deleted: target.metadata.name, hostname });
}));

app.post('/api/cluster/scale', requireTestControls, requireKube, handle(async (req, res) => {
  const replicas = Number(req.body?.replicas);
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > maxReplicas) {
    return res.status(400).json({ source: 'app', error: `replicas must be a whole number from 1 to ${maxReplicas}` });
  }

  await kubeRequest('PATCH', `${deploymentPath}/scale`, { spec: { replicas } }, 'application/merge-patch+json');
  return res.json({ replicas, hostname });
}));

app.post('/api/cluster/restart', requireTestControls, requireKube, handle(async (req, res) => {
  const restartedAt = new Date().toISOString();
  const patch = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': restartedAt } } } } };
  await kubeRequest('PATCH', deploymentPath, patch, 'application/strategic-merge-patch+json');
  res.json({ restartedAt, hostname });
}));

app.use('/api', (req, res) => {
  res.status(404).json({ source: 'app', error: `No API route for ${req.method} ${req.originalUrl.split('?')[0]}`, ...identity() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`KubeScale Demo ${appVersion} listening on port ${port} (${hostname})`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing HTTP server`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
