const state = { view: 'find', jobId: null, currentJob: null, pendingCount: 0, searchLocked: false, poll: null, pollInFlight: null, cancelling: false, jobVersion: 0, pages: { pending: 1, saved: 1, discarded: 1, history: 1 }, loading: {}, selected: new Set(), bulkLoading: false, modalReturn: null };
const $ = selector => document.querySelector(selector); const terminal = new Set(['completed', 'failed', 'cancelled']);
const active = status => ['queued', 'running'].includes(status);
const escape = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const plural = (n, word = 'lead') => `${n} ${word}${n === 1 ? '' : 's'}`;
async function api(url, options = {}) { const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options }); const data = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(data.error || 'Request failed'); error.code = data.code; throw error; } return data; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3200); }
const empty = (title, text) => `<div class="empty"><b>${escape(title)}</b><span>${escape(text)}</span></div>`; const loading = text => `<div class="empty loading-state"><span class="spinner"></span><b>${escape(text)}</b></div>`;
function stopPolling() { if (state.poll) clearInterval(state.poll); state.poll = null; }
function startPolling() { if (!state.jobId || !active(state.currentJob?.status) || state.poll) return; state.poll = setInterval(poll, 2500); void poll(); }
function lockForm(locked, message) { $('#discovery-fields').disabled = locked; $('#find-leads-button').disabled = locked; $('#discovery-form').classList.toggle('is-locked', locked); $('#form-lock-note').textContent = message; }
function updateLock(job = state.currentJob) { state.searchLocked = job?.status !== 'cancelled' && (Boolean(job && active(job.status)) || state.pendingCount > 0); if (job?.status === 'cancelled') lockForm(false, 'Ready for a new search.'); else if (job && active(job.status)) lockForm(true, 'Search in progress. Please wait for it to finish.'); else if (state.pendingCount) lockForm(true, 'Resolve all pending leads before starting a new search.'); else lockForm(false, 'Ready for a new search.'); }
function setProgress(job) { const requested = Number(job.requested) || 0; const found = Number(job.found) || 0; const pct = requested ? Math.min(100, Math.round(found / requested * 100)) : 0; ['requested','found','duplicates','rejected'].forEach(key => $(`#${key === 'duplicates' ? 'duplicate' : key === 'rejected' ? 'rejected' : key}-count`).textContent = Number(job[key]) || 0); $('#pending-metric-count').textContent = Number(job.pendingCount ?? state.pendingCount) || 0; $('#progress-percent').textContent = `${pct}%`; $('#progress-fill').style.width = `${pct}%`; $('.progress-track').setAttribute('aria-valuenow', pct); $('#progress-count').textContent = `${found} of ${requested} requested leads found`; const labels = { queued: ['Discovery in progress','Waiting to start…'], running: ['Discovery in progress','Searching for leads…'], cancelling: ['Discovery in progress','Cancelling…'], completed: ['Discovery complete','Search completed'], cancelled: ['Search cancelled','Search cancelled'], failed: ['Discovery failed','Search failed'] }; $('#progress-eyebrow').textContent = labels[job.status][0]; $('#progress-title').textContent = labels[job.status][1]; $('#progress-message').textContent = job.status === 'cancelling' ? 'Cancelling…' : job.status === 'cancelled' ? (state.pendingCount ? `Search cancelled. You still have ${state.pendingCount} leads waiting for review.` : 'Search cancelled.') : job.status === 'completed' ? `Found ${plural(found, 'usable pending lead')}.` : job.status === 'failed' ? (job.error || 'Discovery could not be completed.') : 'Searching public sources and checking businesses…'; $('#progress-spinner').hidden = terminal.has(job.status); $('#cancel-job').hidden = terminal.has(job.status); $('#cancel-job').disabled = state.cancelling; $('#cancel-job').textContent = state.cancelling ? 'Cancelling…' : 'Cancel search'; }
function updateToolbar() { $('#pending-toolbar').hidden = !state.pendingCount; $('#pending-count').textContent = `${plural(state.pendingCount)} waiting for review`; $('#selected-count').textContent = `${state.selected.size} selected`; const disabled = !state.selected.size || state.bulkLoading; $('#save-selected').disabled = disabled; $('#discard-selected').disabled = disabled; $('#clear-remaining').disabled = state.bulkLoading; const rows = [...document.querySelectorAll('[data-select-lead]')]; const all = $('#select-page'); if (all) { all.checked = rows.length > 0 && rows.every(item => state.selected.has(item.value)); all.indeterminate = rows.some(item => state.selected.has(item.value)) && !all.checked; } }
function leadRows(items, view) { const pending = view === 'pending'; return `<table class="lead-table"><thead><tr>${pending ? '<th><input id="select-page" type="checkbox" aria-label="Select all leads on this page"></th>' : ''}<th>Business</th><th>Website</th><th>Email</th><th>Phone</th><th>Actions</th></tr></thead><tbody>${items.map(lead => `<tr>${pending ? `<td class="selection" data-label="Select"><input data-select-lead type="checkbox" value="${lead._id}" aria-label="Select ${escape(lead.businessName)}" ${state.selected.has(lead._id) ? 'checked' : ''}></td>` : ''}<td class="business" data-label="Business">${escape(lead.businessName)}</td><td data-label="Website"><a class="link" rel="noopener noreferrer" target="_blank" href="${escape(lead.website)}">${escape(lead.domain)}</a></td><td data-label="Email"><a class="link" href="mailto:${escape(lead.email)}">${escape(lead.email)}</a></td><td data-label="Phone">${lead.phone ? escape(lead.phone) : '—'}</td><td data-label="Actions"><div class="actions">${pending ? `<button class="button secondary" data-status="saved" data-id="${lead._id}">Save</button><button class="button secondary danger" data-status="discarded" data-id="${lead._id}">Not useful</button>` : '<span class="count-chip neutral">Permanent</span>'}</div></td></tr>`).join('')}</tbody></table>`; }
function pager(data, view) { const p = data.pagination; return p.pages < 2 ? '' : `<div class="pagination"><button class="button secondary" data-page="${p.page - 1}" data-page-view="${view}" ${p.page === 1 ? 'disabled' : ''}>Previous</button><span>Page ${p.page} of ${p.pages}</span><button class="button secondary" data-page="${p.page + 1}" data-page-view="${view}" ${p.page === p.pages ? 'disabled' : ''}>Next</button></div>`; }
async function loadLeads(view = 'pending', options = {}) {
  const target = view === 'pending' ? '#new-results' : `#${view}-results`;
  const search = view === 'pending' ? '' : $(`#${view}-search`).value.trim();
  const version = state.jobVersion;
  const request = { version };
  if (view !== 'pending' && state.loading[view]) return;
  state.loading[view] = request;
  if (view !== 'pending') $(target).innerHTML = loading('Loading leads…');
  try {
    const data = await api(`/api/leads?status=${view}&page=${state.pages[view] || 1}&limit=25&search=${encodeURIComponent(search)}`);
    // A cancellation starts a new job version. Never let a prior lead request
    // restore its searching/loading UI after that transition.
    if (view === 'pending' && version !== state.jobVersion) return;
    if (view === 'pending') {
      state.pendingCount = data.pagination.total;
      $('#results-summary').textContent = state.pendingCount ? `${plural(state.pendingCount)} need your review.` : options.cancelled ? 'Search cancelled. No leads remain for review.' : 'No leads waiting for review.';
      updateLock();
    } else $('#${view}-count').textContent = plural(data.pagination.total);
    const titles = {
      pending: options.cancelled ? ['Search cancelled', 'No leads remain for review.'] : ['No pending leads', 'Run a discovery search to begin.'],
      saved: ['No saved leads yet', 'Saved businesses will appear here.'],
      discarded: ['No excluded leads', 'Businesses marked Not Useful appear here.']
    };
    $(target).innerHTML = data.items.length ? leadRows(data.items, view) + pager(data, view) : empty(...titles[view]);
    updateToolbar();
  } catch {
    if (view !== 'pending' || version === state.jobVersion) $(target).innerHTML = empty('Unable to load leads', 'Please try again in a moment.');
  } finally {
    if (state.loading[view] === request) state.loading[view] = false;
  }
}
async function loadHistory() { if (state.loading.history) return; state.loading.history = true; $('#history-results').innerHTML = loading('Loading search history…'); try { const data = await api(`/api/search-history?page=${state.pages.history}&limit=25`); $('#history-results').innerHTML = data.items.length ? `<table class="history-table"><thead><tr><th>Category</th><th>Location</th><th>Keywords</th><th>Requested</th><th>Found</th><th>Date</th></tr></thead><tbody>${data.items.map(x => `<tr><td data-label="Category" class="business">${escape(x.category)}</td><td data-label="Location">${escape(x.location)}</td><td data-label="Keywords">${escape(x.keywords || '—')}</td><td data-label="Requested">${x.requestedCount}</td><td data-label="Found">${x.foundCount}</td><td data-label="Date">${new Date(x.createdAt).toLocaleDateString()}</td></tr>`).join('')}</tbody></table>` + pager(data, 'history') : empty('No searches yet', 'Completed discovery requests will appear here.'); } finally { state.loading.history = false; } }
function setView(view) { if (!['find','saved','discarded','history'].includes(view)) view = 'find'; state.view = view; document.querySelectorAll('.view').forEach(x => { x.hidden = x.id !== `view-${view}`; }); document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === view)); if (view === 'find') loadLeads(); if (view === 'saved' || view === 'discarded') loadLeads(view); if (view === 'history') loadHistory(); }
async function restoreCurrent() {
  // A restore can follow an error/review action while an older request is
  // pending. Invalidate it before adopting the server's durable current job.
  stopPolling();
  state.jobVersion += 1;
  const current = await api('/api/discovery/current');
  if (current.jobId && active(current.status)) {
    state.jobId = current.jobId;
    state.currentJob = current;
    state.pendingCount = Number(current.pendingCount) || 0;
    state.cancelling = false;
    $('#job-progress').hidden = false;
    setProgress(current);
    updateLock(current);
    startPolling();
  } else {
    state.jobId = null;
    state.currentJob = null;
    state.cancelling = false;
    $('#job-progress').hidden = true;
    updateLock();
  }
  await loadLeads();
}
async function applyJob(job, jobId, version) {
  // Ignore responses started before a newer job transition (especially cancel).
  if (state.jobId !== jobId || state.jobVersion !== version) return false;
  state.currentJob = job;
  state.pendingCount = Number(job.pendingCount ?? state.pendingCount) || 0;
  if (job.status === 'cancelled') {
    stopPolling();
    state.cancelling = false;
    $('#job-progress').hidden = true;
    // A cancelled search never keeps the form locked, even if its remaining
    // leads can still be reviewed from this screen.
    lockForm(false, 'Ready for a new search.');
    await loadLeads('pending', { cancelled: true });
    toast(state.pendingCount ? `Search cancelled. ${plural(state.pendingCount)} remain.` : 'Search cancelled');
    return true;
  }
  $('#job-progress').hidden = false;
  setProgress(job);
  updateLock(job);
  if (!terminal.has(job.status)) return true;
  stopPolling();
  state.cancelling = false;
  await loadLeads();
  toast(job.status === 'failed' ? 'Search failed' : 'Search completed');
  return true;
}
async function fetchJobStatus(jobId, version = state.jobVersion) {
  const job = await api(`/api/discovery/jobs/${jobId}`);
  await applyJob(job, jobId, version);
  return job;
}
async function poll() {
  if (!state.jobId) return;
  const jobId = state.jobId;
  const version = state.jobVersion;
  if (state.pollInFlight?.jobId === jobId && state.pollInFlight.version === version) return;
  const request = { jobId, version };
  state.pollInFlight = request;
  try { await fetchJobStatus(jobId, version); }
  catch { if (state.jobId === jobId && state.jobVersion === version) { stopPolling(); toast('Unable to check discovery progress.'); } }
  finally { if (state.pollInFlight === request) state.pollInFlight = null; }
}
async function bulk(status, ids) { if (!ids.length || state.bulkLoading) return; state.bulkLoading = true; updateToolbar(); try { const data = await api('/api/leads/bulk-status', { method: 'PATCH', body: JSON.stringify({ ids, status }) }); ids.forEach(id => state.selected.delete(id)); state.pendingCount = data.pendingCount; await loadLeads(); updateLock(); toast(`✓ ${plural(data.modifiedCount)} updated`); } catch (error) { toast(error.message); } finally { state.bulkLoading = false; updateToolbar(); } }
function openClearModal() { if (!state.pendingCount || !state.jobId) return; state.modalReturn = document.activeElement; $('#clear-modal-title').textContent = `Clear ${plural(state.pendingCount)}?`; $('#clear-confirm').textContent = `Clear ${state.pendingCount} leads`; $('#clear-modal').hidden = false; $('#clear-confirm').focus(); }
function closeClearModal() { $('#clear-modal').hidden = true; state.modalReturn?.focus(); }
$('#discovery-form').addEventListener('submit', async event => { event.preventDefault(); if ($('#find-leads-button').disabled) return; const data = Object.fromEntries(new FormData(event.currentTarget)); try { const job = await api('/api/discovery/jobs', { method: 'POST', body: JSON.stringify(data) }); stopPolling(); state.jobVersion += 1; state.jobId = job.jobId; state.pendingCount = 0; state.currentJob = { ...job, requested: Number(data.requestedCount), found: 0, duplicates: 0, rejected: 0 }; $('#job-progress').hidden = false; setProgress(state.currentJob); updateLock(); startPolling(); toast('Search started'); } catch (error) { toast(error.message); await restoreCurrent(); } });
$('#cancel-job').addEventListener('click', async () => {
  if (!state.jobId || state.cancelling) return;
  const jobId = state.jobId;
  const previousJob = state.currentJob;
  state.cancelling = true;
  // Invalidate any running poll before requesting cancellation. Its older state
  // must never overwrite the cancellation-specific status refresh below.
  const version = ++state.jobVersion;
  // Clear the interval before the request so no new normal poll can start while
  // cancellation is awaiting its dedicated authoritative status refresh.
  stopPolling();
  state.currentJob = { ...state.currentJob, status: 'cancelling' };
  setProgress(state.currentJob);
  try {
    await api(`/api/discovery/jobs/${jobId}/cancel`, { method: 'POST' });
    // This does not share pollInFlight, so cancellation always reads final state.
    await fetchJobStatus(jobId, version);
  } catch (error) {
    state.cancelling = false;
    if (state.jobId === jobId && state.jobVersion === version) {
      state.currentJob = previousJob;
      setProgress(state.currentJob);
      startPolling();
    }
    toast(error.message);
  }
});
$('#save-selected').addEventListener('click', () => bulk('saved', [...state.selected])); $('#discard-selected').addEventListener('click', () => bulk('discarded', [...state.selected])); $('#clear-remaining').addEventListener('click', openClearModal); $('#clear-cancel').addEventListener('click', closeClearModal); $('#clear-confirm').addEventListener('click', async () => { const id = state.jobId; if (!id) return closeClearModal(); $('#clear-confirm').disabled = true; try { const result = await api(`/api/discovery/jobs/${id}/pending-leads`, { method: 'DELETE' }); state.pendingCount = Math.max(0, state.pendingCount - result.deletedCount); state.selected.clear(); closeClearModal(); await restoreCurrent(); toast(`✓ Cleared ${plural(result.deletedCount)}`); } catch (error) { toast(error.message); } finally { $('#clear-confirm').disabled = false; } });
document.addEventListener('change', event => { if (event.target.matches('[data-select-lead]')) { event.target.checked ? state.selected.add(event.target.value) : state.selected.delete(event.target.value); updateToolbar(); } if (event.target.id === 'select-page') { document.querySelectorAll('[data-select-lead]').forEach(x => { x.checked = event.target.checked; event.target.checked ? state.selected.add(x.value) : state.selected.delete(x.value); }); updateToolbar(); } });
document.addEventListener('submit', event => { const form = event.target.closest('[data-search-form]'); if (form) { event.preventDefault(); state.pages[form.dataset.searchForm] = 1; loadLeads(form.dataset.searchForm); } });
document.addEventListener('click', async event => { const nav = event.target.closest('[data-view]'); if (nav) { event.preventDefault(); location.hash = nav.dataset.view; return; } const action = event.target.closest('[data-status]'); if (action) return bulk(action.dataset.status, [action.dataset.id]); const page = event.target.closest('[data-page-view]'); if (page && !page.disabled) { state.pages[page.dataset.pageView] = Number(page.dataset.page); page.dataset.pageView === 'history' ? loadHistory() : loadLeads(page.dataset.pageView); } });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#clear-modal').hidden) closeClearModal(); }); $('#menu-toggle').addEventListener('click', event => { const nav = $('#mobile-nav'); nav.classList.toggle('open'); event.currentTarget.setAttribute('aria-expanded', String(nav.classList.contains('open'))); }); window.addEventListener('hashchange', () => setView(location.hash.slice(1) || 'find')); setView(location.hash.slice(1) || 'find'); restoreCurrent().catch(() => toast('Unable to restore discovery state.'));
