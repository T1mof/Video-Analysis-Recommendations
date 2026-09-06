/**
 * Demo UI.
 *
 * A plain client of the ordinary API. It calls `GET /feed`, `POST /interactions` and
 * `GET /users/:id/profile` exactly as any client would, and one demo-only endpoint,
 * `GET /demo/api/feed-debug`, for the explanation the feed payload deliberately does
 * not carry.
 *
 * No framework and no build step on purpose: the interesting part of this project is
 * behind the API, and a toolchain here would be one more thing for a reviewer to
 * install before seeing any of it.
 *
 * The lifecycle it is built to make visible:
 *
 *   interaction -> feed invalidated -> 202 building -> worker publishes -> new feedId
 *
 * A UI that hid the 202 behind a spinner would hide the entire point of M7.
 */

/**
 * Fixed UUIDs from `scripts/seed-users.ts`, which is the source of truth. If they
 * ever drift, the profile fetch 404s and the page says so rather than showing an
 * empty panel.
 */
const USERS = [
  { id: '11111111-1111-4111-8111-111111111111', label: 'demo_alice', note: 'warm' },
  { id: '22222222-2222-4222-8222-222222222222', label: 'demo_bob', note: 'warm, opposite taste' },
  { id: '33333333-3333-4333-8333-333333333333', label: 'demo_carol', note: 'cold start' },
];

const PAGE_SIZE = 6;
const POLL_INTERVAL_MS = 700;
const POLL_MAX_ATTEMPTS = 15;
/** After this many fruitless polls the likeliest cause is a worker that is not running. */
const POLL_WARN_AFTER = 6;

const state = {
  user: null,
  feedId: null,
  cursor: null,
  items: [],
  /** Explanation sidecars, keyed by feedId: one fetch explains the whole generation. */
  debug: new Map(),
  /** True when the server reports the sidecar is switched off, not merely missing. */
  sidecarDisabled: false,
  polling: false,
};

const el = {
  users: document.getElementById('users'),
  profile: document.getElementById('profile'),
  log: document.getElementById('log'),
  feed: document.getElementById('feed'),
  feedMeta: document.getElementById('feed-meta'),
  diagnostics: document.getElementById('build-diagnostics'),
  status: document.getElementById('feed-status'),
  loadMore: document.getElementById('load-more'),
  restart: document.getElementById('restart'),
  workerWarning: document.getElementById('worker-warning'),
};

// ---------------------------------------------------------------- small helpers

const num = (value, digits = 3) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function log(message, kind) {
  const item = node('li', kind, `${new Date().toLocaleTimeString()}  ${message}`);
  el.log.prepend(item);
  while (el.log.children.length > 60) el.log.lastChild.remove();
}

function showStatus(message, kind) {
  el.status.hidden = false;
  el.status.className = `status ${kind ?? ''}`.trim();
  el.status.textContent = message;
}

function clearStatus() {
  el.status.hidden = true;
  el.status.textContent = '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every response is inspected by status code - none of them is an exception here. */
async function call(url, options) {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // A body-less response is still a result; the status is what matters.
  }
  return { status: response.status, body };
}

// ------------------------------------------------------------------ user picker

function renderUsers() {
  el.users.replaceChildren();
  for (const user of USERS) {
    const button = node('button', 'btn');
    button.append(node('span', null, user.label));
    button.append(node('span', 'hint', ` ${user.note}`));
    if (state.user && state.user.id === user.id) button.classList.add('active');
    button.addEventListener('click', () => void selectUser(user));
    el.users.append(button);
  }
}

async function selectUser(user) {
  state.user = user;
  renderUsers();
  log(`switched to ${user.label}`);
  await loadProfile();
  await restartSession('user switched');
}

// ---------------------------------------------------------------- profile panel

async function loadProfile() {
  const { status, body } = await call(`/users/${state.user.id}/profile?top=6`);

  if (status === 404) {
    el.profile.replaceChildren(
      node('p', 'muted', 'No profile yet. Run `npm run demo:reset` to seed the scenario.'),
    );
    return;
  }
  if (status !== 200) {
    el.profile.replaceChildren(node('p', 'muted', `profile unavailable (${status})`));
    return;
  }

  const container = document.createDocumentFragment();

  const badge = node(
    'span',
    `pill ${body.isColdStart ? 'cold' : 'warm'}`,
    body.isColdStart ? 'cold start' : 'warm',
  );
  const head = node('div');
  head.append(badge);
  container.append(head);

  const kv = node('dl', 'kv');
  const rows = [
    ['user id', body.userId],
    ['interactions', String(body.interactionCount)],
    ['effective signals', String(body.effectiveSignalCount)],
    ['signal mass', `+${num(body.positiveSignal, 2)} / -${num(body.negativeSignal, 2)}`],
  ];
  if (body.skippedNoFeatures > 0) {
    rows.push(['skipped (no features)', String(body.skippedNoFeatures)]);
  }
  for (const [key, value] of rows) {
    kv.append(node('dt', null, key));
    kv.append(node('dd', 'mono', value));
  }
  container.append(kv);

  container.append(...preferenceBlock('likes', body.topPositivePreferences, 'pos'));
  container.append(...preferenceBlock('dislikes', body.topNegativePreferences, 'neg'));
  container.append(...creatorBlock(body.creatorAffinity));

  // The 110-dimension vector is available at ?vector=true and deliberately not shown:
  // it is not readable, and the named contributions above are what it decomposes into.
  el.profile.replaceChildren(container);
}

function preferenceBlock(title, terms, tone) {
  const out = [node('div', 'subhead', title)];
  if (!terms || terms.length === 0) {
    out.push(node('p', 'muted', 'none yet'));
    return out;
  }
  for (const term of terms) {
    const line = node('div', 'tag-line');
    line.append(node('span', 'mono', term.dimension));
    line.append(node('span', `v mono ${tone}`, num(term.contribution)));
    out.push(line);
  }
  return out;
}

function creatorBlock(creators) {
  const out = [node('div', 'subhead', 'creator affinity')];
  if (!creators || creators.length === 0) {
    out.push(node('p', 'muted', 'none yet'));
    return out;
  }
  for (const creator of creators) {
    const line = node('div', 'tag-line');
    line.append(node('span', 'mono', creator.creatorHandle ?? creator.creatorId));
    line.append(node('span', `v mono ${creator.score >= 0 ? 'pos' : 'neg'}`, num(creator.score)));
    out.push(line);
  }
  return out;
}

// ------------------------------------------------------------------------- feed

async function restartSession(reason) {
  state.feedId = null;
  state.cursor = null;
  state.items = [];
  el.feed.replaceChildren();
  el.loadMore.hidden = true;
  el.diagnostics.hidden = true;
  el.feedMeta.textContent = 'requesting…';
  if (reason) log(`new feed session (${reason})`);
  await loadPage(null);
}

/**
 * One page of the feed.
 *
 * Every status code the API can answer with is handled explicitly, because each one
 * means something different to a client and collapsing them into "error" would throw
 * away the design. 202 in particular is not a failure - it is the API declining to
 * compute a feed on the request path.
 */
async function loadPage(cursor) {
  const query = new URLSearchParams({ userId: state.user.id, limit: String(PAGE_SIZE) });
  if (cursor) query.set('cursor', cursor);

  const { status, body } = await call(`/feed?${query.toString()}`);

  if (status === 200) {
    clearStatus();
    el.workerWarning.hidden = true;
    applyPage(body, Boolean(cursor));
    log(`200 feed ${body.feedId.slice(0, 8)} +${body.items.length} item(s)`, 'ok');
    return;
  }

  if (status === 202) {
    showStatus('Building recommendations…  (the API queued a job; it did not rank anything)', 'building');
    log('202 building - queued, not computed');
    await pollUntilReady();
    return;
  }

  if (status === 404) {
    showStatus('Unknown user. Run `npm run demo:reset` to seed the demo users.', 'error');
    log('404 unknown user', 'err');
    return;
  }

  if (status === 410) {
    // The cursor was valid and its generation aged out. Starting over is the
    // documented client behaviour, not an error to show the user.
    log('410 cursor expired - starting a new session', 'err');
    showStatus('That generation expired. Started a new session.', '');
    await restartSession('410 expired');
    return;
  }

  if (status === 400) {
    log(`400 ${body?.error ?? 'bad request'} - restarting session`, 'err');
    if (cursor) {
      await restartSession('400 bad cursor');
      return;
    }
    showStatus(`Bad request: ${body?.error ?? 'unknown'}`, 'error');
    return;
  }

  if (status === 503) {
    showStatus(
      'Feed cache unavailable (503). The API refuses to rank inline during a Redis outage — ' +
        'that is deliberate: it would turn a cache failure into a database stampede.',
      'error',
    );
    log('503 feed cache unavailable', 'err');
    return;
  }

  showStatus(`Unexpected status ${status}`, 'error');
  log(`${status} unexpected`, 'err');
}

/**
 * Waits for a background build, with a bounded number of attempts.
 *
 * Bounded rather than indefinite: if the feed worker is not running, nothing will
 * ever publish, and a page that polls forever would present an operator mistake as a
 * slow system. After a few attempts it says which command is missing.
 */
async function pollUntilReady() {
  if (state.polling) return;
  state.polling = true;

  try {
    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);

      const query = new URLSearchParams({ userId: state.user.id, limit: String(PAGE_SIZE) });
      const { status, body } = await call(`/feed?${query.toString()}`);

      if (status === 200) {
        clearStatus();
        el.workerWarning.hidden = true;
        applyPage(body, false);
        log(`200 feed ${body.feedId.slice(0, 8)} after ${attempt} poll(s)`, 'ok');
        return;
      }

      if (status !== 202) {
        showStatus(`Build stopped with status ${status}`, 'error');
        log(`${status} while polling`, 'err');
        return;
      }

      if (attempt === POLL_WARN_AFTER) el.workerWarning.hidden = false;
      showStatus(`Building recommendations…  (poll ${attempt}/${POLL_MAX_ATTEMPTS})`, 'building');
    }

    showStatus(
      'Still building after ' +
        POLL_MAX_ATTEMPTS +
        ' attempts. Nothing is draining the queue — start the feed worker: npm run worker:feed',
      'error',
    );
    log('gave up polling - feed worker probably not running', 'err');
  } finally {
    state.polling = false;
  }
}

function applyPage(page, append) {
  const generationChanged = state.feedId !== page.feedId;
  if (generationChanged && state.feedId) {
    log(`generation replaced: ${state.feedId.slice(0, 8)} -> ${page.feedId.slice(0, 8)}`, 'ok');
  }

  state.feedId = page.feedId;
  state.cursor = page.nextCursor;
  state.items = append && !generationChanged ? state.items.concat(page.items) : page.items;

  el.feedMeta.textContent =
    `feedId ${page.feedId}  ·  built ${new Date(page.generatedAt).toLocaleTimeString()}` +
    `  ·  ${page.coldStart ? 'cold-start feed' : 'personalised'}  ·  ${state.items.length} shown`;

  el.loadMore.hidden = !page.hasMore;

  void ensureDebug(page.feedId).then(() => render());
}

// ------------------------------------------------------- explanation (demo only)

/**
 * Fetches the explanation sidecar for a generation, once.
 *
 * One Redis read explains every item of the whole generation, so paging does not
 * re-fetch it. It is absent for a generation built before the sidecar existed, or if
 * its write failed - in which case the cards render without explanations rather than
 * the page reporting a fault.
 */
async function ensureDebug(feedId) {
  if (state.debug.has(feedId)) return;

  const query = new URLSearchParams({ userId: state.user.id, feedId });
  const { status, body } = await call(`/demo/api/feed-debug?${query.toString()}`);

  if (status === 200 && body.available) {
    state.debug.set(feedId, body);
    state.sidecarDisabled = false;
    log(`explanation loaded for ${feedId.slice(0, 8)} (1 Redis read, no ranking)`);
    return;
  }

  state.debug.set(feedId, null);

  // Disabled and absent are different facts. The sidecar is off by default because
  // it costs ~17x the served payload per item; saying so is more useful than an
  // unexplained blank panel.
  state.sidecarDisabled = body?.error === 'debug_sidecar_disabled';
  log(
    state.sidecarDisabled
      ? 'explanations disabled (FEED_DEBUG_SIDECAR=false)'
      : `no explanation sidecar for ${feedId.slice(0, 8)} (${status})`,
  );
}

function renderDiagnostics(debug) {
  if (!debug) {
    el.diagnostics.hidden = true;
    return;
  }
  el.diagnostics.replaceChildren();
  el.diagnostics.hidden = false;

  const counts = debug.candidateCounts ?? {};
  const parts = [
    `sources: ${Object.entries(counts)
      .map(([source, n]) => `${source} ${n}`)
      .join('  ')}`,
    `unique ${debug.uniqueCandidates}`,
    `eligible ${debug.eligibleVideos}`,
    `filtered seen ${debug.filteredSeen}`,
    `build ${debug.buildLatencyMs} ms`,
  ];
  if (debug.candidateShortage) parts.push('candidate shortage');
  if (debug.diversityRelaxed) parts.push(`diversity relaxed (${debug.relaxedCount})`);

  for (const part of parts) el.diagnostics.append(node('span', null, part));
}

// --------------------------------------------------------------------- rendering

function render() {
  const debug = state.debug.get(state.feedId) ?? null;
  renderDiagnostics(debug);

  const byVideo = new Map((debug?.items ?? []).map((item) => [item.videoId, item]));
  el.feed.replaceChildren(...state.items.map((item) => card(item, byVideo.get(item.videoId))));
}

function card(item, detail) {
  const root = node('article', 'card');
  root.append(thumb(item, detail));

  const body = node('div', 'card-body');

  const head = node('div', 'card-head');
  head.append(node('span', 'rank', `#${item.rank}`));
  head.append(node('span', 'mono', detail?.externalId ?? item.videoId.slice(0, 8)));
  head.append(node('span', 'creator', detail?.creatorHandle ?? item.creatorId ?? 'no creator'));
  if (detail) head.append(node('span', 'score mono', `score ${num(detail.finalScore)}`));
  body.append(head);

  if (detail?.sources?.length) {
    const sources = node('div', 'sources');
    for (const source of detail.sources) sources.append(node('span', 'pill src', source));
    body.append(sources);
  }

  if (detail?.tags?.length) {
    const tags = node('div', 'tags');
    for (const tag of detail.tags.slice(0, 8)) tags.append(node('span', 'pill', tag));
    body.append(tags);
  }

  body.append(actions(item));
  if (detail) {
    body.append(why(detail));
  } else {
    body.append(
      node(
        'p',
        'unavailable',
        state.sidecarDisabled
          ? 'explanations unavailable — FEED_DEBUG_SIDECAR is off (set it to true and rebuild the feed)'
          : 'no explanation sidecar for this generation',
      ),
    );
  }

  root.append(body);
  return root;
}

/**
 * Poster first, video on demand.
 *
 * Both URLs are presigned object-storage links: the API hands out a URL and the
 * browser fetches bytes from storage directly. That is the same property the 3k RPS
 * design rests on - no video byte ever passes through the Node process. If the corpus
 * is absent the image simply fails to load and the card falls back to metadata, which
 * is why the demo still works on a clone with no media.
 */
function thumb(item, detail) {
  const box = node('div', 'thumb');
  const fallback = () => {
    box.replaceChildren(node('span', 'placeholder', 'no media\n(metadata only)'));
    box.style.cursor = 'default';
  };

  if (!detail?.posterUrl) {
    fallback();
    return box;
  }

  const image = document.createElement('img');
  image.src = detail.posterUrl;
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', fallback);
  box.append(image);

  if (detail.mediaUrl) {
    box.title = 'click to play';
    // `once`: after the player is in place, clicks belong to its controls. Without
    // this they keep bubbling to the box and rebuild the element on every press,
    // which makes pause and seek impossible.
    box.addEventListener(
      'click',
      () => {
        const video = document.createElement('video');
        video.src = detail.mediaUrl;
        video.controls = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        video.addEventListener('error', fallback);
        box.replaceChildren(video);
        box.style.cursor = 'default';
      },
      { once: true },
    );
  }

  return box;
}

/**
 * The per-item explanation.
 *
 * Every number here was produced by the single ranking pass that built this
 * generation and stored alongside it; opening this panel costs one Redis read for the
 * whole generation and no recommendation work at all.
 *
 * It shows the raw feature and the weighted contribution separately, because those
 * answer different questions: the feature says what the video *is*, the contribution
 * says how much that mattered given the weights in force.
 */
const TERMS = [
  ['affinity', 'affinity'],
  ['creatorAffinity', 'creatorAffinity'],
  ['popularity', 'popularity'],
  ['freshness', 'freshness'],
  ['fatigue', 'fatigue'],
  ['exploration', 'exploration'],
  ['quality', 'quality'],
];

function why(detail) {
  const box = node('details', 'why');
  box.append(node('summary', null, 'why this video?'));

  const scale = Math.max(
    0.05,
    ...Object.values(detail.weighted).map((value) => Math.abs(value)),
  );

  const terms = node('div', 'terms');
  for (const [featureKey, weightedKey] of TERMS) {
    const contribution = detail.weighted[weightedKey] ?? 0;
    const raw = detail.features[featureKey];

    const row = node('div', 'term');
    row.append(node('span', 'name', featureKey));
    row.append(node('span', 'raw', num(raw)));

    const bar = node('span', 'bar');
    const fill = document.createElement('i');
    const width = (Math.abs(contribution) / scale) * 50;
    if (contribution >= 0) {
      fill.style.left = '50%';
    } else {
      fill.className = 'neg';
      fill.style.left = `${50 - width}%`;
    }
    fill.style.width = `${width}%`;
    bar.append(fill);
    row.append(bar);

    row.append(
      node('span', `contrib ${contribution >= 0 ? 'pos' : 'neg'}`, num(contribution)),
    );
    terms.append(row);
  }
  box.append(terms);

  const total = node('div', 'term-total');
  total.append(
    node(
      'div',
      null,
      `affinity = (cosine ${num(detail.features.contentSimilarity)} + ` +
        `tag ${num(detail.features.tagAffinity)}) / 2`,
    ),
  );
  total.append(
    node(
      'div',
      null,
      `base ${num(detail.baseScore)} − diversity penalty ${num(detail.diversityPenalty)}` +
        ` = final ${num(detail.finalScore)}`,
    ),
  );
  if (!detail.features.qualityAvailable) {
    total.append(node('div', null, 'quality unavailable — contributes zero, not a guess'));
  }
  if (detail.admittedByRelaxation) {
    total.append(node('div', null, 'admitted only after the diversity caps were relaxed'));
  }
  box.append(total);

  return box;
}

const INTERACTIONS = [
  { type: 'view', watchRatio: 0.3 },
  { type: 'complete', watchRatio: 1 },
  { type: 'like', watchRatio: 0.85 },
  { type: 'skip', watchRatio: 0.08 },
  { type: 'dislike', watchRatio: 0.1 },
];

function actions(item) {
  const row = node('div', 'actions');
  for (const action of INTERACTIONS) {
    const button = node('button', 'btn', action.type);
    button.addEventListener('click', () => void interact(item.videoId, action, button));
    row.append(button);
  }
  return row;
}

/**
 * Records one interaction and then shows what it did to the feed.
 *
 * The two booleans in the response are reported separately on purpose: the cache can
 * be invalidated while the rebuild fails to queue, and a single flag would claim the
 * feed was untouched when it had already been dropped.
 */
async function interact(videoId, action, button) {
  const payload = {
    eventId: `demo-ui-${crypto.randomUUID()}`,
    userId: state.user.id,
    videoId,
    type: action.type,
    watchRatio: action.watchRatio,
  };

  for (const btn of document.querySelectorAll('.actions .btn')) btn.disabled = true;
  button.classList.add('active');

  try {
    const { status, body } = await call('/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (status !== 201 && status !== 200) {
      log(`interaction failed: ${status} ${body?.error ?? ''}`, 'err');
      return;
    }

    log(
      `${action.type} recorded=${body.recorded} invalidated=${body.feedInvalidated} ` +
        `queued=${body.rebuildQueued}`,
      'ok',
    );

    await loadProfile();

    if (body.feedInvalidated) {
      // The old generation is gone; the next GET is a deliberate miss. Restarting the
      // session is what a client does - it is also what makes the 202 visible.
      await restartSession(`${action.type} invalidated the feed`);
    } else {
      log('feed not invalidated (duplicate, or an event with no preference signal)');
    }
  } finally {
    for (const btn of document.querySelectorAll('.actions .btn')) btn.disabled = false;
  }
}

// ------------------------------------------------------------------------- wiring

el.loadMore.addEventListener('click', () => {
  if (state.cursor) void loadPage(state.cursor);
});
el.restart.addEventListener('click', () => void restartSession('manual restart'));

renderUsers();
void selectUser(USERS[0]);
