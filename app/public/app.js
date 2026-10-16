const $ = (selector) => document.querySelector(selector);

const requestOnceButton = $('#request-once');
const requestBurstButton = $('#request-burst');
const clearHistoryButton = $('#clear-history');
const latestLabel = $('#latest-label');
const latestHostname = $('#latest-hostname');
const latestTime = $('#latest-time');
const historyList = $('#history-list');
const versionLabel = $('#version');
const footerTime = $('#footer-time');

const POLL_MS = 2000;
const TRAIL_LIMIT = 24;

const state = {
  totalRequests: 0,
  successes: 0,
  nginxErrors: 0,
  appErrors: 0,
  hitsByPod: new Map(),
  nginxUp: null,
  backendUp: null,
  cluster: null,
  clusterUpdatedAt: 0,
  nginxHealth: null
};

// Sends one request through NGINX and normalises the outcome, including who produced it.
async function callApi(path, { method = 'GET', body, record = true } = {}) {
  const url = `${path}${path.includes('?') ? '&' : '?'}t=${Date.now()}`;
  const started = performance.now();
  const result = { path, method, status: 0, ok: false, source: 'network', data: null, text: '', at: new Date() };

  try {
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    result.text = await response.text();
    try { result.data = JSON.parse(result.text); } catch { result.data = null; }
    result.status = response.status;
    result.ok = response.ok;
    // App JSON has no source field unless it is an error; non-JSON bodies come from NGINX (stub_status, default pages).
    result.source = result.data?.source || (result.data ? 'app' : 'nginx');
    result.upstream = response.headers.get('X-Upstream-Addr') || '';
    result.proxy = response.headers.get('X-Proxy-Host') || '';
  } catch {
    result.detail = 'No HTTP response: NGINX is unreachable';
  }

  result.ms = Math.round(performance.now() - started);
  result.hostname = result.data?.hostname || null;
  result.detail ??= result.data?.detail || result.data?.error || null;
  if (record) recordResult(result);
  return result;
}

function describe(result) {
  if (result.status === 0) return 'no response (NGINX unreachable)';
  if (result.source === 'nginx') return `${result.status} from NGINX`;
  return `${result.status} from ${result.hostname || 'the app'}`;
}

function outcomeClass(result) {
  if (result.status === 0) return 'is-network';
  if (result.ok) return 'is-ok';
  return result.source === 'nginx' ? 'is-nginx-error' : 'is-app-error';
}

function recordResult(result) {
  state.totalRequests += 1;
  if (result.ok) state.successes += 1;
  else if (result.source === 'nginx' || result.status === 0) state.nginxErrors += 1;
  else state.appErrors += 1;
  if (result.hostname && result.source === 'app') {
    state.hitsByPod.set(result.hostname, (state.hitsByPod.get(result.hostname) || 0) + 1);
  }
  if (result.data?.version) versionLabel.textContent = `Version ${result.data.version}`;

  renderLatest(result);
  renderMetrics();
  addTrailItem(result);
  if (state.cluster) renderPods(state.cluster);
}

function renderLatest(result) {
  latestHostname.className = outcomeClass(result);
  if (result.ok && result.hostname) {
    latestLabel.textContent = 'LATEST BACKEND';
    latestHostname.textContent = result.hostname;
    const podIp = result.data.podIp ? ` · pod ${result.data.podIp}` : '';
    latestTime.textContent = `${result.at.toLocaleTimeString()} · ${result.ms} ms${podIp} · via Service ${result.upstream || '?'}`;
  } else {
    latestLabel.textContent = result.ok ? 'LATEST RESPONSE' : 'LATEST FAILURE';
    latestHostname.textContent = describe(result);
    latestTime.textContent = result.detail || `${result.method} ${result.path}`;
  }
}

function renderMetrics() {
  $('#request-count').textContent = state.totalRequests;
  $('#backend-count').textContent = state.hitsByPod.size;
  $('#success-count').textContent = state.successes;
  $('#error-split').textContent = `${state.nginxErrors} / ${state.appErrors}`;
}

function addTrailItem(result) {
  const item = document.createElement('li');
  item.className = outcomeClass(result);
  const top = document.createElement('span');
  top.className = 'trail-top';
  const status = document.createElement('b');
  status.textContent = result.status || '—';
  const source = document.createElement('span');
  source.className = 'trail-source';
  source.textContent = result.status === 0 ? 'network' : result.source;
  top.append(status, source);
  const host = document.createElement('span');
  host.className = 'event-host';
  host.textContent = result.source === 'app' && result.hostname ? result.hostname : (result.detail || describe(result));
  const meta = document.createElement('span');
  meta.className = 'event-time';
  meta.textContent = `${result.method} ${result.path.split('?')[0]} · ${result.ms} ms · ${result.at.toLocaleTimeString()}`;
  item.append(top, host, meta);
  historyList.querySelector('.empty-state')?.remove();
  historyList.prepend(item);
  while (historyList.children.length > TRAIL_LIMIT) historyList.lastElementChild.remove();
}

function age(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp)) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function podTone(pod) {
  if (pod.terminating) return 'terminating';
  if (/BackOff|Err|Error|OOMKilled|Invalid/i.test(pod.status)) return 'failing';
  if (pod.phase === 'Pending' || pod.status === 'ContainerCreating') return 'starting';
  return pod.ready ? 'ready' : 'unready';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- Gateway diagnosis -------------------------------------------------

function renderGateway() {
  const cluster = state.cluster;
  const deployment = cluster?.available ? cluster.deployment : null;
  let level = 'checking';
  let title = 'Checking the gateway…';
  let detail = 'Polling NGINX and the cluster every two seconds.';

  if (state.nginxUp === false) {
    level = 'down';
    title = 'NGINX unreachable';
    detail = 'The browser got no HTTP response. The NGINX pod or its NodePort Service is not available, so nothing behind it can be reached either.';
  } else if (state.backendUp === false) {
    level = 'down';
    title = 'NGINX is up, but no app pod answered';
    detail = 'NGINX returned a gateway error: the kubescale-app Service has no ready endpoints. Kubernetes will route traffic again as soon as a pod passes readiness.';
  } else if (deployment && (deployment.ready < deployment.desired || !deployment.converged)) {
    level = 'warn';
    title = deployment.ready < deployment.desired ? 'Serving with reduced capacity' : 'Rollout in progress';
    detail = `${deployment.ready} of ${deployment.desired} desired replicas are ready. The Service only sends traffic to ready pods, so requests still succeed.`;
  } else if (state.nginxUp && state.backendUp) {
    level = 'ok';
    title = 'Healthy';
    detail = deployment
      ? `NGINX is forwarding traffic and all ${deployment.desired} desired replicas are ready.`
      : 'NGINX is forwarding traffic to the app.';
  }

  $('#diagnosis').className = `diagnosis is-${level}`;
  $('#diagnosis-title').textContent = title;
  $('#diagnosis-detail').textContent = detail;
  $('#live-indicator').className = `live-indicator is-${level}`;
  $('#connection-status').textContent = {
    ok: 'Connected through NGINX', warn: 'Degraded', down: title, checking: 'Checking gateway...'
  }[level];

  $('#health-icon').textContent = { ok: '✓', warn: '!', down: '×', checking: '…' }[level];
  $('#health-icon').className = `health-icon is-${level}`;
  $('#health-title').textContent = title;
  $('#health-detail').textContent = state.nginxUp === false ? 'Browser → NGINX failed'
    : state.backendUp === false ? 'NGINX → Service failed' : 'Browser → NGINX → Service → pod';
  $('#health-status').textContent = { ok: 'OK', warn: 'DEGRADED', down: 'DOWN', checking: '--' }[level];
  $('#health-status').className = `health-pill is-${level}`;

  const nginxState = $('#nginx-state');
  nginxState.textContent = state.nginxUp === false ? 'UNREACHABLE' : state.nginxUp ? 'ONLINE' : 'CHECKING';
  nginxState.className = `node-state is-${state.nginxUp === false ? 'down' : state.nginxUp ? 'ok' : 'checking'}`;
  if (state.nginxHealth?.proxy) $('#nginx-detail').textContent = `pod ${state.nginxHealth.proxy} · :30080`;
}

// ---- Cluster view ------------------------------------------------------

function renderCluster(cluster) {
  const unavailable = $('#cluster-unavailable');
  updateControls(cluster);

  if (!cluster.available) {
    unavailable.hidden = false;
    unavailable.textContent = `Cluster view unavailable: ${cluster.reason} Request results still work; the pod list, endpoints and events need the Kubernetes API.`;
    $('#cluster-body').classList.add('is-stale');
    $('#replica-count').textContent = '?';
    $('#replica-detail').textContent = 'No cluster API';
    return;
  }

  unavailable.hidden = true;
  $('#cluster-body').classList.remove('is-stale');
  const { deployment, pods, endpoints } = cluster;

  $('#hero-ready').textContent = String(deployment.ready).padStart(2, '0');
  $('#replica-count').textContent = `${deployment.ready}/${deployment.desired}`;
  $('#replica-detail').textContent = `${pods.length} pod${pods.length === 1 ? '' : 's'} exist · ${deployment.desired} desired`;

  const dots = $('#replica-dots');
  dots.replaceChildren(...pods.map((pod) => {
    const dot = el('i', `dot-${podTone(pod)}`);
    dot.title = `${pod.name}\n${pod.status}${pod.ready ? ' · ready' : ' · not ready'} · restarts ${pod.restarts}`;
    return dot;
  }));

  const readyEndpoints = endpoints.filter((endpoint) => endpoint.ready).length;
  $('#service-detail').textContent = `${readyEndpoints} ready / ${endpoints.length} endpoints`;
  const serviceState = $('#service-state');
  serviceState.textContent = readyEndpoints === 0 ? 'NO ENDPOINTS' : `${readyEndpoints} ROUTES`;
  serviceState.className = `node-state is-${readyEndpoints === 0 ? 'down' : readyEndpoints < endpoints.length ? 'warn' : 'ok'}`;

  $('#dep-desired').textContent = deployment.desired;
  $('#dep-ready').textContent = deployment.ready;
  $('#dep-updated').textContent = deployment.updated;
  $('#dep-available').textContent = deployment.available;
  const progressing = deployment.conditions.find((c) => c.type === 'Progressing');
  $('#dep-rollout').textContent = deployment.converged
    ? `Rollout complete. Strategy: RollingUpdate (maxSurge ${deployment.maxSurge}, maxUnavailable ${deployment.maxUnavailable}).`
    : `Converging: ${deployment.current} pods exist, ${deployment.updated} updated, ${deployment.available} available. ${progressing?.message || ''}`;

  const proxyPod = cluster.proxyPods[0];
  if (proxyPod) $('#nginx-pod').textContent = `${proxyPod.name} · ${proxyPod.ready ? 'ready' : proxyPod.status}`;

  const scaleInput = document.querySelector('[data-input="replicas"]');
  if (document.activeElement !== scaleInput) scaleInput.value = deployment.desired;
  scaleInput.max = cluster.maxReplicas;

  renderPods(cluster);
  renderEndpoints(endpoints);
  renderEvents(cluster.events);
}

function renderPods(cluster) {
  if (!cluster.available) return;
  const rows = cluster.pods.map((pod) => {
    const tone = podTone(pod);
    const row = el('div', `pod-row tone-${tone}`);
    row.setAttribute('role', 'row');
    const name = el('span', 'pod-name', pod.name);
    if (pod.self) name.append(el('small', '', ' answered this poll'));
    const status = el('span', '', '');
    status.append(el('span', `pill tone-${tone}`, pod.status));
    const restarts = el('span', '', String(pod.restarts));
    if (pod.lastExit) restarts.append(el('small', '', ` last: ${pod.lastExit}`));
    const action = el('span', 'pod-action');
    if (!pod.terminating && cluster.testControls) {
      const button = el('button', 'text-button danger', 'Delete');
      button.type = 'button';
      button.addEventListener('click', () => deletePod(pod.name, button));
      action.append(button);
    }
    row.append(
      name,
      status,
      el('span', pod.ready ? 'yes' : 'no', pod.ready ? 'Yes' : 'No'),
      restarts,
      el('span', 'mono', pod.ip || '—'),
      el('span', '', age(pod.createdAt)),
      el('span', '', String(state.hitsByPod.get(pod.name) || 0)),
      action
    );
    [...row.children].forEach((cell, index) => {
      cell.setAttribute('role', 'cell');
      cell.dataset.label = ['Pod', 'Status', 'Ready', 'Restarts', 'Pod IP', 'Age', 'Your hits', ''][index];
    });
    return row;
  });
  $('#pod-rows').replaceChildren(...(rows.length ? rows : [el('p', 'muted', 'No application pods exist. The Deployment may be scaled to zero.')]));
}

function renderEndpoints(endpoints) {
  const list = $('#endpoint-list');
  if (!endpoints.length) {
    list.replaceChildren(el('li', 'tone-failing', 'No endpoints. Every request to the Service is refused, and NGINX turns that into 502.'));
    return;
  }
  list.replaceChildren(...endpoints.map((endpoint) => {
    const label = endpoint.terminating ? 'terminating' : endpoint.ready ? 'ready' : 'not ready';
    const tone = endpoint.terminating ? 'terminating' : endpoint.ready ? 'ready' : 'unready';
    const item = el('li', '');
    item.append(el('span', `pill tone-${tone}`, label), el('span', 'mono', ` ${endpoint.ip}:3000 `), el('small', 'muted', endpoint.pod || ''));
    return item;
  }));
}

function renderEvents(events) {
  const list = $('#event-list');
  if (!events.length) {
    list.replaceChildren(el('li', 'muted', 'No recent events for kubescale resources.'));
    return;
  }
  list.replaceChildren(...events.map((event) => {
    const item = el('li', event.type === 'Warning' ? 'is-warning' : '');
    const head = el('span', 'event-head');
    head.append(el('b', '', event.reason), el('small', 'muted', ` ${event.object} · ${age(event.time)} ago${event.count > 1 ? ` · ×${event.count}` : ''}`));
    item.append(head, el('span', 'event-message', event.message));
    return item;
  }));
}

function updateControls(cluster) {
  const clusterReady = cluster.available && cluster.testControls;
  document.querySelectorAll('[data-needs="controls"]').forEach((button) => { button.disabled = !cluster.testControls; });
  document.querySelectorAll('[data-needs="cluster"]').forEach((button) => { button.disabled = !clusterReady; });
  const note = $('#controls-note');
  if (!cluster.testControls) {
    note.hidden = false;
    note.textContent = 'Kubernetes test controls are disabled (ENABLE_TEST_CONTROLS is not "true"). NGINX cases still work.';
  } else if (!cluster.available) {
    note.hidden = false;
    note.textContent = 'The cluster API is unavailable, so scaling, pod deletion, rollouts and the outage case are disabled.';
  } else {
    note.hidden = true;
  }
}

// ---- Background polling ------------------------------------------------

async function poll() {
  const [health, cluster, status] = await Promise.all([
    callApi('/nginx-health', { record: false }),
    callApi('/api/cluster', { record: false }),
    callApi('/nginx-status', { record: false })
  ]);

  state.nginxUp = health.status === 200;
  state.nginxHealth = health.data;
  if (cluster.ok && cluster.data) {
    state.backendUp = true;
    state.cluster = cluster.data;
    state.clusterUpdatedAt = Date.now();
    renderCluster(cluster.data);
    if (cluster.data.servedBy?.version) versionLabel.textContent = `Version ${cluster.data.servedBy.version}`;
  } else if (cluster.status !== 0) {
    state.backendUp = false;
  }
  renderFreshness(cluster);
  renderNginxStatus(status);
  renderGateway();
  setTimeout(poll, POLL_MS);
}

function renderFreshness(cluster) {
  const label = $('#cluster-freshness');
  const body = $('#cluster-body');
  if (cluster.ok) {
    label.textContent = `live · updated ${new Date().toLocaleTimeString()}`;
    return;
  }
  body.classList.add('is-stale');
  const since = state.clusterUpdatedAt ? `last good data ${age(state.clusterUpdatedAt)} ago` : 'no data yet';
  label.textContent = cluster.status === 0
    ? `stale · NGINX unreachable · ${since}`
    : `stale · ${cluster.status} from ${cluster.source}: no app pod could answer · ${since}`;
}

function renderNginxStatus(result) {
  // stub_status format: "Active connections: N \nserver accepts handled requests\n A H R \nReading: x Writing: y Waiting: z"
  const numbers = result.ok ? result.text.match(/\d+/g)?.map(Number) : null;
  const [active, , , requests, , writing, waiting] = numbers || [];
  $('#ngx-active').textContent = active ?? '-';
  $('#ngx-requests').textContent = requests ?? '-';
  $('#ngx-writing').textContent = writing ?? '-';
  $('#ngx-waiting').textContent = waiting ?? '-';
}

// ---- Scenario lab ------------------------------------------------------

function setResult(card, text, tone = 'ok') {
  const result = card.querySelector('[data-result]');
  result.textContent = text;
  result.className = `case-result is-${tone}`;
}

function tally(results) {
  const counts = new Map();
  results.forEach((r) => {
    const key = r.status === 0 ? 'no response' : `${r.status} ${r.source === 'nginx' ? 'NGINX' : 'app'}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts].map(([key, count]) => `${count}× ${key}`).join(' · ');
}

function distinctPods(results) {
  return new Set(results.filter((r) => r.ok && r.hostname).map((r) => r.hostname));
}

async function sequential(count, path) {
  const results = [];
  for (let i = 0; i < count; i += 1) results.push(await callApi(path));
  return results;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const actions = {
  async balance(card) {
    const results = await Promise.all(Array.from({ length: 10 }, () => callApi('/api/info')));
    const pods = distinctPods(results);
    const perPod = [...pods].map((pod) => `${pod.slice(-5)}×${results.filter((r) => r.hostname === pod).length}`).join(', ');
    setResult(card, `${tally(results)}. Reached ${pods.size} pod${pods.size === 1 ? '' : 's'} (${perPod || 'none'}). The split is random, not strict round robin.`, pods.size > 1 ? 'ok' : 'warn');
  },

  async keepalive(card) {
    const fresh = distinctPods(await sequential(8, '/api/info'));
    const reused = distinctPods(await sequential(8, '/api/keepalive/info'));
    setResult(card, `New connection per request: ${fresh.size} pod${fresh.size === 1 ? '' : 's'} · reused connection: ${reused.size} pod${reused.size === 1 ? '' : 's'}. Kubernetes balances connections, not individual requests.`, 'ok');
  },

  async upstreamError(card) {
    const code = card.querySelector('[data-input="status"]').value;
    const result = await callApi(`/api/simulate-error?status=${code}`);
    setResult(card, `${describe(result)}. Source "${result.source}": NGINX passed the app's response through instead of replacing it.`, result.source === 'app' ? 'warn' : 'err');
  },

  async delay(card, button) {
    const ms = Number(button.dataset.ms);
    const result = await callApi(`/api/simulate-delay?ms=${ms}`);
    setResult(card, result.ok
      ? `${describe(result)} after ${result.ms} ms, inside NGINX's 5 s limit.`
      : `${describe(result)} after ${result.ms} ms. ${result.detail || ''}`, result.ok ? 'ok' : 'err');
  },

  async rateLimit(card) {
    const results = await Promise.all(Array.from({ length: 15 }, () => callApi('/api/limited')));
    const limited = results.filter((r) => r.status === 429).length;
    setResult(card, `${tally(results)}. ${limited} request${limited === 1 ? ' was' : 's were'} rejected by NGINX and never reached Kubernetes.`, limited ? 'warn' : 'ok');
  },

  async nginxLocal(card) {
    const result = await callApi('/nginx-health');
    setResult(card, `${describe(result)} (pod ${result.data?.proxy || '?'}). Upstream address: "${result.upstream || 'none'}", so no app pod was involved.`, result.ok ? 'ok' : 'err');
  },

  async appMissing(card) {
    const result = await callApi('/api/does-not-exist');
    setResult(card, `${describe(result)}. NGINX forwarded the request, and the app said the route does not exist.`, 'warn');
  },

  async outage(card) {
    const timeline = card.querySelector('[data-timeline]');
    timeline.replaceChildren();
    const start = await callApi('/api/test/outage?seconds=20', { method: 'POST' });
    if (!start.ok) return setResult(card, `Could not start: ${describe(start)} ${start.detail || ''}`, 'err');
    const affected = start.data.results.filter((r) => r.status === 200).length;
    setResult(card, `${affected} pod${affected === 1 ? '' : 's'} now fail readiness. Probing once a second for 45 s…`, 'warn');

    let failures = 0;
    let firstFailure = null;
    let recoveredAt = null;
    const begun = Date.now();
    for (let second = 0; second < 45; second += 1) {
      const result = await callApi('/api/info', { record: false });
      const tick = el('i', outcomeClass(result));
      tick.title = `${second}s: ${describe(result)}`;
      timeline.append(tick);
      if (!result.ok) {
        failures += 1;
        firstFailure ??= second;
        recoveredAt = null;
      } else if (firstFailure !== null && recoveredAt === null) {
        recoveredAt = Math.round((Date.now() - begun) / 1000);
      }
      await wait(Math.max(0, begun + (second + 1) * 1000 - Date.now()));
    }
    setResult(card, failures
      ? `${failures} probes got 502 from NGINX (first after ${firstFailure}s). ${recoveredAt ? `Traffic recovered on its own at ~${recoveredAt}s, once readiness probes passed again.` : 'Not recovered yet; watch the cluster view.'}`
      : 'No failures observed. Endpoint removal takes one or two readiness periods; try again or check the events list.', failures ? 'warn' : 'ok');
  },

  async unready(card) {
    const result = await callApi('/api/test/unready?seconds=30', { method: 'POST' });
    setResult(card, result.ok
      ? `${result.hostname} fails readiness for 30 s. Within ~10 s its dot turns amber and its endpoint goes "not ready"; your requests land on the other pods.`
      : `${describe(result)}: ${result.detail || ''}`, result.ok ? 'warn' : 'err');
  },

  async crash(card) {
    const result = await callApi('/api/test/crash', { method: 'POST' });
    setResult(card, result.ok
      ? `${result.hostname} exited with code 1. Watch its RESTARTS count go up while the pod name stays the same. Repeated crashes lead to CrashLoopBackOff.`
      : `${describe(result)}: ${result.detail || ''}`, result.ok ? 'warn' : 'err');
  },

  async liveness(card) {
    const result = await callApi('/api/test/break-liveness', { method: 'POST' });
    setResult(card, result.ok
      ? `${result.hostname} still serves requests, but its liveness probe now fails. Look for "Unhealthy" events, then a restart in about 30 s.`
      : `${describe(result)}: ${result.detail || ''}`, result.ok ? 'warn' : 'err');
  },

  async deletePod(card) {
    const result = await callApi('/api/cluster/delete-pod', { method: 'POST', body: {} });
    setResult(card, result.ok
      ? `Deleted ${result.data.deleted}. It shows as Terminating while a replacement with a new name is created.`
      : `${describe(result)}: ${result.detail || ''}`, result.ok ? 'warn' : 'err');
  },

  async scale(card) {
    const replicas = Number(card.querySelector('[data-input="replicas"]').value);
    const result = await callApi('/api/cluster/scale', { method: 'POST', body: { replicas } });
    setResult(card, result.ok
      ? `Desired replicas set to ${replicas}. New pods appear as starting and join the Service once ready.`
      : `${describe(result)}: ${result.detail || ''}`, result.ok ? 'ok' : 'err');
  },

  async restart(card) {
    const result = await callApi('/api/cluster/restart', { method: 'POST' });
    if (!result.ok) return setResult(card, `${describe(result)}: ${result.detail || ''}`, 'err');
    setResult(card, 'Rollout started. Sending a request every 500 ms for 25 s…', 'warn');
    const results = [];
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      results.push(await callApi('/api/info', { record: false }));
      await wait(500);
    }
    const failed = results.filter((r) => !r.ok).length;
    setResult(card, `During the rollout: ${tally(results)}. ${failed ? `${failed} request${failed === 1 ? '' : 's'} failed.` : 'No request failed: the rolling update kept ready pods serving throughout.'}`, failed ? 'warn' : 'ok');
  }
};

async function deletePod(name, button) {
  button.disabled = true;
  const result = await callApi('/api/cluster/delete-pod', { method: 'POST', body: { name } });
  if (!result.ok) button.disabled = false;
}

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const card = button.closest('.case');
    const buttons = card.querySelectorAll('button');
    buttons.forEach((b) => { b.dataset.wasDisabled = b.disabled; b.disabled = true; });
    card.classList.add('is-running');
    setResult(card, 'Running…', 'pending');
    try {
      await actions[button.dataset.action](card, button);
    } catch (error) {
      setResult(card, `Unexpected error: ${error.message}`, 'err');
    } finally {
      card.classList.remove('is-running');
      buttons.forEach((b) => { b.disabled = b.dataset.wasDisabled === 'true'; });
      if (state.cluster) updateControls(state.cluster);
    }
  });
});

// ---- Traffic console ---------------------------------------------------

requestOnceButton.addEventListener('click', () => callApi('/api/info'));
requestBurstButton.addEventListener('click', async () => {
  requestBurstButton.disabled = true;
  await Promise.all(Array.from({ length: 10 }, () => callApi('/api/info')));
  requestBurstButton.disabled = false;
});
clearHistoryButton.addEventListener('click', () => {
  historyList.innerHTML = '<li class="empty-state">History cleared. Run a request to continue.</li>';
});
setInterval(() => { footerTime.textContent = new Date().toLocaleTimeString(); }, 1000);

poll();
